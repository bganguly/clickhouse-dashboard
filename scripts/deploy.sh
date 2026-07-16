#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"

STARTUP_ONLY=0
[[ "${1:-}" == "--startup" ]] && STARTUP_ONLY=1

if [[ "$STARTUP_ONLY" == "1" ]]; then
  cd /app
  pm2 start npm --name dashboard -- start 2>/dev/null || pm2 restart dashboard
  exit 0
fi

printf '\n=== clickhouse-dashboard deploy ===\n\n'

if [[ -z "${CLICKHOUSE_CLOUD_KEY:-}" ]]; then
  printf 'ERROR: CLICKHOUSE_CLOUD_KEY env var is required.\n'
  exit 1
fi

for dep in aws terraform ssh rsync; do
  command -v "$dep" >/dev/null 2>&1 || { printf 'ERROR: %s not found in PATH.\n' "$dep"; exit 1; }
done

printf '[1/4] Checking AWS credentials...\n'
aws sts get-caller-identity >/dev/null
printf '  OK\n'

printf '[2/4] Provisioning EC2 (terraform apply)...\n'
cd "$INFRA_DIR"
SSH_KEY=""
for candidate in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub" "$HOME/.ssh/id_ecdsa.pub"; do
  [[ -f "$(eval echo "$candidate")" ]] && { SSH_KEY="$(eval echo "$candidate")"; break; }
done
[[ -z "$SSH_KEY" ]] && { printf 'ERROR: no SSH public key found in ~/.ssh/\n'; exit 1; }
export TF_VAR_ssh_public_key_path="$SSH_KEY"
terraform init -input=false -upgrade >/dev/null
terraform apply -auto-approve -input=false
EC2_IP="$(terraform output -raw ec2_public_ip)"
CDN_URL="$(terraform output -raw cdn_url 2>/dev/null || true)"
printf '  EC2 ready: %s\n' "$EC2_IP"

printf '[3/4] Ensuring ClickHouse Cloud service is running...\n'

CH_ORG_ID="${CLICKHOUSE_ORG_ID:-}"
CH_SERVICE_NAME="${CLICKHOUSE_SERVICE_NAME:-clickhouse-dashboard}"
CH_REGION="${CLICKHOUSE_CLOUD_REGION:-aws-us-east-1}"
CH_TIER="${CLICKHOUSE_CLOUD_TIER:-development}"

_ch_api() {
  local method="$1" path="$2"
  shift 2
  curl -fsSL -X "$method" \
    -H "Authorization: Basic $(printf '%s' "$CLICKHOUSE_CLOUD_KEY" | base64)" \
    -H "Content-Type: application/json" \
    "https://api.clickhouse.cloud/v1${path}" "$@"
}

if [[ -z "$CH_ORG_ID" ]]; then
  CH_ORG_ID="$(_ch_api GET /organizations | python3 -c "import sys,json;orgs=json.load(sys.stdin).get('result',[]); print(orgs[0]['id'] if orgs else '')" 2>/dev/null || true)"
fi
[[ -z "$CH_ORG_ID" ]] && { printf 'ERROR: could not determine ClickHouse org ID. Set CLICKHOUSE_ORG_ID.\n'; exit 1; }

EXISTING_SERVICE="$(_ch_api GET "/organizations/${CH_ORG_ID}/services" | python3 -c "
import sys,json
data=json.load(sys.stdin)
for s in data.get('result',[]):
    if s.get('name')=='${CH_SERVICE_NAME}':
        print(json.dumps(s))
        break
" 2>/dev/null || true)"

if [[ -z "$EXISTING_SERVICE" ]]; then
  printf '  Creating new ClickHouse Cloud service (%s / %s)...\n' "$CH_TIER" "$CH_REGION"
  CREATED="$(_ch_api POST "/organizations/${CH_ORG_ID}/services" \
    -d "{\"name\":\"${CH_SERVICE_NAME}\",\"provider\":\"aws\",\"region\":\"${CH_REGION}\",\"tier\":\"${CH_TIER}\"}")"
  CH_HOST="$(printf '%s' "$CREATED" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['result']['endpoints'][0]['hostname'])" 2>/dev/null || true)"
  CH_PASS="$(printf '%s' "$CREATED" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['result']['password'])" 2>/dev/null || true)"
  CH_SERVICE_ID="$(printf '%s' "$CREATED" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['result']['id'])" 2>/dev/null || true)"
else
  CH_HOST="$(printf '%s' "$EXISTING_SERVICE" | python3 -c "import sys,json;d=json.load(sys.stdin);ep=d.get('endpoints',[]); print(ep[0]['hostname'] if ep else '')" 2>/dev/null || true)"
  CH_SERVICE_ID="$(printf '%s' "$EXISTING_SERVICE" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id',''))" 2>/dev/null || true)"
  CH_STATE="$(printf '%s' "$EXISTING_SERVICE" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('state',''))" 2>/dev/null || true)"
  CH_PASS="${CLICKHOUSE_PASSWORD:-}"

  if [[ "$CH_STATE" == "idle" || "$CH_STATE" == "stopped" ]]; then
    printf '  Resuming paused service %s...\n' "$CH_SERVICE_ID"
    _ch_api PATCH "/organizations/${CH_ORG_ID}/services/${CH_SERVICE_ID}/state" \
      -d '{"command":"start"}' >/dev/null
    printf '  Resume command sent (service starts in background).\n'
  else
    printf '  Service state: %s\n' "$CH_STATE"
  fi
fi

[[ -z "$CH_HOST" ]] && { printf 'ERROR: could not determine ClickHouse host.\n'; exit 1; }
[[ -z "$CH_PASS" ]] && { printf 'ERROR: CLICKHOUSE_PASSWORD is required for an existing service.\n'; exit 1; }

CLICKHOUSE_URL="https://${CH_HOST}:8443"
printf '  ClickHouse endpoint: %s\n' "$CLICKHOUSE_URL"

printf '[4/4] Deploying app to EC2...\n'

SSH_PRIVATE_KEY="${SSH_KEY%.pub}"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o ServerAliveInterval=30 -i ${SSH_PRIVATE_KEY}"

printf '  Waiting for SSH...\n'
for i in $(seq 1 36); do
  if ssh $SSH_OPTS "ec2-user@${EC2_IP}" true 2>/dev/null; then
    printf '  SSH ready.\n'
    break
  fi
  [[ $i -eq 36 ]] && { printf 'ERROR: SSH not available after 3 min.\n'; exit 1; }
  sleep 5
done

printf '  Syncing app files...\n'
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.env*' \
  --exclude='infra' \
  -e "ssh $SSH_OPTS" \
  "$ROOT_DIR/" "ec2-user@${EC2_IP}:/app/"

DEMO_SCALE="${NEXT_PUBLIC_DEMO_SCALE:-}"
QUICKORDER_URL="${NEXT_PUBLIC_QUICK_ORDER_URL:-http://localhost:3005}"

printf '  Running schema migrations and starting app on EC2...\n'
ssh $SSH_OPTS "ec2-user@${EC2_IP}" bash <<REMOTE
  set -e
  cd /app

  cat > /app/.env.clickhouse <<ENV
CLICKHOUSE_URL=${CLICKHOUSE_URL}
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=${CH_PASS}
ENV

  export CLICKHOUSE_URL='${CLICKHOUSE_URL}'
  export CLICKHOUSE_USER='default'
  export CLICKHOUSE_PASSWORD='${CH_PASS}'

  command -v nginx >/dev/null 2>&1 || sudo dnf install -y nginx

  npm ci --prefer-offline

  node -e "
    const { runMigrations } = require('./lib/schema.js');
    runMigrations().then(() => { console.log('Migrations done'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
  " 2>/dev/null || npx tsx -e "
    import { runMigrations } from './lib/schema.ts';
    runMigrations().then(() => { console.log('Migrations done'); process.exit(0); }).catch(e => { console.error(e.message); process.exit(1); });
  "

  export NEXT_PUBLIC_QUICK_ORDER_URL='${QUICKORDER_URL}'
  export NEXT_PUBLIC_DEMO_SCALE='${DEMO_SCALE}'
  npm run build

  cat > /etc/systemd/system/dashboard.env.placeholder <<ENV 2>/dev/null || true
ENV
  pm2 start npm --name dashboard -- start 2>/dev/null || pm2 restart dashboard

  sudo env PATH=\$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u ec2-user --hp /home/ec2-user 2>/dev/null || true
  pm2 save

  sudo tee /etc/nginx/conf.d/app.conf > /dev/null <<'NGINX'
server {
    listen 80 default_server;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3004;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
NGINX
  sudo rm -f /etc/nginx/conf.d/default.conf
  sudo nginx -t
  sudo systemctl enable nginx
  sudo systemctl restart nginx
REMOTE

BASE_URL="${CDN_URL:-http://${EC2_IP}}"
printf '\n  Dashboard live at:  %s\n' "$BASE_URL"
printf '  API Explorer:       %s/api-explorer\n' "$BASE_URL"
printf '  SSH:                ssh -i %s ec2-user@%s\n' "$SSH_PRIVATE_KEY" "$EC2_IP"
printf '  Tear down:          ./scripts/infra-down.sh\n\n'
