import { createHash } from 'node:crypto';

/**
 * P0 R05: idempotent writes within what this release can support without a
 * migration. A client sends `Idempotency-Key` on a write; the first completed
 * answer for (session, key) is kept in this process for 24 hours and a repeat
 * of the same request gets that answer back instead of writing again. Two
 * requests with the same key that arrive together (a same-tick triple click)
 * share the first one's execution.
 *
 * Scope and limits (recorded in REPORT.md):
 * - in memory, one API process: a restart forgets the keys, and several API
 *   processes would not share them. The DB unique constraints (409 DUPLICATE)
 *   remain the durable guard.
 * - the scope is the SHA-256 of the session token, so a key never replays
 *   another user's answer; requests without a session cookie are not cached.
 * - only 2xx answers are kept: a refusal or an outage is forgotten, so a
 *   corrected or retried submit really runs again.
 * - only valid sessions are cached, and bodies larger than the upload limit are
 *   not read by this layer.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
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
  | { kind: 'execute'; complete: (response: StoredResponse | null) => void }
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'wait'; pending: Promise<StoredResponse | null> }
  | { kind: 'mismatch' };

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export class IdempotencyStore {
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
        // Only a successful write is replayed. A refusal (4xx) or an outage
        // (5xx) is forgotten so a corrected or retried submit really runs.
        const keep = response !== null && response.status >= 200 && response.status < 300
          && Buffer.byteLength(response.body, 'utf8') <= MAX_CACHED_BODY_BYTES;
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
