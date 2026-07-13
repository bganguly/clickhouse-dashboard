#!/usr/bin/env bash
set -euo pipefail

# Single entry point: provision EC2 + RDS via infra-up.sh, apply migrations,
# deploy the app to EC2, and print the live URL.
# If AWS is unavailable or infra fails, prompts to continue on local instead.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

_tf_ws_count() {
  local state_file="$ROOT_DIR/infra/terraform.tfstate.d/$1/terraform.tfstate"
  [[ -f "$state_file" ]] || { printf '0'; return; }
  python3 -c "import json; d=json.load(open('$state_file')); print(sum(len(r.get('instances',[])) for r in d.get('resources',[])))" 2>/dev/null || printf '0'
}
_local_running=0
lsof -ti:3004 >/dev/null 2>&1 && _local_running=1 || true
_lite_count=$(_tf_ws_count lite)
_full_count=$(_tf_ws_count full)

printf '\n=== nextjs-dashboard ===\n\n'
printf '  [1] Local  — Next.js on localhost + local Postgres (no AWS cost)'
(( _local_running )) && printf ' [running]' || printf ' [not detected]'
printf '\n'
printf '  [2] Lite   — AWS: EC2 t3.small + RDS db.t3.micro'
(( _lite_count > 0 )) && printf ' [%s resources active]' "$_lite_count" || printf ' [not deployed]'
printf '\n'
printf '  [3] Full   — AWS: EC2 t3.medium + RDS db.t3.large'
(( _full_count > 0 )) && printf ' [%s resources active]' "$_full_count" || printf ' [not deployed]'
printf '\n'
printf '\nChoice [1/2/3]: '
read -r _MODE
case "$_MODE" in
  2) _TARGET="remote"; DEPLOY_MODE="lite" ;;
  3) _TARGET="remote"; DEPLOY_MODE="full" ;;
  *) _TARGET="local";  DEPLOY_MODE=""    ;;
esac

if [[ "$_TARGET" == "local" ]]; then
  QUICKORDER_DEPLOY="$(cd "$ROOT_DIR/../websockets-quickorder/scripts" 2>/dev/null && pwd || true)/deploy.sh"
  if [[ -f "$QUICKORDER_DEPLOY" ]]; then
    printf '\nAlso start Quick Order dev server on :3005? [Y/n] '
    read -r _qo_yn
    if [[ -z "$_qo_yn" || "$_qo_yn" =~ ^[Yy]$ ]]; then
      DEPLOY_MODE="local" BACKEND_URL="http://localhost:3004" bash "$QUICKORDER_DEPLOY" \
        >"$ROOT_DIR/.quickorder-dev.log" 2>&1 &
      printf 'Quick Order starting in background (log: .quickorder-dev.log)\n'
    fi
  fi
  exec "$ROOT_DIR/scripts/local-dev.sh"
fi

if [[ "$DEPLOY_MODE" == "lite" ]]; then
  printf '\n--- Lite AWS summary ---\n'
  printf '  EC2:        t3.small (2 vCPU, 2 GB)\n'
  printf '  RDS:        db.t3.micro (2 vCPU, 1 GB), 20 GB\n'
  printf '  Cost est:   ~$30-50/mo if left running\n'
  export DEPLOY_WORKSPACE="lite"
  export TF_VAR_name_prefix="dash-lite"
  export TF_VAR_ec2_instance_type="t3.small"
  export TF_VAR_instance_class="db.t3.micro"
  export TF_VAR_allocated_storage="20"
else
  printf '\n--- Full AWS summary ---\n'
  printf '  EC2:        t3.medium (2 vCPU, 4 GB)\n'
  printf '  RDS:        db.t3.large (2 vCPU, 8 GB), 50 GB\n'
  printf '  Cost est:   ~$100-130/mo if left running (~$4/day) — TEAR DOWN when done\n'
  export DEPLOY_WORKSPACE="full"
  export TF_VAR_name_prefix="dash-full"
  export TF_VAR_ec2_instance_type="t3.medium"
  export TF_VAR_instance_class="db.t3.large"
  export TF_VAR_allocated_storage="50"
fi
printf '\nProceed? [Y/n] '
read -r _CONFIRM
[[ -z "$_CONFIRM" || "$_CONFIRM" =~ ^[Yy]$ ]] || { printf 'Aborted.\n'; exit 0; }

"$ROOT_DIR/scripts/bootstrap-deps.sh" psql

# ── helpers ───────────────────────────────────────────────────────────────────
# prisma migrate deploy tracks applied migrations in _prisma_migrations and
# only runs pending ones — replaces the old db push + manual psql -f loop
# (which re-ran all migration files, including a real backfill INSERT, on
# every deploy, directly against RDS). RDS's first run under this scheme has
# the schema already applied via the old db push + raw-SQL loop but no
# migration history — self-heal by baselining: mark every existing migration
# folder as already applied, then retry. A genuinely fresh database never
# hits P3005 and just runs `migrate deploy` normally.
apply_migrations() {
  if ! psql "$DATABASE_URL" -Atqc \
      "SELECT 1 FROM pg_available_extensions WHERE name='pg_bigm'" \
      2>/dev/null | grep -q 1; then
    printf '  pg_bigm not found — building from source...\n'
    _pg_cfg=$(brew --prefix postgresql@16)/bin/pg_config
    _tmp=$(mktemp -d)
    git clone --depth 1 https://github.com/pgbigm/pg_bigm.git "$_tmp/pg_bigm"
    make -C "$_tmp/pg_bigm" USE_PGXS=1 PG_CONFIG="$_pg_cfg"
    make -C "$_tmp/pg_bigm" USE_PGXS=1 PG_CONFIG="$_pg_cfg" install
    rm -rf "$_tmp"
    printf '  pg_bigm installed — restarting postgresql@16...\n'
    brew services restart postgresql@16
    for _i in $(seq 1 10); do pg_isready -q 2>/dev/null && break; sleep 1; done
  fi
  echo ""
  echo "  Applying migrations (prisma migrate deploy)..."
  local log_file
  log_file="$(mktemp)"
  trap 'rm -f "$log_file"' RETURN

  if DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy 2>&1 | tee "$log_file"; then
    :
  elif grep -q 'P3005' "$log_file"; then
    echo "  Existing schema has no migration history — baselining (marking all migrations as already applied)..."
    while IFS= read -r dir; do
      DATABASE_URL="$DATABASE_URL" npx prisma migrate resolve --applied "$(basename "$dir")"
    done < <(find "$ROOT_DIR/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | sort)
    echo "  Baseline complete — re-running migrate deploy..."
    DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy
  else
    exit 1
  fi
  DATABASE_URL="$DATABASE_URL" npx prisma generate
  echo "  Migrations applied."
}

run_local() {
  echo ""
  echo "[3/3] AWS deploy did NOT happen — falling back to running THIS machine"
  echo "      locally instead (pointed at RDS). This is not the AWS URL."
  apply_migrations
  echo ""
  echo "      Starting the aggregates worker..."
  "$ROOT_DIR/scripts/start-aggregates-worker.sh"
  echo ""
  echo "      Building and starting locally on http://localhost:3004 ..."
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
if ! INFRA_UP_CALLER=deploy "$ROOT_DIR/scripts/infra-up.sh"; then
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
  # Fall back to the private key matching whichever .pub was used
  SSH_KEY=$(ls "$HOME/.ssh/"*.pub 2>/dev/null | head -1 | sed 's/\.pub$//' || true)
fi
if [[ -z "$SSH_KEY" || ! -f "$SSH_KEY" ]]; then
  prompt_local_fallback "No SSH private key found in ~/.ssh/."
  run_local
  exit 0
fi

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o ServerAliveInterval=30 -o ServerAliveCountMax=20 -i $SSH_KEY"

# Load the key into ssh-agent once so passphrase is only entered once (if at all).
if ! ssh-add -l 2>/dev/null | grep -qF "$SSH_KEY"; then
  ssh-add "$SSH_KEY" || { echo "  ssh-add failed. Ensure ssh-agent is running or the key is unencrypted."; exit 1; }
fi

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

# ── Ensure the root filesystem actually uses the full disk ──────────────────
# A Terraform-only root_block_device resize (e.g. bumping ec2_root_volume_size)
# enlarges the EBS volume but NOT the partition/filesystem sitting on it — EC2
# doesn't grow those automatically. Happened once: the volume correctly went
# 2GB -> 20GB, but the XFS filesystem stayed at 2GB/100% full, so every rsync
# after kept failing with "No space left on device" despite the "bigger disk"
# fix already being live. growpart + xfs_growfs/resize2fs are safe no-ops once
# the filesystem already matches the disk, so this always runs, not just on
# first boot after a resize.
echo "  Ensuring root filesystem uses the full disk..."
ssh $SSH_OPTS "ec2-user@${EC2_IP}" '
  ROOT_SRC="$(findmnt -n -o SOURCE /)"
  DISK="/dev/$(lsblk -no PKNAME "$ROOT_SRC")"
  PART_NUM="$(echo "$ROOT_SRC" | grep -oE "[0-9]+$")"
  sudo growpart "$DISK" "$PART_NUM" 2>&1 | grep -v NOCHANGE || true
  if [ "$(findmnt -n -o FSTYPE /)" = xfs ]; then
    sudo xfs_growfs / >/dev/null
  else
    sudo resize2fs "$ROOT_SRC" >/dev/null
  fi
'

# ── Automatic schema drift check — no flag, always runs ─────────────────────
# Catches the class of bug where migrate deploy's baseline self-heal (the
# P3005 path in apply_migrations) wrongly assumes a migration's raw SQL had
# already run against this database — happened once: RDS's baseline-resolve
# marked order_events + orders.search_text as applied when neither ever
# actually existed there, because RDS's last real deploy predated those
# migration files being added. This check is cheap (metadata lookups only,
# not data scans) so it always runs; only if something's actually missing
# does it trigger reconciliation — dispatched to run ON EC2, not from here,
# since a long individual psql session to RDS from a home network can
# silently stall (also happened once — 36 min in, connection still showing
# ESTABLISHED locally with no matching active query server-side; almost
# certainly a NAT/router idle-connection drop over the public-internet hop,
# which running from EC2's same-VPC path avoids entirely).
echo "  Checking for schema drift..."
EXPECTED_TABLES="count_cache daily_customer_category_summary daily_filter_category_summary daily_status_category_summary order_category_facts order_events"
EXPECTED_COLUMNS="daily_filter_category_summary.updatedAt daily_status_category_summary.updatedAt order_category_facts.orderTotal order_category_facts.regionCode order_category_facts.regionId order_category_facts.status orders.search_text"

SCHEMA_DRIFT=0
for t in $EXPECTED_TABLES; do
  exists="$(psql "$DATABASE_URL" -Atqc "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$t'" 2>/dev/null)"
  if [[ "$exists" != "1" ]]; then
    echo "    drift: table \"$t\" is missing"
    SCHEMA_DRIFT=1
  fi
done
for tc in $EXPECTED_COLUMNS; do
  tbl="${tc%%.*}"
  col="${tc#*.}"
  exists="$(psql "$DATABASE_URL" -Atqc "SELECT 1 FROM information_schema.columns WHERE table_name='$tbl' AND column_name='$col'" 2>/dev/null)"
  if [[ "$exists" != "1" ]]; then
    echo "    drift: column \"$tbl.$col\" is missing"
    SCHEMA_DRIFT=1
  fi
done

if [[ "$SCHEMA_DRIFT" == "1" ]]; then
  echo "  Reconciling by re-running all raw SQL migrations on EC2 (backgrounded)..."
  # Pidfile lock: if a reconciliation from an earlier run is still alive,
  # don't dispatch a second one — two concurrent loops writing to the same
  # log file (each opened with a plain >, not appending) interleave their
  # output byte-for-byte and waste RDS resources running the same idempotent
  # work twice. Just attach to the existing one instead.
  ALREADY_RUNNING="$(ssh $SSH_OPTS "ec2-user@${EC2_IP}" '
    if [ -f /app/reconcile.pid ] && kill -0 "$(cat /app/reconcile.pid)" 2>/dev/null; then
      echo yes
    fi
  ')"
  if [[ "$ALREADY_RUNNING" == "yes" ]]; then
    echo "  A reconciliation is already running from an earlier deploy — attaching to it instead of starting a new one."
  else
    ssh $SSH_OPTS "ec2-user@${EC2_IP}" bash <<REMOTE
      cd /app
      rm -f /app/reconcile.status
      export DATABASE_URL='${DATABASE_URL}'
      nohup bash -c '
        for m in \$(find prisma/migrations -mindepth 2 -name migration.sql | sort | grep -v baseline); do
          echo "=== \$m ==="
          psql "\$DATABASE_URL" -v ON_ERROR_STOP=1 -f "\$m" 2>&1 | grep -Ei "error|ERROR:" || echo "  ok"
        done
        echo SUCCESS > /app/reconcile.status
      ' > /app/reconcile.log 2>&1 &
      RECONCILE_PID=\$!
      echo "\$RECONCILE_PID" > /app/reconcile.pid
      disown
      echo "  Started in background (pid \$RECONCILE_PID)."
REMOTE
  fi
  echo "  Waiting for it to finish — printing new output every poll (every 2 min);"
  echo "  runs on EC2 regardless of this connection, so it's safe to Ctrl-C and"
  echo "  reattach later with: ssh $SSH_OPTS ec2-user@${EC2_IP} 'tail -f /app/reconcile.log'"
  RECONCILE_STATUS=""
  RECONCILE_LINES_SHOWN=0
  while [[ -z "$RECONCILE_STATUS" ]]; do
    sleep 120
    RECONCILE_LOG_NOW="$(ssh $SSH_OPTS "ec2-user@${EC2_IP}" 'cat /app/reconcile.log 2>/dev/null' || true)"
    NEW_OUTPUT="$(printf '%s\n' "$RECONCILE_LOG_NOW" | tail -n "+$((RECONCILE_LINES_SHOWN + 1))")"
    [[ -n "$NEW_OUTPUT" ]] && printf '%s\n' "$NEW_OUTPUT"
    RECONCILE_LINES_SHOWN="$(printf '%s\n' "$RECONCILE_LOG_NOW" | wc -l | tr -d ' ')"
    RECONCILE_STATUS="$(ssh $SSH_OPTS "ec2-user@${EC2_IP}" 'cat /app/reconcile.status 2>/dev/null' || true)"
  done
  echo "  Schema reconciliation complete."
else
  echo "  No schema drift detected."
fi

echo "  Syncing app files..."
ssh $SSH_OPTS "ec2-user@${EC2_IP}" "command -v rsync >/dev/null 2>&1 || sudo dnf install -y rsync"
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.env*' \
  --exclude='infra' \
  -e "ssh $SSH_OPTS" \
  "$ROOT_DIR/" "ec2-user@${EC2_IP}:/app/"

# Quick Order now lives on its OWN separate EC2 instance/IP (see
# websockets-quickorder/infra) — read its Terraform output rather than
# hardcoding a same-host path, so this keeps working across its redeploys.
# Use its HTTPS CloudFront URL, not the plain-http EIP: this dashboard is
# itself served over HTTPS (via CloudFront), and a browser fetch from an
# HTTPS page to a plain-http endpoint is blocked as mixed content.
# Unlike Quick Order's dependency on US (which has no working fallback and
# must abort/opt-in), the dashboard degrades gracefully without Quick Order —
# the "Live" checkbox already shows an in-app "isn't running" banner. So an
# out-of-order run here (dashboard deployed before Quick Order) just warns
# with the exact fix command and continues, rather than aborting.
QUICKORDER_DIR="$(cd "$ROOT_DIR/../websockets-quickorder" 2>/dev/null && pwd || true)"
QUICKORDER_URL=""
[[ -n "$QUICKORDER_DIR" ]] && QUICKORDER_URL=$(cd "$QUICKORDER_DIR/infra" 2>/dev/null && terraform output -raw cdn_url 2>/dev/null || true)
[[ "$QUICKORDER_URL" =~ ^https?:// ]] || QUICKORDER_URL=""
if [[ -z "$QUICKORDER_URL" ]]; then
  QUICKORDER_URL="http://localhost:3005"
  echo ""
  echo "  Note: Quick Order's Terraform output isn't available yet (not deployed, or"
  echo "  deployed out of order) — NEXT_PUBLIC_QUICK_ORDER_URL will fall back to"
  echo "  $QUICKORDER_URL, so the deployed dashboard's 'Live' checkbox will show its"
  echo "  built-in 'Quick Order isn't running' banner until you deploy it:"
  echo "    cd ${QUICKORDER_DIR:-../websockets-quickorder} && ./scripts/deploy.sh"
  echo "  Then redeploy the dashboard to pick up the new URL."
  echo ""
fi

DEMO_SCALE="$( [[ "$DEPLOY_MODE" == "full" ]] && echo '~4M demo orders' || echo '~500K demo orders' )"

echo "  Starting dashboard on EC2..."
ssh $SSH_OPTS "ec2-user@${EC2_IP}" bash <<REMOTE
  set -e
  export DATABASE_URL='${DATABASE_URL}'
  cd /app
  command -v aws >/dev/null 2>&1 || sudo dnf install -y awscli
  # pg_dump refuses to dump from a server newer than itself — keep the
  # installed client on the SAME major version as the actual RDS server,
  # not whatever version_data happened to install at first boot.
  SERVER_MAJOR="\$(psql "\$DATABASE_URL" -Atqc 'SHOW server_version;' 2>/dev/null | cut -d. -f1)"
  CLIENT_MAJOR="\$(pg_dump --version 2>/dev/null | grep -oE '[0-9]+' | head -1)"
  if [[ -n "\$SERVER_MAJOR" && "\$SERVER_MAJOR" != "\$CLIENT_MAJOR" ]]; then
    echo "  pg_dump v\${CLIENT_MAJOR:-none} != RDS server v\$SERVER_MAJOR — swapping client packages..."
    sudo dnf swap -y "postgresql\${CLIENT_MAJOR}" "postgresql\$SERVER_MAJOR" 2>/dev/null \
      || sudo dnf install -y "postgresql\$SERVER_MAJOR"
  fi
  npm ci --prefer-offline
  # NEXT_PUBLIC_* is baked in at build time — without this, the deployed
  # bundle keeps the localhost:3005 dev default, so the "Live" checkbox's
  # Quick Order check runs in the VISITOR's browser against their own
  # localhost instead of Quick Order's actual (separate) deployed instance.
  export NEXT_PUBLIC_QUICK_ORDER_URL='${QUICKORDER_URL}'
  export NEXT_PUBLIC_DEMO_SCALE='${DEMO_SCALE}'
  npm run build
  pm2 stop dashboard 2>/dev/null || true
  pm2 start "npm start" --name dashboard
  pm2 stop aggregates-worker 2>/dev/null || true
  pm2 start "npx tsx scripts/aggregates-worker.ts" --name aggregates-worker
  pm2 save

  # Nginx reverse proxy — clean http://<EC2-IP>/ instead of :3004. Quick
  # Order is a separate instance/IP entirely (see websockets-quickorder/infra),
  # so nothing is proxied to it from here. No HTTPS/domain yet (would need
  # Certbot + a real domain name).
  command -v nginx >/dev/null 2>&1 || sudo dnf install -y nginx
  sudo tee /etc/nginx/conf.d/app.conf > /dev/null <<'NGINX_CONF'
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
    }
}
NGINX_CONF
  sudo rm -f /etc/nginx/conf.d/default.conf
  sudo nginx -t
  sudo systemctl enable nginx
  sudo systemctl restart nginx
REMOTE

CDN_URL="$(cd "$ROOT_DIR/infra" && terraform output -raw cdn_url 2>/dev/null || true)"
[[ "$CDN_URL" =~ ^https?:// ]] || CDN_URL=""

_BASE_URL="${CDN_URL:-http://${EC2_IP}}"
echo ""
echo "✓ Dashboard live at  ${_BASE_URL}"
echo "  API Explorer:      ${_BASE_URL}/api-explorer"

PORTFOLIO_SET_LIVE="$(cd "$ROOT_DIR/../../../portfolio/scripts" 2>/dev/null && pwd || true)/set-live-url.sh"
if [[ -n "$CDN_URL" && -f "$PORTFOLIO_SET_LIVE" ]]; then
  echo ""
  echo "  Updating portfolio live-urls.js..."
  bash "$PORTFOLIO_SET_LIVE" --tier "$DEPLOY_MODE" nextjs "$CDN_URL" "$CDN_URL/api-explorer"
fi

QUICKORDER_DEPLOY="$(cd "$ROOT_DIR/../websockets-quickorder/scripts" 2>/dev/null && pwd || true)/deploy.sh"
if [[ -f "$QUICKORDER_DEPLOY" ]]; then
  echo ""
  echo "  Chaining Quick Order deploy (${DEPLOY_MODE}, backend: http://${EC2_IP})..."
  DEPLOY_MODE="$DEPLOY_MODE" BACKEND_URL="http://${EC2_IP}" bash "$QUICKORDER_DEPLOY"
fi

echo "  Direct (HTTP):     http://${EC2_IP}"
echo "  Quick Order at:    ${QUICKORDER_URL}  (separate instance)"
echo "  SSH:               ssh -i ${SSH_KEY} ec2-user@${EC2_IP}"
echo "  Tear down:         ./scripts/infra-down.sh"

# ── 4. Demo-scale check — ask before a long reseed, never do it silently ─────
if [[ "$DEPLOY_MODE" == "lite" ]]; then
  DEMO_SCALE_THRESHOLD=400000
  DEMO_SNAPSHOT_S3_URI_VALUE="s3://bikram-nextjs-subsecond-fetch-with-websockets/nextjs-dash/demo-lite.dump"
  DEMO_ORDER_COUNT_VALUE=500000
else
  DEMO_SCALE_THRESHOLD=1000000
  DEMO_SNAPSHOT_S3_URI_VALUE="s3://bikram-nextjs-subsecond-fetch-with-websockets/nextjs-dash/demo.dump"
  DEMO_ORDER_COUNT_VALUE=4000000
fi

_SEED_RUNNING="$(ssh $SSH_OPTS "ec2-user@${EC2_IP}" \
  'pgrep -f "seed-large\|prepare-demo-data\|rebuild-dashboard-read-models\|bake-demo-snapshot" 2>/dev/null | head -1 || true' 2>/dev/null || true)"

if [[ -n "$_SEED_RUNNING" ]]; then
  echo ""
  echo "  A seed/rebuild/bake job is already running on EC2 (pid $_SEED_RUNNING)."
  printf "  Re-attach to its log? [Y/n] "
  read -r yn_reattach
  if [[ ! "$yn_reattach" =~ ^[Nn]$ ]]; then
    ssh $SSH_OPTS "ec2-user@${EC2_IP}" 'tail -f /app/seed-and-bake.log & _TAIL_PID=$!; until [ -f /app/seed-and-bake.status ]; do sleep 5; done; sleep 1; kill $_TAIL_PID 2>/dev/null; echo ""; echo "=== $(cat /app/seed-and-bake.status) ==="'
  else
    echo "  To re-attach later:"
    echo "    ssh $SSH_OPTS ec2-user@${EC2_IP} 'tail -f /app/seed-and-bake.log'"
  fi
  exit 0
fi

CURRENT_ORDERS="$(psql "$DATABASE_URL" -Atqc 'SELECT count(*) FROM orders' 2>/dev/null || echo 0)"
if [[ "$CURRENT_ORDERS" =~ ^[0-9]+$ ]] && (( CURRENT_ORDERS < DEMO_SCALE_THRESHOLD )); then
  echo ""
  echo "  RDS has $CURRENT_ORDERS orders (below demo scale)."
  printf "  Restore from S3 snapshot + rebuild read models + re-bake? [Y/n] "
  read -r yn
  if [[ ! "$yn" =~ ^[Nn]$ ]]; then
    MY_IP="$(curl -fsSL https://checkip.amazonaws.com || true)"
    ALLOWED_CIDR_NOW="${MY_IP:+${MY_IP}/32}"
    ALLOWED_CIDR_NOW="${ALLOWED_CIDR_NOW:-0.0.0.0/0}"
    SCALED_UP=0

    echo "  Restoring from S3 snapshot + rebuilding read models + re-baking (backgrounded on EC2)..."
    ssh $SSH_OPTS "ec2-user@${EC2_IP}" bash <<REMOTE
      cd /app
      rm -f /app/seed-and-bake.status
      export DATABASE_URL='${DATABASE_URL}'
      export DEMO_SNAPSHOT_S3_URI='${DEMO_SNAPSHOT_S3_URI_VALUE}'
      export DEMO_ORDER_COUNT='${DEMO_ORDER_COUNT_VALUE}'
      export PGOPTIONS="-c synchronous_commit=off -c maintenance_work_mem=1GB"
      nohup bash -c '
        if DEMO_SNAPSHOT_S3_URI="\$DEMO_SNAPSHOT_S3_URI" DEMO_ORDER_COUNT="\$DEMO_ORDER_COUNT" DATABASE_URL="\$DATABASE_URL" ./scripts/prepare-demo-data.sh &&
           DEMO_SNAPSHOT_S3_URI="\$DEMO_SNAPSHOT_S3_URI" DATABASE_URL="\$DATABASE_URL" ./scripts/bake-demo-snapshot.sh
        then
          echo SUCCESS > /app/seed-and-bake.status
        else
          echo FAILED > /app/seed-and-bake.status
        fi
      ' > /app/seed-and-bake.log 2>&1 &
      disown
      echo "  Started in background (pid \$!)."
REMOTE
    printf "  Tail the log now (auto-detaches on completion)? [Y/n] "
    read -r yn_tail
    if [[ ! "$yn_tail" =~ ^[Nn]$ ]]; then
      echo "  Tailing — will auto-detach when job finishes (Ctrl+C to detach early)..."
      ssh $SSH_OPTS "ec2-user@${EC2_IP}" 'tail -f /app/seed-and-bake.log & _TAIL_PID=$!; until [ -f /app/seed-and-bake.status ]; do sleep 5; done; sleep 1; kill $_TAIL_PID 2>/dev/null; echo ""; echo "=== $(cat /app/seed-and-bake.status) ==="'
    else
      echo "  To tail later (auto-detaches on completion):"
      echo "    ssh $SSH_OPTS ec2-user@${EC2_IP} 'tail -f /app/seed-and-bake.log & _TAIL_PID=\$!; until [ -f /app/seed-and-bake.status ]; do sleep 5; done; sleep 1; kill \$_TAIL_PID 2>/dev/null; echo; echo \"=== \$(cat /app/seed-and-bake.status) ===\"'"
    fi

    if [[ "$SCALED_UP" == "1" ]]; then
      echo "  RDS is scaled up — waiting for the background job to finish so it can scale back down (polling every 2 min)..."
      STATUS=""
      while [[ -z "$STATUS" ]]; do
        sleep 120
        STATUS="$(ssh $SSH_OPTS "ec2-user@${EC2_IP}" 'cat /app/seed-and-bake.status 2>/dev/null' || true)"
      done
      if [[ "$STATUS" == "SUCCESS" ]]; then
        echo "  Seed + rebuild + bake completed successfully."
      else
        echo "  Seed + rebuild + bake FAILED — check /app/seed-and-bake.log on the instance before deciding whether to scale down."
      fi
      printf "  Scale RDS back down to db.t3.large now? [Y/n] "
      read -r yn_down
      if [[ ! "$yn_down" =~ ^[Nn]$ ]]; then
        echo "  Scaling RDS back down to db.t3.large..."
        (cd "$ROOT_DIR/infra" && terraform apply -auto-approve -input=false \
          -var "instance_class=db.t3.large" \
          -var "allowed_cidr=$ALLOWED_CIDR_NOW" \
          -var "ssh_public_key_path=${SSH_KEY}.pub")
      else
        echo "  Left scaled up — remember to scale it back down later to avoid the extra cost."
      fi
    fi
  else
    echo "  Skipped."
  fi
fi
