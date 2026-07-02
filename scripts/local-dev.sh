#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Prefer the Java backend's shared local DB if it already exists.
# Override with LOCAL_DB to force a specific database.
if [[ -z "${LOCAL_DB:-}" ]]; then
  if psql -lqt 2>/dev/null | cut -d'|' -f1 | tr -d ' ' | grep -qx "dashboard_perf"; then
    DB="dashboard_perf"
  else
    DB="dashboard_local"
  fi
else
  DB="$LOCAL_DB"
fi

DATABASE_URL="postgresql://$(whoami)@localhost:5432/${DB}"

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

apply_migrations() {
  printf 'Applying Prisma schema...\n'
  DATABASE_URL="$DATABASE_URL" npx prisma db push

  printf 'Applying SQL migration files...\n'
  while IFS= read -r migration; do
    printf '  %s\n' "${migration#"$ROOT_DIR"/}"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
  done < <(find "$ROOT_DIR/prisma/migrations" -maxdepth 2 -name migration.sql -print | sort)
}

if [[ -z "$DB_EXISTS" ]]; then
  printf '\n=== first-time local database setup ===\n'
  printf '  Will create %s, apply schema + migrations, optionally seed 4 M orders.\n' "$DB"
  printf '\nProceed? [Y/n] '
  read -r yn
  [[ -z "$yn" || "$yn" =~ ^[Yy]$ ]] || { printf 'Aborted.\n'; exit 0; }

  printf '\n[1/3] creating database %s...\n' "$DB"
  createdb "$DB"

  printf '[2/3] applying schema + migrations...\n'
  apply_migrations

  printf '\n[3/3] Seed demo data now? (skip to start with empty DB) [Y/n] '
  read -r do_seed
  if [[ -z "$do_seed" || "$do_seed" =~ ^[Yy]$ ]]; then
    psql "$DATABASE_URL" \
      -v orders="${DEMO_ORDER_COUNT:-4000000}" \
      -v batch_size="${SEED_BATCH_SIZE:-500000}" \
      -f "$ROOT_DIR/scripts/seed-large.sql"
    "$ROOT_DIR/scripts/rebuild-dashboard-read-models.sh"
    printf 'Seed complete.\n'
  fi
else
  ok "database" "$DB (exists — applying any pending migrations)"
  apply_migrations
fi

# ── start ─────────────────────────────────────────────────────────────────────
printf '\n=== starting dashboard :3004 (local Postgres: %s) ===\n' "$DATABASE_URL"
export DATABASE_URL
npm run dev
