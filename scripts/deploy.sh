#!/usr/bin/env bash
set -euo pipefail

# Single entry point: provision infra if needed, apply schema + migrations,
# then start the dashboard. Safe to re-run (all steps are idempotent).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

"$ROOT_DIR/scripts/bootstrap-deps.sh" psql

# ── 1. Infra ──────────────────────────────────────────────────────────────────
if ! DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh" 2>/dev/null)"; then
  echo ""
  echo "No database found — provisioning AWS RDS (5-10 min for a new instance)."
  printf "Proceed? [Y/n] "
  read -r yn
  [[ -z "$yn" || "$yn" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
  "$ROOT_DIR/scripts/infra-up.sh"
  DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"
fi
export DATABASE_URL
echo ""
echo "[1/3] Infra ready. DATABASE_URL resolved."

# ── 2. Schema + migrations ────────────────────────────────────────────────────
echo ""
echo "[2/3] Applying Prisma schema..."
npx prisma db push
echo "      Schema up to date."

echo ""
echo "      Applying SQL migration files..."
while IFS= read -r migration; do
  printf '      %s\n' "${migration#"$ROOT_DIR"/}"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done < <(find "$ROOT_DIR/prisma/migrations" -maxdepth 2 -name migration.sql -print | sort)
echo "      Migrations applied."

# ── 3. Dashboard ──────────────────────────────────────────────────────────────
echo ""
echo "[3/3] Starting dashboard on http://localhost:3004 ..."
npm run dev
