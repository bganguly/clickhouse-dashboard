#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── helpers ───────────────────────────────────────────────────────────────────
fail() { printf '\nERROR: %s\n\n' "$*" >&2; exit 1; }
ok()   { printf '  %-18s %s\n' "$1" "$2"; }

prompt_yn() {
  # prompt_yn "message" default  → returns 0 (yes) or 1 (no)
  # default: Y = accept enter as yes, N = accept enter as no
  local msg="$1" default="${2:-Y}"
  local suffix="[Y/n]"; [[ "$default" == "N" ]] && suffix="[y/N]"
  printf '%s %s ' "$msg" "$suffix"
  read -r _yn
  if [[ -z "$_yn" ]]; then
    [[ "$default" == "Y" ]] && return 0 || return 1
  fi
  [[ "$_yn" =~ ^[Yy]$ ]] && return 0 || return 1
}

# ── prerequisites ─────────────────────────────────────────────────────────────
printf '\n=== prerequisites ===\n'

node_ver=$(node --version 2>/dev/null || true)
[[ -n "$node_ver" ]] || fail "Node.js not found. Install via nvm or https://nodejs.org (18+ required)."
ok "node" "$node_ver"

command -v psql >/dev/null 2>&1 || fail "psql not found — install Postgres (brew install postgresql@16)"
ok "psql" "$(psql --version)"

# ── apply_migrations helper (used by both local and remote paths) ─────────────
apply_migrations() {
  printf 'Applying Prisma schema...\n'
  DATABASE_URL="$DATABASE_URL" npx prisma db push

  printf 'Applying SQL migration files...\n'
  while IFS= read -r migration; do
    printf '  %s\n' "${migration#"$ROOT_DIR"/}"
    if ! psql_out=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration" 2>&1); then
      echo "$psql_out"
      exit 1
    fi
  done < <(find "$ROOT_DIR/prisma/migrations" -maxdepth 2 -name migration.sql -print | sort)
}

# ── postgres ──────────────────────────────────────────────────────────────────
LOCAL_PG=false
if pg_isready -q 2>/dev/null; then
  LOCAL_PG=true
  ok "postgres" "ready (local)"
else
  printf '  postgres: not running — attempting to start...\n'
  if command -v brew >/dev/null 2>&1; then
    brew services start postgresql@16 2>/dev/null \
      || brew services start postgresql@15 2>/dev/null \
      || brew services start postgresql 2>/dev/null \
      || true
    sleep 2
  fi
  if pg_isready -q 2>/dev/null; then
    LOCAL_PG=true
    ok "postgres" "ready (local, just started)"
  else
    printf '\n  Local Postgres is not available.\n'

    # ── fallback: remote RDS (.env.rds) ───────────────────────────────────────
    if [[ -f "$ROOT_DIR/.env.rds" ]]; then
      printf '  Remote RDS config found (.env.rds).\n'
      if prompt_yn "  Use remote RDS instead?" Y; then
        set -a; source "$ROOT_DIR/.env.rds"; set +a
        ok "database" "remote RDS (.env.rds)"
        printf '\n=== applying migrations to remote RDS ===\n'
        apply_migrations
        printf '\n=== starting dashboard :3004 (remote RDS) ===\n'
        export DATABASE_URL
        npm run dev
        exit 0
      fi
    fi

    # ── no usable database ────────────────────────────────────────────────────
    if prompt_yn "\n  No database available. Continue anyway (will fail at DB connection)?" N; then
      export DATABASE_URL="postgresql://$(whoami)@localhost:5432/dashboard_local"
      npm run dev
    fi
    exit 0
  fi
fi

# ── local database name ───────────────────────────────────────────────────────
# Prefer the Java backend's shared DB (already seeded); fall back to our own.
if [[ -n "${LOCAL_DB:-}" ]]; then
  DB="$LOCAL_DB"
elif psql -lqt 2>/dev/null | cut -d'|' -f1 | tr -d ' ' | grep -qx "dashboard_perf"; then
  DB="dashboard_perf"
else
  DB="dashboard_local"
fi

DATABASE_URL="postgresql://$(whoami)@localhost:5432/${DB}"

# ── database setup ────────────────────────────────────────────────────────────
DB_EXISTS=$(psql -lqt 2>/dev/null | cut -d'|' -f1 | tr -d ' ' | grep -x "$DB" || true)

if [[ -z "$DB_EXISTS" ]]; then
  printf '\n=== first-time local database setup ===\n'
  printf '  Will create %s, apply schema + migrations, optionally seed 4 M orders.\n' "$DB"
  prompt_yn "\nProceed?" Y || { printf 'Aborted.\n'; exit 0; }

  printf '\n[1/3] creating database %s...\n' "$DB"
  createdb "$DB"

  printf '[2/3] applying schema + migrations...\n'
  apply_migrations

  if prompt_yn "\n[3/3] Seed demo data now? (skip to start with empty DB)" Y; then
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
"$ROOT_DIR/scripts/start-aggregates-worker.sh"
npm run dev
