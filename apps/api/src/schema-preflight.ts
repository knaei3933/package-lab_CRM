import { sql } from 'drizzle-orm';

/**
 * P2 review M-4: this API build reads columns and tables that only exist after
 * migration 0032. Started against an older database it answered every login
 * with 500 while /api/health still said ok, so a wrong deployment order went
 * unnoticed. The server now checks the applied migrations before it listens
 * and refuses to start with a message that names the fix.
 *
 * REQUIRED_MIGRATION must be the last entry of packages/db/drizzle/meta/_journal.json
 * (tests/db/p2-review-preflight.test.ts keeps the two equal).
 */
export const REQUIRED_MIGRATION = {
  tag: '0032_p2_auditor_session_guard',
  createdAt: 1796768760000
} as const;

export type SchemaPreflight =
  | { ok: true; latestApplied: number }
  | { ok: false; reason: 'migrations_table_missing' | 'migrations_behind'; latestApplied: number | null; message: string };

type Execute = (query: ReturnType<typeof sql>) => Promise<unknown>;

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) ?? [];
}

/** Reads drizzle's migration ledger. A database error (unreachable) is thrown to the caller. */
export async function checkSchemaPreflight(db: { execute: Execute }): Promise<SchemaPreflight> {
  const [ledger] = rowsOf<{ present: boolean }>(await db.execute(sql`
    select to_regclass('drizzle.__drizzle_migrations') is not null as present
  `));
  if (!ledger?.present) {
    return {
      ok: false,
      reason: 'migrations_table_missing',
      latestApplied: null,
      message: `the database has no migration ledger; run "npm run db:migrate" (needs ${REQUIRED_MIGRATION.tag}) before starting the API`
    };
  }
  const [latest] = rowsOf<{ latest: string | null }>(await db.execute(sql`
    select max(created_at)::text as latest from drizzle.__drizzle_migrations
  `));
  const latestApplied = latest?.latest === null || latest?.latest === undefined ? null : Number(latest.latest);
  if (latestApplied === null || latestApplied < REQUIRED_MIGRATION.createdAt) {
    return {
      ok: false,
      reason: 'migrations_behind',
      latestApplied,
      message: `the database schema is older than this API (needs ${REQUIRED_MIGRATION.tag}); run "npm run db:migrate" first, then start the API`
    };
  }
  return { ok: true, latestApplied };
}
