import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from './auth.js';

/**
 * Idempotent writes. A client sends `Idempotency-Key` on a write; the first
 * completed answer for (user, key) is kept for 24 hours and a repeat of the
 * same request gets that answer back instead of writing again. Two requests
 * with the same key that arrive together (a same-tick triple click) share the
 * first one's execution.
 *
 * P2 R05: the answers live in the `idempotency_keys` table (migration 0027,
 * `DbIdempotencyStore`), so an API restart, a second API process or a new login
 * of the same user still replays a completed write. P0 R05's in-process
 * `IdempotencyStore` is kept for the store unit tests and as a fallback.
 *
 * Rules shared by both stores:
 * - the scope is the signed-in user id, so a key never replays another user's
 *   answer; requests without a valid session are not cached (app.ts).
 * - only 2xx answers up to 256 KiB are kept: a refusal or an outage is
 *   forgotten, so a corrected or retried submit really runs again.
 * - the same key with a different request is `mismatch` (422 REUSED).
 * The DB unique constraints (409 DUPLICATE) remain the last duplicate guard.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** P2 R05: a pending row older than this belongs to a process that died. */
export const IDEMPOTENCY_LEASE_MS = 120 * 1000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const MAX_ENTRIES = 5000;
const MAX_CACHED_BODY_BYTES = 256 * 1024;

export interface StoredResponse {
  status: number;
  body: string;
  contentType: string | null;
}

interface Entry {
  fingerprint: string;
  expiresAt: number;
  pending: Promise<StoredResponse | null> | null;
  response: StoredResponse | null;
}

export type IdempotencyLookup =
  | { kind: 'execute'; complete: (response: StoredResponse | null) => void | Promise<void> }
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'wait'; pending: Promise<StoredResponse | null> }
  | { kind: 'mismatch' }
  /** P2 R05 M1: a pending row whose holder stopped renewing it — the outcome is unknown. */
  | { kind: 'unknown' };

/**
 * What the app middleware needs from a store. The first caller of (scope, key)
 * gets `execute` and must call `complete` exactly once with the answer to keep
 * (or null to forget it). `wait` resolves to the first request's kept answer,
 * or null when it was forgotten (the caller then begins again).
 */
export interface IdempotencyBackend {
  begin(scope: string, key: string, fingerprint: string): IdempotencyLookup | Promise<IdempotencyLookup>;
}

function isKeptResponse(response: StoredResponse | null): response is StoredResponse {
  // Only a successful write is replayed. A refusal (4xx) or an outage (5xx)
  // is forgotten so a corrected or retried submit really runs.
  return response !== null && response.status >= 200 && response.status < 300
    && Buffer.byteLength(response.body, 'utf8') <= MAX_CACHED_BODY_BYTES;
}

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** P0 R05: in-process store (one process, forgotten on restart). */
export class IdempotencyStore implements IdempotencyBackend {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * Looks up (scope, key). The first caller gets `execute` and must call
   * `complete` exactly once with the answer to keep (or null to forget it).
   */
  begin(scope: string, key: string, fingerprint: string): IdempotencyLookup {
    this.sweep();
    const id = `${scope}\u0000${key}`;
    const existing = this.entries.get(id);
    if (existing && existing.expiresAt > this.now()) {
      if (existing.fingerprint !== fingerprint) return { kind: 'mismatch' };
      if (existing.response) return { kind: 'replay', response: existing.response };
      if (existing.pending) return { kind: 'wait', pending: existing.pending };
    }
    let resolve!: (value: StoredResponse | null) => void;
    const pending = new Promise<StoredResponse | null>((done) => { resolve = done; });
    const entry: Entry = { fingerprint, expiresAt: this.now() + IDEMPOTENCY_TTL_MS, pending, response: null };
    this.entries.set(id, entry);
    return {
      kind: 'execute',
      complete: (response) => {
        const keep = isKeptResponse(response);
        if (keep) {
          entry.response = response;
          entry.pending = null;
        } else if (this.entries.get(id) === entry) {
          this.entries.delete(id);
        }
        resolve(keep ? response : null);
      }
    };
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now && entry.pending === null) this.entries.delete(id);
    }
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export interface DbIdempotencyStoreOptions {
  /** How long a pending row stays alive without a heartbeat from its holder. */
  leaseMs?: number;
  /** How often the holder renews its lease (default leaseMs / 3; Infinity: never, tests only). */
  heartbeatMs?: number;
  /** How long a completed answer is replayed. */
  ttlMs?: number;
  /** How often a request waiting on another process's pending row re-reads it. */
  pollIntervalMs?: number;
  /** The least time between two sweeps of expired rows from this store (Infinity: never). */
  sweepIntervalMs?: number;
}

interface KeyRow {
  fingerprint: string;
  state: 'pending' | 'completed';
  response_status: number | null;
  response_body: string | null;
  response_content_type: string | null;
  /** Exact lease timestamp as text: the fencing token of the current holder. */
  lease: string;
  expired: boolean;
  lease_over: boolean;
}

interface LocalExecution {
  pending: Promise<StoredResponse | null>;
}

const SWEEP_BATCH = 1000;
const MAX_CLAIM_ATTEMPTS = 8;

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown';
}

/**
 * P2 R05: the `idempotency_keys` table store, shared by every API process.
 *
 * - Claim: INSERT ... ON CONFLICT DO NOTHING RETURNING — one request wins the
 *   key atomically. The loser reads the row: a different fingerprint is
 *   `mismatch`, a completed row `replay`, a pending row `wait`.
 * - Expired rows (expires_at) are deleted (conditionally on still being
 *   expired) and the key is claimed again.
 * - Lease and heartbeat (review M1): while the holder runs it renews its lease
 *   every leaseMs / 3. A pending row whose lease ran out belongs to a holder
 *   that died or lost the database mid-write, so its outcome is unknown: it is
 *   never taken over or run again (fail closed, `unknown`) until it expires.
 * - Fencing: the holder's current lease timestamp is its token. A renewal,
 *   `complete`'s store or its delete touches the row only while it still
 *   carries that token.
 * - Waiting: a request of this process always waits on the holder's in-memory
 *   promise, whatever the lease says; one of another process polls the row
 *   until it is completed (replay), gone (begin again) or its lease ran out
 *   (begin again, which then answers `unknown`).
 * - All times are the database's now(), so process clocks never disagree.
 * - A database failure in `begin` is thrown (the app answers 503); a failure in
 *   `complete` or in a renewal is logged without data and swallowed, because
 *   the user's answer already exists — the row then stays `unknown` until it
 *   expires.
 */
export class DbIdempotencyStore implements IdempotencyBackend {
  private readonly leaseMs: number;
  private readonly ttlMs: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatMs: number;
  private readonly sweepIntervalMs: number;
  private readonly local = new Map<string, LocalExecution>();
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly db: Pick<AppDatabase, 'execute'>, options: DbIdempotencyStoreOptions = {}) {
    this.leaseMs = Math.max(1, Math.round(options.leaseMs ?? IDEMPOTENCY_LEASE_MS));
    this.ttlMs = Math.max(1, Math.round(options.ttlMs ?? IDEMPOTENCY_TTL_MS));
    this.pollIntervalMs = Math.max(10, Math.round(options.pollIntervalMs ?? 150));
    this.heartbeatMs = Math.max(10, options.heartbeatMs ?? Math.floor(this.leaseMs / 3));
    this.sweepIntervalMs = Math.max(0, options.sweepIntervalMs ?? 60_000);
  }

  async begin(userId: string, key: string, fingerprint: string): Promise<IdempotencyLookup> {
    await this.maybeSweep();
    const id = `${userId}\u0000${key}`;
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
      const [claimed] = rowsOf<{ lease: string }>(await this.db.execute(sql`
        insert into idempotency_keys (user_id, idempotency_key, fingerprint, state, lease_expires_at, expires_at)
        values (${userId}, ${key}, ${fingerprint}, 'pending',
                now() + ${this.leaseMs}::integer * interval '1 millisecond',
                now() + ${this.ttlMs}::integer * interval '1 millisecond')
        on conflict (user_id, idempotency_key) do nothing
        returning lease_expires_at::text as lease
      `));
      if (claimed) return this.execute(id, userId, key, fingerprint, claimed.lease);

      const row = await this.read(userId, key);
      if (!row) continue; // deleted in between: claim again
      if (row.expired) {
        await this.db.execute(sql`
          delete from idempotency_keys
          where user_id = ${userId} and idempotency_key = ${key} and expires_at <= now()
        `);
        continue;
      }
      if (row.fingerprint !== fingerprint) return { kind: 'mismatch' };
      if (row.state === 'completed') return { kind: 'replay', response: this.responseOf(row) };
      // Review M1: a holder in this process is still running — wait for it
      // whatever its lease says, so a slow write never runs twice.
      const sameProcess = this.local.get(id);
      if (sameProcess) return { kind: 'wait', pending: sameProcess.pending };
      // No heartbeat any more: the holder died mid-write. Never run it again.
      if (row.lease_over) return { kind: 'unknown' };
      return { kind: 'wait', pending: this.poll(id, userId, key, fingerprint) };
    }
    throw new Error('idempotency key claim did not settle');
  }

  /** Deletes up to one batch of expired rows; answers how many went. */
  async sweepExpired(): Promise<number> {
    const result = await this.db.execute(sql`
      delete from idempotency_keys
      where ctid in (
        select ctid from idempotency_keys where expires_at < now() limit ${SWEEP_BATCH}
      )
    `);
    return (result as unknown as { rowCount?: number | null }).rowCount ?? 0;
  }

  private async maybeSweep(): Promise<void> {
    const now = Date.now();
    if (!Number.isFinite(this.sweepIntervalMs) || now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    try {
      await this.sweepExpired();
    } catch (error) {
      console.error(`[idempotency] expired-row sweep failed: ${errorCode(error)}`);
    }
  }

  private async read(userId: string, key: string): Promise<KeyRow | undefined> {
    const [row] = rowsOf<KeyRow>(await this.db.execute(sql`
      select fingerprint, state, response_status, response_body, response_content_type,
             lease_expires_at::text as lease,
             expires_at <= now() as expired,
             lease_expires_at <= now() as lease_over
      from idempotency_keys
      where user_id = ${userId} and idempotency_key = ${key}
    `));
    return row;
  }

  private responseOf(row: KeyRow): StoredResponse {
    return {
      status: Number(row.response_status),
      body: row.response_body ?? '',
      contentType: row.response_content_type
    };
  }

  private execute(id: string, userId: string, key: string, fingerprint: string, claimedLease: string): IdempotencyLookup {
    let resolve!: (value: StoredResponse | null) => void;
    const pending = new Promise<StoredResponse | null>((done) => { resolve = done; });
    const entry: LocalExecution = { pending };
    this.local.set(id, entry);
    let completed = false;
    let lease = claimedLease;
    let beat: Promise<void> | null = null;
    const timer = Number.isFinite(this.heartbeatMs)
      ? setInterval(() => {
        if (completed || beat) return;
        beat = this.renew(userId, key, fingerprint, lease)
          .then((renewed) => {
            if (completed) return;
            if (renewed) lease = renewed;
            else if (renewed === null && timer) clearInterval(timer); // the row is no longer ours
          })
          .finally(() => { beat = null; });
      }, this.heartbeatMs)
      : null;
    timer?.unref?.();
    return {
      kind: 'execute',
      complete: async (response) => {
        if (completed) return;
        completed = true;
        if (timer) clearInterval(timer);
        // A renewal in flight may still move the token: settle with its result.
        if (beat) await beat;
        const keep = isKeptResponse(response);
        try {
          await this.settle(userId, key, fingerprint, lease, keep ? response : null);
        } finally {
          if (this.local.get(id) === entry) this.local.delete(id);
          resolve(keep ? response : null);
        }
      }
    };
  }

  /**
   * Moves our own row's lease forward. Answers the new token, null when the row
   * is no longer ours (gone or changed), undefined on a database failure (the
   * next beat tries again). Never throws.
   */
  private async renew(userId: string, key: string, fingerprint: string, lease: string): Promise<string | null | undefined> {
    try {
      const [renewed] = rowsOf<{ lease: string }>(await this.db.execute(sql`
        update idempotency_keys
        set lease_expires_at = now() + ${this.leaseMs}::integer * interval '1 millisecond'
        where user_id = ${userId} and idempotency_key = ${key} and fingerprint = ${fingerprint}
          and state = 'pending' and lease_expires_at = ${lease}::timestamptz
        returning lease_expires_at::text as lease
      `));
      return renewed ? renewed.lease : null;
    } catch (error) {
      console.error(`[idempotency] lease renewal failed: ${errorCode(error)}`);
      return undefined;
    }
  }

  /** Stores the kept answer on our own row, or deletes our own row. Never throws. */
  private async settle(userId: string, key: string, fingerprint: string, lease: string, response: StoredResponse | null): Promise<void> {
    const ownRow: SQL = sql`user_id = ${userId} and idempotency_key = ${key} and fingerprint = ${fingerprint}
      and state = 'pending' and lease_expires_at = ${lease}::timestamptz`;
    if (response) {
      try {
        await this.db.execute(sql`
          update idempotency_keys
          set state = 'completed', response_status = ${response.status}, response_body = ${response.body},
              response_content_type = ${response.contentType}, completed_at = now()
          where ${ownRow}
        `);
        return;
      } catch (error) {
        console.error(`[idempotency] storing the answer failed: ${errorCode(error)}`);
      }
    }
    try {
      await this.db.execute(sql`delete from idempotency_keys where ${ownRow}`);
    } catch (error) {
      console.error(`[idempotency] releasing the key failed: ${errorCode(error)}`);
    }
  }

  /** Waits for another process's pending row; null means "begin again". */
  private async poll(id: string, userId: string, key: string, fingerprint: string): Promise<StoredResponse | null> {
    const deadline = Date.now() + this.leaseMs + this.pollIntervalMs;
    while (Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, this.pollIntervalMs));
      const sameProcess = this.local.get(id);
      if (sameProcess) return sameProcess.pending; // this process claimed it again meanwhile
      const row = await this.read(userId, key);
      if (!row || row.fingerprint !== fingerprint || row.expired) return null;
      if (row.state === 'completed') return this.responseOf(row);
      if (row.lease_over) return null;
    }
    return null;
  }
}
