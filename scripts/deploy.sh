#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"

STARTUP_ONLY=0
[[ "${1:-}" == "--startup" ]] && STARTUP_ONLY=1

if [[ "$STARTUP_ONLY" == "1" ]]; then
  cd /app
  pm2 delete dashboard 2>/dev/null || true
  pm2 start npm --name dashboard -- start
  exit 0
fi

printf '\n=== clickhouse-dashboard deploy ===\n\n'

CREDS_FILE="$ROOT_DIR/.clickhouse-creds"

_prompt_creds() {
  printf 'Do you have an existing ClickHouse Cloud service? [Y/n]: '
  read -r HAS_SVC
  HAS_SVC="${HAS_SVC:-Y}"
  if [[ "$HAS_SVC" =~ ^[Yy] ]]; then
    USE_CH_API=0
    printf 'ClickHouse hostname (e.g. abc123.us-east-1.aws.clickhouse.cloud): '
    read -r CH_HOSTNAME
    printf 'ClickHouse password: '
    read -rs CLICKHOUSE_PASSWORD
    printf '\n'
    export CLICKHOUSE_URL="https://${CH_HOSTNAME}:8443"
    export CLICKHOUSE_USER="${CLICKHOUSE_USER:-default}"
    export CLICKHOUSE_PASSWORD
  else
    USE_CH_API=1
    printf 'ClickHouse Cloud API key (key-id:key-secret): '
    read -rs CLICKHOUSE_CLOUD_KEY
    printf '\n'
    export CLICKHOUSE_CLOUD_KEY
  fi
  printf 'Save credentials for future deploys? [Y/n]: '
  read -r SAVE_CREDS
  SAVE_CREDS="${SAVE_CREDS:-Y}"
  if [[ "$SAVE_CREDS" =~ ^[Yy] ]]; then
    if [[ "$USE_CH_API" == "1" ]]; then
      printf 'CLICKHOUSE_CLOUD_KEY=%s\n' "$CLICKHOUSE_CLOUD_KEY" > "$CREDS_FILE"
    else
      printf 'CLICKHOUSE_URL=%s\nCLICKHOUSE_USER=%s\nCLICKHOUSE_PASSWORD=%s\n' \
        "$CLICKHOUSE_URL" "${CLICKHOUSE_USER:-default}" "$CLICKHOUSE_PASSWORD" > "$CREDS_FILE"
    fi
    chmod 600 "$CREDS_FILE"
    printf '  Saved to .clickhouse-creds\n\n'
  fi
}

_poll_materialize_idx() {
  local t0 elapsed total left done_parts pct eta row is_done
  t0=$(date +%s)
  total=0
  for _w in $(seq 1 12); do
    sleep 5
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do FROM system.mutations WHERE table='orders' AND command LIKE '%MATERIALIZE INDEX%idx_search_fulltext%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    [[ -n "$row" ]] && break
    printf '\r  waiting for mutation to register (%ds)...     ' $(( _w * 5 ))
  done
  printf '\n'
  while true; do
    row="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do FROM system.mutations WHERE table='orders' AND command LIKE '%MATERIALIZE INDEX%idx_search_fulltext%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    is_done="$(printf '%s' "$row" | cut -f1)"
    left="$(printf '%s' "$row" | cut -f2)"
    if [[ "$is_done" == "1" ]]; then
      printf '\r  done — index fully materialized.                              \n'
      return 0
    fi
    [[ $total -eq 0 && "${left:-0}" -gt 0 ]] && total=$left
    elapsed=$(( $(date +%s) - t0 ))
    pct=0; eta='?'
    if [[ $total -gt 0 && -n "$left" ]]; then
      done_parts=$(( total - left ))
      pct=$(( done_parts * 100 / total ))
      if [[ $done_parts -gt 0 && $elapsed -gt 0 ]]; then
        local rate=$(( done_parts / elapsed ))
        [[ $rate -gt 0 ]] && eta="$(( left / rate ))s"
      fi
    fi
    printf '\r  parts remaining: %s / %s (%d%%)  elapsed: %ds  ETA: %s     ' \
      "${left:-?}" "${total:-?}" "$pct" "$elapsed" "$eta"
    sleep 10
  done
}

_poll_count() {
  local table=$1 target=$2 pid=$3
  local t0 elapsed cur pct eta
  t0=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    cur=$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT count() FROM ${table}" 2>/dev/null || echo 0)
    elapsed=$(( $(date +%s) - t0 ))
    pct=0; eta='?'
    [[ ${cur:-0} -gt 0 && $target -gt 0 ]] && pct=$(( cur * 100 / target ))
    if [[ ${cur:-0} -gt 0 && $elapsed -gt 0 ]]; then
      local rate=$(( cur / elapsed ))
      local remaining=$(( target - cur ))
      [[ $rate -gt 0 ]] && eta="$(( remaining / rate ))s"
    fi
    printf '\r  %s: %s / %s (%s%%)  ETA: %s     ' \
      "$table" "${cur:-0}" "$target" "$pct" "$eta"
  done
  printf '\n'
}

_poll_seed() {
  local target=$1 pid=$2
  local t0 elapsed raw
  t0=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    raw=$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
      --data-binary "
SELECT 'regions',count() FROM regions
UNION ALL SELECT 'categories',count() FROM categories
UNION ALL SELECT 'products',count() FROM products
UNION ALL SELECT 'customers',count() FROM customers
UNION ALL SELECT 'orders',count() FROM orders
UNION ALL SELECT 'order_items',count() FROM order_items
UNION ALL SELECT 'order_category_facts',count() FROM order_category_facts
" 2>/dev/null || echo "")
    elapsed=$(( $(date +%s) - t0 ))
    printf '%s' "$(awk -F'\t' -v target="$target" -v elapsed="$elapsed" '
      BEGIN {
        n = split("regions categories products customers orders order_items order_category_facts", tbls)
        xp["regions"]=50; xp["categories"]=200; xp["products"]=5000; xp["customers"]=200000
        xp["orders"]=target; xp["order_items"]=target; xp["order_category_facts"]=target
      }
      { cnt[$1] = $2+0 }
      END {
        done=0; active=""; ac=0; ae=0
        for (i=1; i<=n; i++) {
          t=tbls[i]; c=cnt[t]+0; e=xp[t]+0
          if (c>=e && e>0) done++
          else if (c>0 && active=="") { active=t; ac=c; ae=e }
        }
        ord=cnt["orders"]+0
        pct = (target>0 && ord>0) ? int(ord*100/target) : 0
        eta = "?"
        if (ord>0 && elapsed>0) { r=ord/elapsed; rem=target-ord; if (r>0) eta=int(rem/r) "s" }
        sm = (active!="" && active!="orders" && active!="order_items" && active!="order_category_facts") \
             ? sprintf("  inserting: %s (%d/%d)", active, ac, ae) : ""
        printf "\r  [%d/7 done, %d remain]%s  |  orders: %d/%d (%d%%)  ETA: %s     ",
          done, 7-done, sm, ord, target, pct, eta
      }
    ' <<< "$raw")"
  done
  printf '\n'
}

USE_CH_API=0

if [[ -n "${CLICKHOUSE_CLOUD_KEY:-}" ]]; then
  USE_CH_API=1
  printf 'Using CLICKHOUSE_CLOUD_KEY from environment.\n\n'
elif [[ -n "${CLICKHOUSE_URL:-}" && -n "${CLICKHOUSE_PASSWORD:-}" ]]; then
  USE_CH_API=0
  printf 'Using CLICKHOUSE_URL from environment: %s\n\n' "$CLICKHOUSE_URL"
elif [[ -f "$CREDS_FILE" ]]; then
  source "$CREDS_FILE"
  if [[ -n "${CLICKHOUSE_CLOUD_KEY:-}" ]]; then
    USE_CH_API=1
    printf 'Loaded API key from .clickhouse-creds. Use it? [Y/n]: '
  else
    USE_CH_API=0
    printf 'Loaded saved endpoint: %s. Use it? [Y/n]: ' "${CLICKHOUSE_URL:-}"
  fi
  read -r USE_SAVED
  USE_SAVED="${USE_SAVED:-Y}"
  if [[ ! "$USE_SAVED" =~ ^[Yy] ]]; then
    unset CLICKHOUSE_CLOUD_KEY CLICKHOUSE_URL CLICKHOUSE_PASSWORD
    _prompt_creds
  else
    printf '\n'
  fi
else
  _prompt_creds
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

if [[ "$USE_CH_API" == "1" ]]; then
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
else
  printf '[3/4] Using provided CLICKHOUSE_URL (skipping CH Cloud API).\n'
  CH_PASS="${CLICKHOUSE_PASSWORD}"
  printf '  ClickHouse endpoint: %s\n' "$CLICKHOUSE_URL"
fi

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
  pm2 delete dashboard 2>/dev/null || true
  pm2 start npm --name dashboard -- start

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

_AWS_KEY="$(aws configure get aws_access_key_id 2>/dev/null || echo "${AWS_ACCESS_KEY_ID:-}")"
_AWS_SECRET="$(aws configure get aws_secret_access_key 2>/dev/null || echo "${AWS_SECRET_ACCESS_KEY:-}")"
_CH_DUMP_BUCKET="bikram-nextjs-subsecond-fetch-with-websockets"
_CH_DUMP_S3_KEY="clickhouse-dash/orders.parquet"
_CH_DUMP_S3_PREFIX="https://s3.us-east-1.amazonaws.com/${_CH_DUMP_BUCKET}/clickhouse-dash"

printf '\n[bake] Checking S3 Parquet dump...\n'
if aws s3 ls "s3://${_CH_DUMP_BUCKET}/${_CH_DUMP_S3_KEY}" >/dev/null 2>&1; then
  printf '  Dump exists — skipping bake.\n'
else
  printf '  No dump found — baking 50M rows to S3 (runs entirely in ClickHouse Cloud)...\n'
  CLICKHOUSE_URL="${CLICKHOUSE_URL}" \
  CLICKHOUSE_USER=default \
  CLICKHOUSE_PASSWORD="${CH_PASS}" \
  AWS_ACCESS_KEY_ID="${_AWS_KEY}" \
  AWS_SECRET_ACCESS_KEY="${_AWS_SECRET}" \
    bash "$ROOT_DIR/scripts/bake-ch-dump.sh" &
  _BAKE_PID=$!
  _poll_seed 50000000 "$_BAKE_PID"
  wait "$_BAKE_PID"
fi

printf '\n[seed] Checking demo data...\n'
_SEED_COUNT="$(ssh $SSH_OPTS "ec2-user@${EC2_IP}" \
  "curl -sf -u 'default:${CH_PASS}' '${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30' \
   --data-binary 'SELECT count() FROM orders' 2>/dev/null || echo 0" 2>/dev/null || echo 0)"
if [[ "${_SEED_COUNT:-0}" -gt 0 ]]; then
  printf '  orders has %s rows — skipping seed.\n' "$_SEED_COUNT"
else
  printf '  orders table is empty — restoring from S3 dump on EC2...\n'
  ssh $SSH_OPTS "ec2-user@${EC2_IP}" \
    "CLICKHOUSE_URL='${CLICKHOUSE_URL}' \
     CLICKHOUSE_USER=default \
     CLICKHOUSE_PASSWORD='${CH_PASS}' \
     CH_DUMP_S3_PREFIX='${_CH_DUMP_S3_PREFIX}' \
     AWS_ACCESS_KEY_ID='${_AWS_KEY}' \
     AWS_SECRET_ACCESS_KEY='${_AWS_SECRET}' \
     bash /app/scripts/seed.sh" &
  _SEED_PID=$!
  _poll_seed 50000000 "$_SEED_PID"
  wait "$_SEED_PID"
fi

printf '\n[search-backfill] Checking searchText format (pruned+prefix vs legacy email)...\n'
_SEARCH_FIX_NEEDED="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
  --data-binary "SELECT if(positionCaseInsensitive(searchText, '@') > 0, 1, 0) FROM orders LIMIT 1" \
  2>/dev/null || echo 0)"
if [[ "${_SEARCH_FIX_NEEDED:-0}" -eq 0 ]]; then
  printf '  searchText already in pruned+prefix format — skipping.\n'
else
  printf '  Legacy email format detected — submitting UPDATE to pruned+prefix+tokens format...\n'
  curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?max_execution_time=10" \
    --data-binary "ALTER TABLE orders UPDATE searchText = concat(customerFirstName, ' ', customerLastName, ' ', toString(orderId), if(coalesce(notes, '') = '', '', concat(' ', coalesce(notes, ''))), if(length(customerFirstName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerFirstName), arrayMap(i -> lower(substring(customerFirstName, 1, i)), range(1, length(customerFirstName) + 1))), ' ')), ''), if(length(customerLastName) > 3, concat(' ', arrayStringConcat(arrayFilter(x -> length(x) >= 3 AND length(x) < length(customerLastName), arrayMap(i -> lower(substring(customerLastName, 1, i)), range(1, length(customerLastName) + 1))), ' ')), '')) WHERE positionCaseInsensitive(searchText, '@') > 0" \
    2>/dev/null || true
  printf '  Mutation submitted — polling progress every 15s (up to 20 checks / 5 min)...\n'

  _MUT_DONE=0
  for _i in $(seq 1 20); do
    _MUT_ROW="$(curl -sf -u "default:${CH_PASS}" \
      "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
      --data-binary "SELECT is_done, parts_to_do FROM system.mutations WHERE table='orders' AND command LIKE '%searchText%' ORDER BY create_time DESC LIMIT 1" \
      2>/dev/null || echo '')"
    _IS_DONE="$(printf '%s' "${_MUT_ROW}" | cut -f1)"
    _PARTS_LEFT="$(printf '%s' "${_MUT_ROW}" | cut -f2)"
    if [[ "${_IS_DONE}" == "1" ]]; then
      printf '  [%2d/20] Done — all parts updated.\n' "${_i}"
      _MUT_DONE=1
      break
    elif [[ -n "${_PARTS_LEFT}" ]]; then
      printf '  [%2d/20] parts_to_do: %s\n' "${_i}" "${_PARTS_LEFT}"
    else
      printf '  [%2d/20] Mutation not yet visible — still queuing...\n' "${_i}"
    fi
    sleep 15
  done
  if [[ "${_MUT_DONE}" -ne 1 ]]; then
    printf '  Mutation still running after 5 min — deploy continues, index queued behind it.\n'
  fi
fi

printf '\n[search-index] Materializing text index on orders.searchText...\n'
_IDX_DONE="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=10" \
  --data-binary "SELECT is_done FROM system.mutations WHERE table='orders' AND command LIKE '%MATERIALIZE INDEX%idx_search_fulltext%' ORDER BY create_time DESC LIMIT 1" \
  2>/dev/null || echo '')"
if [[ "${_IDX_DONE}" == "1" ]]; then
  printf '  Already done — skipping.\n'
else
  printf '  Submitting mutation...\n'
  curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?max_execution_time=30" \
    --data-binary "ALTER TABLE orders MATERIALIZE INDEX idx_search_fulltext" \
    2>/dev/null || true
  _poll_materialize_idx
fi

printf '\n[facts] Checking order_category_facts...\n'
_FACTS_COUNT="$(curl -sf -u "default:${CH_PASS}" \
  "${CLICKHOUSE_URL}/?default_format=TabSeparated&max_execution_time=30" \
  --data-binary 'SELECT count() FROM order_category_facts' 2>/dev/null || echo 0)"
if [[ "${_FACTS_COUNT:-0}" -gt 0 ]]; then
  printf '  order_category_facts has %s rows — skipping backfill.\n' "$_FACTS_COUNT"
else
  printf '  order_category_facts empty — backfilling from orders JOIN order_items...\n'
  curl -sf -u "default:${CH_PASS}" \
    "${CLICKHOUSE_URL}/?max_execution_time=7200" --max-time 7260 \
    --data-binary "
INSERT INTO order_category_facts
  (orderId, date, placedAt, customerId, regionId, regionCode,
   status, orderTotal, categoryId, categoryName, totalItems, totalRevenue)
SELECT
  o.orderId,
  toDate(o.placedAt),
  o.placedAt,
  o.customerId,
  o.regionId,
  o.regionCode,
  o.status,
  o.total,
  i.categoryId,
  i.categoryName,
  i.quantity,
  toDecimal64(toFloat64(i.quantity) * toFloat64(i.unitPrice), 2)
FROM orders AS o
INNER JOIN order_items AS i ON i.orderId = o.orderId
" &
  _FACTS_PID=$!
  _poll_count order_category_facts 50000000 "$_FACTS_PID"
  wait "$_FACTS_PID"
fi

BASE_URL="${CDN_URL:-http://${EC2_IP}}"
printf '\n  Dashboard live at:  %s\n' "$BASE_URL"
printf '  API Explorer:       %s/api-explorer\n' "$BASE_URL"
printf '  SSH:                ssh -i %s ec2-user@%s\n' "$SSH_PRIVATE_KEY" "$EC2_IP"
printf '  Tear down:          ./scripts/infra-down.sh\n\n'

PORTFOLIO_SCRIPT="$ROOT_DIR/../../portfolio/scripts/set-live-url.sh"
if [[ -x "$PORTFOLIO_SCRIPT" ]]; then
  printf 'Updating portfolio live URL...\n'
  bash "$PORTFOLIO_SCRIPT" clickhouse "$BASE_URL"
else
  printf 'Portfolio script not found at %s — skipping.\n' "$PORTFOLIO_SCRIPT"
fi
