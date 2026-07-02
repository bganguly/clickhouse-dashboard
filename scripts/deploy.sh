#!/usr/bin/env bash
set -euo pipefail

# Single entry point: provision EC2 + RDS via infra-up.sh, apply migrations,
# deploy the app to EC2, and print the live URL.
# If AWS is unavailable or infra fails, prompts to continue on local instead.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── flags ─────────────────────────────────────────────────────────────────────
QUICKORDER=false
for arg in "$@"; do
  case "$arg" in --quickorder|-q) QUICKORDER=true ;; esac
done
[[ "$QUICKORDER" == "true" ]] && export NEXT_PUBLIC_ENABLE_QUICKORDER=1

"$ROOT_DIR/scripts/bootstrap-deps.sh" psql

# ── helpers ───────────────────────────────────────────────────────────────────
apply_migrations() {
  echo ""
  echo "  Applying Prisma schema..."
  npx prisma db push
  echo "  Applying SQL migration files..."
  while IFS= read -r migration; do
    printf '    %s\n' "${migration#"$ROOT_DIR"/}"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
  done < <(find "$ROOT_DIR/prisma/migrations" -maxdepth 2 -name migration.sql -print | sort)
  echo "  Migrations applied."
}

run_local() {
  echo ""
  echo "[3/3] Running locally (pointed at RDS)..."
  apply_migrations
  echo ""
  echo "      Building and starting on http://localhost:3004 ..."
  npm run build
  npm start
}

prompt_local_fallback() {
  local reason="$1"
  echo ""
  echo "  $reason"
  printf "  Continue on local? [Y/n] "
  read -r yn
  [[ -z "$yn" || "$yn" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
}

# ── 1. Check AWS credentials ──────────────────────────────────────────────────
echo ""
echo "[1/3] Checking AWS credentials..."
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  prompt_local_fallback "AWS credentials not found or invalid."
  if ! DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh" 2>/dev/null)"; then
    echo "  No DATABASE_URL found. Run ./scripts/infra-up.sh first or set DATABASE_URL."
    exit 1
  fi
  export DATABASE_URL
  run_local
  exit 0
fi
echo "  Credentials valid."

# ── 2. Provision EC2 + RDS ───────────────────────────────────────────────────
echo ""
echo "[2/3] Provisioning infra (EC2 + RDS)..."
if ! "$ROOT_DIR/scripts/infra-up.sh"; then
  prompt_local_fallback "Infra provisioning failed."
  DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"
  export DATABASE_URL
  run_local
  exit 0
fi

DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"
export DATABASE_URL

EC2_IP=$(cd "$ROOT_DIR/infra" && terraform output -raw ec2_public_ip 2>/dev/null || true)
if [[ -z "$EC2_IP" ]]; then
  prompt_local_fallback "EC2 public IP not found in Terraform outputs."
  run_local
  exit 0
fi

# Detect SSH private key matching the public key passed to Terraform.
SSH_KEY=""
for candidate in "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa"; do
  [[ -f "$candidate" ]] && { SSH_KEY="$candidate"; break; }
done
if [[ -z "$SSH_KEY" ]]; then
  prompt_local_fallback "No SSH private key found at ~/.ssh/id_ed25519 or ~/.ssh/id_rsa."
  run_local
  exit 0
fi

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=5 -i $SSH_KEY"

# ── 3. Apply migrations (local → RDS), then deploy to EC2 ────────────────────
echo ""
echo "[3/3] Deploying to EC2 at ${EC2_IP}..."

echo "  Applying migrations to RDS..."
apply_migrations

echo "  Waiting for EC2 SSH to become available..."
for i in $(seq 1 36); do
  if ssh $SSH_OPTS "ec2-user@${EC2_IP}" true 2>/dev/null; then
    echo "  SSH ready."
    break
  fi
  [[ $i -eq 36 ]] && { echo "  SSH did not become available after 3 min. Check EC2 status."; exit 1; }
  sleep 5
done

echo "  Syncing app files..."
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.env*' \
  --exclude='infra' \
  -e "ssh $SSH_OPTS" \
  "$ROOT_DIR/" "ec2-user@${EC2_IP}:/app/"

echo "  Starting dashboard on EC2..."
QUICKORDER_ENV=""
[[ "$QUICKORDER" == "true" ]] && QUICKORDER_ENV="export NEXT_PUBLIC_ENABLE_QUICKORDER=1"

ssh $SSH_OPTS "ec2-user@${EC2_IP}" bash <<REMOTE
  set -e
  export DATABASE_URL='${DATABASE_URL}'
  ${QUICKORDER_ENV}
  cd /app
  npm ci --prefer-offline
  npm run build
  pm2 stop dashboard 2>/dev/null || true
  pm2 start "npm start" --name dashboard
  pm2 save
REMOTE

echo ""
echo "✓ Dashboard live at  http://${EC2_IP}:3004"
echo "  SSH:               ssh -i ${SSH_KEY} ec2-user@${EC2_IP}"
echo "  Tear down:         ./scripts/infra-down.sh"
