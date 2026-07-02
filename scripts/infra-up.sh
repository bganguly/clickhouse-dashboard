#!/usr/bin/env bash
set -euo pipefail

print_recovery_hint() {
  echo "" >&2
  echo "Interrupt detected. RDS Postgres creation usually takes ~5-10 minutes." >&2
  echo "Recovery: wait a minute, then rerun ./scripts/infra-up.sh (terraform is idempotent)." >&2
  echo "To remove everything: ./scripts/infra-down.sh" >&2
}
trap 'print_recovery_hint' INT

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
START_TS="$(date +%s)"
NAME_PREFIX="${TF_VAR_name_prefix:-dash-test}"
DB_INSTANCE_ID="${NAME_PREFIX}-db"
DB_SUBNET_GROUP="${NAME_PREFIX}-subnet-group"

elapsed() {
  local now
  now="$(date +%s)"
  printf '%ss' "$((now - START_TS))"
}

step() {
  printf '\n[%s] %s\n' "$(elapsed)" "$1"
  printf '    ETA: %s\n' "$2"
}

state_has() {
  terraform state list 2>/dev/null | grep -qx "$1"
}

rds_instance_status() {
  aws rds describe-db-instances \
    --db-instance-identifier "$DB_INSTANCE_ID" \
    --query 'DBInstances[0].DBInstanceStatus' \
    --output text 2>/dev/null || true
}

backup_state_has_db() {
  # The backup state is written by Terraform on every apply. If it still
  # describes our DB instance, we can restore it to adopt the live infra.
  local backup="$INFRA_DIR/terraform.tfstate.backup"
  [[ -f "$backup" ]] && grep -q '"aws_db_instance"' "$backup"
}

recover_state_if_drifted() {
  # The drift trap: local Terraform state is empty (lost/cleared) but the RDS
  # instance is alive in AWS. The old behaviour was to DELETE the healthy
  # database and recreate it — silent data loss. Instead, adopt the existing
  # infra by restoring the backup state Terraform itself wrote, so the next
  # apply is a no-op (or at most a security-group CIDR tweak).
  if state_has aws_db_instance.pg; then
    return
  fi

  local status
  status="$(rds_instance_status)"
  if [[ -z "$status" || "$status" == "None" ]]; then
    return  # No live instance: a clean create is correct, nothing to adopt.
  fi

  echo "Local Terraform state has no aws_db_instance.pg, but RDS $DB_INSTANCE_ID is live (status: $status)."
  if backup_state_has_db; then
    echo "    Restoring Terraform state from terraform.tfstate.backup to adopt the existing database."
    cp "$INFRA_DIR/terraform.tfstate.backup" "$INFRA_DIR/terraform.tfstate"
    terraform init -input=false >/dev/null
    if state_has aws_db_instance.pg; then
      echo "    Adopted existing infra from backup state — no recreation needed."
      return
    fi
    echo "    Backup state did not restore the instance cleanly." >&2
  fi

  # No backup to adopt from. Do NOT delete a healthy DB. Stop with a clear path.
  if [[ "$status" == "available" || "$status" == "backing-up" || "$status" == "modifying" ]]; then
    cat >&2 <<MSG

A healthy RDS instance ($DB_INSTANCE_ID, status: $status) exists but is not in
Terraform state, and there is no backup state to adopt it from. Refusing to
delete a healthy database. Import it once, then re-run this script:

  cd "$INFRA_DIR"
  terraform import aws_db_instance.pg $DB_INSTANCE_ID

MSG
    exit 1
  fi
}

delete_unmanaged_rds_instance() {
  local status
  status="$(rds_instance_status)"
  if [[ -z "$status" || "$status" == "None" ]]; then
    echo "No unmanaged RDS instance named $DB_INSTANCE_ID found."
    return
  fi

  if state_has aws_db_instance.pg; then
    echo "RDS instance $DB_INSTANCE_ID is already managed by Terraform state."
    return
  fi

  # Backstop: recover_state_if_drifted runs first and adopts healthy instances,
  # so reaching here with a healthy DB means adoption failed. Never delete it.
  if [[ "$status" == "available" || "$status" == "backing-up" || "$status" == "modifying" ]]; then
    echo "Refusing to delete healthy RDS instance $DB_INSTANCE_ID (status: $status)." >&2
    echo "Import it instead: (cd $INFRA_DIR && terraform import aws_db_instance.pg $DB_INSTANCE_ID)" >&2
    exit 1
  fi

  if [[ "$status" != "deleting" ]]; then
    echo "Deleting unmanaged RDS instance $DB_INSTANCE_ID (status: $status)."
    aws rds delete-db-instance \
      --db-instance-identifier "$DB_INSTANCE_ID" \
      --skip-final-snapshot \
      --delete-automated-backups >/dev/null
  else
    echo "Unmanaged RDS instance $DB_INSTANCE_ID is already deleting."
  fi

  echo "Waiting for unmanaged RDS instance $DB_INSTANCE_ID to be deleted."
  aws rds wait db-instance-deleted --db-instance-identifier "$DB_INSTANCE_ID"
}

delete_unmanaged_db_subnet_group() {
  if ! aws rds describe-db-subnet-groups \
    --db-subnet-group-name "$DB_SUBNET_GROUP" >/dev/null 2>&1; then
    echo "No unmanaged RDS subnet group named $DB_SUBNET_GROUP found."
    return
  fi

  if state_has aws_db_subnet_group.pg; then
    echo "RDS subnet group $DB_SUBNET_GROUP is already managed by Terraform state."
    return
  fi

  echo "Deleting unmanaged RDS subnet group $DB_SUBNET_GROUP."
  aws rds delete-db-subnet-group --db-subnet-group-name "$DB_SUBNET_GROUP"
}

step "1/7 Checking local dependencies: terraform and aws CLI." "< 1 min"
"$ROOT_DIR/scripts/bootstrap-deps.sh" terraform aws

step "2/7 Detecting your current public IP for the RDS security group." "< 10 sec"
MY_IP="$(curl -fsSL https://checkip.amazonaws.com || true)"
if [[ -n "$MY_IP" ]]; then
  ALLOWED_CIDR="${MY_IP}/32"
else
  ALLOWED_CIDR="0.0.0.0/0"
fi
echo "Locking DB access to allowed_cidr=$ALLOWED_CIDR"

cd "$INFRA_DIR"
step "3/7 Initializing Terraform providers/state." "< 1 min"
terraform init -input=false

step "4/7 Reconciling state with live AWS infra." "< 1 min"
echo "    Adopting an existing database if state drifted; only clearing genuinely orphaned leftovers."
recover_state_if_drifted
delete_unmanaged_rds_instance
delete_unmanaged_db_subnet_group

step "5/7 Applying AWS infra: VPC, subnets, route table, security groups, RDS Postgres, and EC2 app server." "5-10 min for a new RDS instance; usually < 2 min when already created"
echo "    Terraform is idempotent: it creates missing pieces and leaves healthy existing pieces alone."

SSH_PUB_KEY=""
for candidate in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
  [[ -f "$candidate" ]] && { SSH_PUB_KEY="$candidate"; break; }
done
if [[ -z "$SSH_PUB_KEY" ]]; then
  echo "No SSH public key found at ~/.ssh/id_ed25519.pub or ~/.ssh/id_rsa.pub." >&2
  echo "Generate one with: ssh-keygen -t ed25519" >&2
  exit 1
fi
echo "    Using SSH public key: $SSH_PUB_KEY"

terraform apply -auto-approve -input=false \
  -var "allowed_cidr=$ALLOWED_CIDR" \
  -var "ssh_public_key_path=$SSH_PUB_KEY"

step "6/7 Reading Terraform outputs and writing .env.rds." "< 10 sec"
DATABASE_URL="$(terraform output -raw database_url)"
DB_HOST="$(terraform output -raw db_endpoint)"
DB_PORT="$(terraform output -raw db_port)"
DB_NAME="$(terraform output -raw db_name)"
DB_USER="$(terraform output -raw db_username)"

cat > "$ROOT_DIR/.env.rds" <<EOF
# Generated by scripts/infra-up.sh — gitignored, do not commit.
DATABASE_URL=$DATABASE_URL
PGHOST=$DB_HOST
PGPORT=$DB_PORT
PGDATABASE=$DB_NAME
PGUSER=$DB_USER
EOF

printf '\nWrote %s (DATABASE_URL + PG* vars).\n' "$ROOT_DIR/.env.rds"
step "7/7 Checking whether Quick Order is already running on :3005." "< 10 sec"
if curl -fsS --max-time 2 http://localhost:3005 >/dev/null 2>&1; then
  echo "Quick Order is already active at http://localhost:3005."
else
  cat <<'QUICKORDER'
Quick Order is not responding on :3005.
Start it in a separate terminal:
  cd ../websockets-quickorder
  npm install
  BACKEND_URL=http://localhost:3004 npm run dev

Then open http://localhost:3005.
QUICKORDER
fi

cat <<'NEXT'

Infra is ready. Next, run these two commands:
  npm install
  ./scripts/prepare-demo-data.sh

Then start the dashboard:
  ./scripts/start-dashboard.sh

Tear down (stops billing):  ./scripts/infra-down.sh
NEXT
