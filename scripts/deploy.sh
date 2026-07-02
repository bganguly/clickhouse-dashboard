#!/usr/bin/env bash
set -euo pipefail

# Apply pending Prisma schema changes and SQL migrations to the existing
# database. Does NOT reseed data. Safe to re-run (all migrations are idempotent).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

"$ROOT_DIR/scripts/bootstrap-deps.sh" psql

if ! DATABASE_URL="$("$ROOT_DIR/scripts/database-url.sh")"; then
  echo "No database configured — run ./scripts/infra-up.sh first." >&2
  exit 1
fi
export DATABASE_URL

echo ""
echo "[1/2] Applying Prisma schema (prisma db push)..."
npx prisma db push
echo "      Schema up to date."

echo ""
echo "[2/2] Applying SQL migration files..."
while IFS= read -r migration; do
  printf '      applying %s\n' "${migration#"$ROOT_DIR"/}"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done < <(find "$ROOT_DIR/prisma/migrations" -maxdepth 2 -name migration.sql -print | sort)
echo "      Migrations applied."

echo ""
echo "Done. Start the dashboard with: ./scripts/start-dashboard.sh"
