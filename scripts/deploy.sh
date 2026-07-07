#!/usr/bin/env bash
set -euo pipefail

# Single entry point: provision EC2 + RDS via infra-up.sh, apply migrations,
# deploy the app to EC2, and print the live URL.
# If AWS is unavailable or infra fails, prompts to continue on local instead.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=5 -i $SSH_KEY"

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
EXPECTED_TABLES="count_cache daily_customer_category_summary daily_customer_token_category_rollup daily_customer_token_category_summary daily_customer_token_order_summary daily_filter_category_summary daily_status_category_summary order_category_facts order_events"
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

echo ""
echo "✓ Dashboard live at  ${CDN_URL:-http://${EC2_IP} (CloudFront URL unavailable, HTTP only)}"
echo "  Direct (HTTP):     http://${EC2_IP}"
echo "  Quick Order at:    ${QUICKORDER_URL}  (separate instance — deploy via websockets-quickorder/scripts/deploy.sh)"
echo "  SSH:               ssh -i ${SSH_KEY} ec2-user@${EC2_IP}"
echo "  Tear down:         ./scripts/infra-down.sh"

# ── 4. Demo-scale check — ask before a long reseed, never do it silently ─────
DEMO_SCALE_THRESHOLD=1000000
CURRENT_ORDERS="$(psql "$DATABASE_URL" -Atqc 'SELECT count(*) FROM orders' 2>/dev/null || echo 0)"
if [[ "$CURRENT_ORDERS" =~ ^[0-9]+$ ]] && (( CURRENT_ORDERS < DEMO_SCALE_THRESHOLD )); then
  echo ""
  echo "  RDS has $CURRENT_ORDERS orders (below demo scale)."
  printf "  Proceed to seed to 4M again — will take 45-90 minutes on AWS infra? [y/N] "
  read -r yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    # EC2's instance type doesn't matter here — it's just the psql client;
    # RDS's own CPU/memory is what the rebuild's cross-join is bound by.
    MY_IP="$(curl -fsSL https://checkip.amazonaws.com || true)"
    ALLOWED_CIDR_NOW="${MY_IP:+${MY_IP}/32}"
    ALLOWED_CIDR_NOW="${ALLOWED_CIDR_NOW:-0.0.0.0/0}"
    SCALED_UP=0
    printf "  Scale RDS up to db.m5.2xlarge first, to speed up the rebuild step? [y/N] "
    read -r yn_scale
    if [[ "$yn_scale" =~ ^[Yy]$ ]]; then
      echo "  Scaling RDS up to db.m5.2xlarge..."
      (cd "$ROOT_DIR/infra" && terraform apply -auto-approve -input=false \
        -var "instance_class=db.m5.2xlarge" \
        -var "allowed_cidr=$ALLOWED_CIDR_NOW" \
        -var "ssh_public_key_path=${SSH_KEY}.pub")
      SCALED_UP=1
    fi

    echo "  Seeding to 4M orders + rebuilding read models + re-baking the S3 snapshot on EC2 (backgrounded)..."
    ssh $SSH_OPTS "ec2-user@${EC2_IP}" bash <<REMOTE
      cd /app
      rm -f /app/seed-and-bake.status
      export DATABASE_URL='${DATABASE_URL}'
      nohup bash -c '
        # Session-level tuning for the bulk load only — libpq applies these to
        # every new connection (seed-large.sql is one session; the rebuild
        # script opens a fresh psql connection per phase, so a plain SQL SET
        # would only cover the first one). synchronous_commit=off is safe here
        # since this is disposable demo/seed data, not data we need durability
        # guarantees on if the instance crashed mid-load.
        export PGOPTIONS="-c synchronous_commit=off -c maintenance_work_mem=1GB"
        if psql "\$DATABASE_URL" -v orders=4000000 -v batch_size=500000 -f scripts/seed-large.sql &&
           DATABASE_URL="\$DATABASE_URL" ./scripts/rebuild-dashboard-read-models.sh &&
           DEMO_SNAPSHOT_S3_URI="s3://bikram-nextjs-subsecond-fetch-with-websockets/nextjs-dash/demo.dump" ./scripts/bake-demo-snapshot.sh
        then
          echo SUCCESS > /app/seed-and-bake.status
        else
          echo FAILED > /app/seed-and-bake.status
        fi
      ' > /app/seed-and-bake.log 2>&1 &
      disown
      echo "  Started in background (pid \$!)."
REMOTE
    echo "  Tail progress with:"
    echo "    ssh $SSH_OPTS ec2-user@${EC2_IP} 'tail -f /app/seed-and-bake.log'"

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
      printf "  Scale RDS back down to db.m5.xlarge now? [Y/n] "
      read -r yn_down
      if [[ ! "$yn_down" =~ ^[Nn]$ ]]; then
        echo "  Scaling RDS back down to db.m5.xlarge..."
        (cd "$ROOT_DIR/infra" && terraform apply -auto-approve -input=false \
          -var "instance_class=db.m5.xlarge" \
          -var "allowed_cidr=$ALLOWED_CIDR_NOW" \
          -var "ssh_public_key_path=${SSH_KEY}.pub")
      else
        echo "  Left scaled up at db.m5.2xlarge — remember to scale it back down later to avoid the extra cost."
      fi
    fi
  else
    echo "  Skipped."
  fi
fi
