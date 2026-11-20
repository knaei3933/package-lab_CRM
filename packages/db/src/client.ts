import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableName } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schema from './schema.js';

// Tables the database itself keeps append-only with BEFORE UPDATE / BEFORE DELETE
// triggers (migrations 0001, 0003, 0005, 0007 and 0010). The triggers stay
// authoritative for raw SQL, but drizzle rewraps their exception in a generic
// "Failed query" message and the original reason only survives in error.cause.
// The guard below rejects these writes in the client before they reach the
// database so callers see the table name and the real reason in error.message.
const APPEND_ONLY_TABLES: ReadonlySet<string> = new Set([
  'artwork_approval_events',
  'artwork_revisions',
  'audit_events',
  'delivery_confirmations',
  'document_versions',
  'evidence_manual_verifications',
  'filling_deliveries',
  'film_deliveries',
  'maker_po_events',
  'pre_order_references'
]);

function appendOnlyTableOf(table: unknown): string | null {
  if (!table || typeof table !== 'object') return null;
  try {
    const tableName = getTableName(table as Parameters<typeof getTableName>[0]);
    return APPEND_ONLY_TABLES.has(tableName) ? tableName : null;
  } catch {
    return null;
  }
}

// The rejection surfaces when the query builder is awaited, not while the chain is
// built: callers construct `db.update(t).set(...).where(...)` first and only then
// await it, so a synchronous throw would bypass their try/catch and `.rejects`.
// The builder poses as a promise (it inherits Promise.prototype) and creates the
// rejected promise only once it is actually awaited or executed, so a builder that
// is never awaited stays silent.
function rejectedAppendOnlyMutation(tableName: string, operation: 'update' | 'delete'): PromiseLike<never> {
  const verb = operation === 'delete' ? 'deleting' : 'updating';
  const message = `${tableName} is append-only: create events instead of ${verb}`;

  let rejection: Promise<never> | null = null;
  const reject = (): Promise<never> => {
    rejection ??= Promise.reject(new Error(message));
    return rejection;
  };

  const builder = new Proxy(Object.create(Promise.prototype), {
    get: (_target, prop) => {
      if (prop === 'then') {
        return (
          onFulfilled?: ((value: never) => unknown) | null,
          onRejected?: ((reason: unknown) => unknown) | null
        ) => reject().then(onFulfilled, onRejected);
      }
      if (prop === 'catch') {
        return (onRejected?: ((reason: unknown) => unknown) | null) => reject().catch(onRejected);
      }
      if (prop === 'finally') {
        return (onFinally?: (() => void) | null) => reject().finally(onFinally);
      }
      if (prop === 'execute') return () => reject();
      if (typeof prop === 'symbol') return undefined;
      return () => builder;
    }
  });
  return builder as unknown as PromiseLike<never>;
}

// Drizzle clients handed out to application code reject append-only UPDATE / DELETE
// up front and pass everything else through unchanged.
function guardAppendOnlyWrites<Client extends object>(client: Client): Client {
  return new Proxy(client, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if ((prop === 'update' || prop === 'delete') && typeof value === 'function') {
        const operation: 'update' | 'delete' = prop;
        const mutate = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          const tableName = appendOnlyTableOf(args[0]);
          return tableName ? rejectedAppendOnlyMutation(tableName, operation) : mutate.apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
}

/**
 * P0 R04: a database that is down or hanging must fail fast instead of making
 * every request wait forever. `connectionTimeoutMillis` bounds both opening a
 * connection and waiting for a free pool client; `statement_timeout` makes the
 * server cancel one statement that runs too long (SQLSTATE 57014). The API maps
 * both to DB_UNAVAILABLE / DB_TIMEOUT. Values are starting points; operators
 * may override them with DB_CONNECT_TIMEOUT_MS / DB_STATEMENT_TIMEOUT_MS.
 */
export const DEFAULT_DB_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_DB_STATEMENT_TIMEOUT_MS = 10_000;

export interface DatabaseOptions {
  connectionTimeoutMillis?: number;
  statementTimeoutMs?: number;
  max?: number;
}

function positiveIntegerFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function createDatabase(databaseUrl: string, options: DatabaseOptions = {}) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis
      ?? positiveIntegerFromEnv('DB_CONNECT_TIMEOUT_MS')
      ?? DEFAULT_DB_CONNECT_TIMEOUT_MS,
    statement_timeout: options.statementTimeoutMs
      ?? positiveIntegerFromEnv('DB_STATEMENT_TIMEOUT_MS')
      ?? DEFAULT_DB_STATEMENT_TIMEOUT_MS
  });
  // An idle client that loses its connection emits 'error' on the pool; without
  // a listener that would crash the process instead of failing one request.
  pool.on('error', (error) => {
    console.error('[db] idle client error:', error.message);
  });
  return { db: guardAppendOnlyWrites(drizzle(pool, { schema })), pool };
}
