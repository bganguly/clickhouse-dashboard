#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB="${LOCAL_DB:-dashboard_local}"
DATABASE_URL="postgresql://localhost:5432/${DB}"

# ── helpers ───────────────────────────────────────────────────────────────────
fail() { printf '\nERROR: %s\n\n' "$*" >&2; exit 1; }
ok()   { printf '  %-18s %s\n' "$1" "$2"; }

# ── prerequisites ─────────────────────────────────────────────────────────────
printf '\n=== prerequisites ===\n'

node_ver=$(node --version 2>/dev/null || true)
[[ -n "$node_ver" ]] || fail "Node.js not found. Install via nvm or https://nodejs.org (18+ required)."
ok "node" "$node_ver"

command -v psql >/dev/null 2>&1 || fail "psql not found — install Postgres (brew install postgresql@16)"
ok "psql" "$(psql --version)"

if ! pg_isready -q 2>/dev/null; then
  printf '  postgres: not running — starting...\n'
  if command -v brew >/dev/null 2>&1; then
    brew services start postgresql@16 2>/dev/null \
      || brew services start postgresql@15 2>/dev/null \
      || brew services start postgresql 2>/dev/null \
      || true
    sleep 2
  fi
  pg_isready -q 2>/dev/null || fail "Postgres did not start. Install: brew install postgresql@16"
fi
ok "postgres" "ready"

# ── database setup ────────────────────────────────────────────────────────────
DB_EXISTS=$(psql -lqt 2>/dev/null | cut -d'|' -f1 | tr -d ' ' | grep -x "$DB" || true)

if [[ -z "$DB_EXISTS" ]]; then
  printf '\n=== first-time local database setup ===\n'
  printf '  Will:\n'
  printf '    1. createdb %s\n' "$DB"
  printf '    2. apply Prisma schema\n'
  printf '    3. apply SQL migration files\n'
  printf '    4. seed demo data (~4 M orders, takes 15-20 min)\n'
  printf '\nProceed? [Y/n] '
  read -r yn
  [[ -z "$yn" || "$yn" =~ ^[Yy]$ ]] || { printf 'Aborted.\n'; exit 0; }

  printf '\n[1/3] creating database %s...\n' "$DB"
  createdb "$DB"

  printf '[2/3] applying Prisma schema...\n'
  DATABASE_URL="$DATABASE_URL" npx prisma db push

  printf '[3/3] applying SQL migration files...\n'
  while IFS= read -r migration; do
    printf '      %s\n' "${migration#"$ROOT_DIR"/}"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
  done < <(find "$ROOT_DIR/prisma/migrations" -maxdepth 2 -name migration.sql -print | sort)

  printf '\nSchema ready. Seed demo data now? (skip to start with empty DB) [Y/n] '
  read -r do_seed
  if [[ -z "$do_seed" || "$do_seed" =~ ^[Yy]$ ]]; then
    printf 'Seeding...\n'
    psql "$DATABASE_URL" \
      -v orders="${DEMO_ORDER_COUNT:-4000000}" \
      -v batch_size="${SEED_BATCH_SIZE:-500000}" \
      -f "$ROOT_DIR/scripts/seed-large.sql"
    "$ROOT_DIR/scripts/rebuild-dashboard-read-models.sh"
    printf 'Seed complete.\n'
  fi
else
  ok "database" "$DB (exists — skipping setup)"

  printf '\n[1/2] applying any pending Prisma schema changes...\n'
  DATABASE_URL="$DATABASE_URL" npx prisma db push

  printf '[2/2] applying any pending SQL migration files...\n'
  while IFS= read -r migration; do
    printf '      %s\n' "${migration#"$ROOT_DIR"/}"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
  done < <(find "$ROOT_DIR/prisma/migrations" -maxdepth 2 -name migration.sql -print | sort)
fi

# ── start ─────────────────────────────────────────────────────────────────────
printf '\n=== starting dashboard :3004 (local Postgres: %s) ===\n' "$DB"
export DATABASE_URL
npm run dev
