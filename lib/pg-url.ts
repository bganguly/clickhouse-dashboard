/**
 * Resolve a connection string for the raw `pg` driver (used for LISTEN/NOTIFY).
 *
 * This project's Prisma datasource is plain `provider = "postgresql"`, so BOTH
 * Prisma and the raw `pg` driver require a standard `postgresql://` URL — a
 * `prisma+postgres://` proxy URL (from `prisma dev` / Prisma Postgres) works for
 * neither. If such a URL is lingering in the environment, reject it here rather
 * than let it produce confusing runtime errors.
 *
 * Resolution order:
 *   1. DIRECT_DATABASE_URL  (preferred — an explicit direct connection)
 *   2. PG_URL               (alias)
 *   3. DATABASE_URL         (only if it is already a standard postgres URL)
 *
 * This module intentionally has no other imports so it can be loaded from both
 * Next.js (via the "@/" alias) and standalone scripts (via a relative path).
 */
export function resolvePgUrl(): string {
  const candidate =
    process.env.DIRECT_DATABASE_URL ?? process.env.PG_URL ?? process.env.DATABASE_URL ?? "";

  if (!candidate) {
    throw new Error(
      "No Postgres connection string found. Set DIRECT_DATABASE_URL to a standard " +
        "postgresql:// URL for the LISTEN/NOTIFY (pg) code paths.",
    );
  }

  if (!isStandardPostgresUrl(candidate)) {
    const scheme = candidate.split("://")[0];
    throw new Error(
      `The raw pg client requires a standard postgresql:// URL, but the configured URL uses ` +
        `"${scheme}://". Set DIRECT_DATABASE_URL (or PG_URL) to a standard postgresql:// ` +
        "connection string. (This project's Prisma datasource also requires postgresql://.)",
    );
  }

  return candidate;
}

export function isStandardPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url);
}

/**
 * Connection options for the raw `pg` driver (LISTEN/NOTIFY), shared by every
 * standalone pg.Client in this project (the SSE stream subscription and the
 * aggregates-worker's wake-up-nudge connection). `pg` doesn't automatically
 * trust RDS's CA chain, so a bare connectionString with `sslmode=require` in
 * it fails with "self-signed certificate in certificate chain" against RDS —
 * `rejectUnauthorized: false` sidesteps that (acceptable here: this is a
 * same-VPC/localhost connection, not a public-internet hop where MITM is a
 * real concern). Local Postgres (e.g. Homebrew) doesn't support SSL at all,
 * so SSL is only requested when the URL asked for it or the host isn't local.
 */
export function resolvePgClientConfig(): { connectionString: string; ssl: false | { rejectUnauthorized: false } } {
  const rawUrl = resolvePgUrl();
  const parsed = new URL(rawUrl);
  const sslmode = parsed.searchParams.get("sslmode");
  const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  const useSsl =
    sslmode === "require" || sslmode === "verify-ca" || sslmode === "verify-full" || !isLocalHost;
  // Strip sslmode from the URL so it doesn't conflict with the ssl constructor
  // option — pg v8 parses sslmode itself and can override the ssl object.
  parsed.searchParams.delete("sslmode");
  return {
    connectionString: parsed.toString(),
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  };
}
