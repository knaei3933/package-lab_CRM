import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';

/**
 * P2 review M-4 / re-review N-4: this API build reads columns, tables and
 * triggers that only exist after its migrations. Started against a database
 * that lacks them it answered every login with 500 while /api/health said ok.
 * The server checks drizzle's migration ledger before it listens and refuses
 * to start with a message that names the fix.
 *
 * What is checked (the journal shipped with this build is the source):
 * - presence: every journal migration has its ledger row (by its timestamp,
 *   which is how drizzle records a migration) — a missing middle one is found,
 *   not only an old latest one;
 * - content: for the P2 migrations (CONTENT_CHECKED_FROM and later) the ledger
 *   hash equals sha256 of this build's file, exactly as drizzle computed it
 *   when applying. Older migrations are checked for presence only: on the main
 *   copy the applied hashes of 0011/0015/0016/0018 differ from today's files
 *   (those files were edited after they were applied, comments and replay
 *   guards), so their hashes cannot identify them.
 */
export const CONTENT_CHECKED_FROM = '0025_p2_delivery_dates_and_seven_po_facts';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../../packages/db/drizzle/', import.meta.url));

export interface RequiredMigration {
  tag: string;
  createdAt: number;
  /** sha256 of the file as drizzle hashes it; null when only presence is checked. */
  hash: string | null;
}

/** The migrations this build needs, read from its own journal and files. */
export function requiredMigrations(migrationsDir: string = DEFAULT_MIGRATIONS_DIR): RequiredMigration[] {
  const journal = JSON.parse(readFileSync(`${migrationsDir}/meta/_journal.json`, 'utf8')) as {
    entries: Array<{ tag: string; when: number }>;
  };
  let contentChecked = false;
  return journal.entries.map((entry) => {
    if (entry.tag === CONTENT_CHECKED_FROM) contentChecked = true;
    return {
      tag: entry.tag,
      createdAt: entry.when,
      hash: contentChecked
        ? createHash('sha256').update(readFileSync(`${migrationsDir}/${entry.tag}.sql`).toString()).digest('hex')
        : null
    };
  });
}

export type SchemaPreflight =
  | { ok: true; applied: number; required: number }
  | {
      ok: false;
      reason: 'migrations_table_missing' | 'migrations_missing' | 'migration_content_mismatch';
      missing: string[];
      mismatched: string[];
      message: string;
    };

type Execute = (query: ReturnType<typeof sql>) => Promise<unknown>;

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) ?? [];
}

/** Reads drizzle's ledger and compares it with this build's journal. A database error is thrown. */
export async function checkSchemaPreflight(
  db: { execute: Execute },
  required: readonly RequiredMigration[] = requiredMigrations()
): Promise<SchemaPreflight> {
  const fix = 'run "npm run db:migrate" with this build\'s migrations first, then start the API';
  const [ledger] = rowsOf<{ present: boolean }>(await db.execute(sql`
    select to_regclass('drizzle.__drizzle_migrations') is not null as present
  `));
  if (!ledger?.present) {
    return {
      ok: false, reason: 'migrations_table_missing', missing: required.map((entry) => entry.tag), mismatched: [],
      message: `the database has no migration ledger; ${fix}`
    };
  }
  const rows = rowsOf<{ createdAt: string | null; hash: string }>(await db.execute(sql`
    select created_at::text as "createdAt", hash from drizzle.__drizzle_migrations
  `));
  const applied = new Map<number, string[]>();
  for (const row of rows) {
    if (row.createdAt === null) continue;
    const at = Number(row.createdAt);
    applied.set(at, [...(applied.get(at) ?? []), row.hash]);
  }
  const missing = required.filter((entry) => !applied.has(entry.createdAt)).map((entry) => entry.tag);
  if (missing.length > 0) {
    return {
      ok: false, reason: 'migrations_missing', missing, mismatched: [],
      message: `the database is missing ${missing.length} migration(s) this API needs (first: ${missing[0]}); ${fix}`
    };
  }
  const mismatched = required
    .filter((entry) => entry.hash !== null && !(applied.get(entry.createdAt) ?? []).includes(entry.hash))
    .map((entry) => entry.tag);
  if (mismatched.length > 0) {
    return {
      ok: false, reason: 'migration_content_mismatch', missing: [], mismatched,
      message: `the applied content of ${mismatched.join(', ')} differs from this API build's migration files; deploy the API that matches the database (or migrate a database for this build)`
    };
  }
  return { ok: true, applied: rows.length, required: required.length };
}
