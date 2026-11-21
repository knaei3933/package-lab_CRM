/**
 * P2 migrations 0025–0031 (representative approval 2026-11-21) on scratch
 * databases only. Every database this file creates is named
 * kanei_crm_mvp_migration_p2_* on the test server and is dropped in afterAll;
 * kanei_crm_mvp_test itself is only used to derive the connection.
 *
 * Covers: (1) a fresh run to 32 migrations with the new tables, columns, enum
 * values and the widened users_role_valid; (2) an upgrade from 0024 with real
 * rows: original columns unchanged, maker PO numbers backfilled with the P1
 * rank formula; (3) replaying the seven P2 files is harmless; (4) the number
 * trigger under concurrency, rollback and the JST year boundary; (5) the CHECKs
 * of the new tables and column.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;
const SCRATCH_PREFIX = 'kanei_crm_mvp_migration_p2_';

const sourceUrl = (() => {
  const url = new URL(process.env.DATABASE_URL!);
  url.hostname = '127.0.0.1';
  url.port = '5434';
  url.pathname = '/kanei_crm_mvp_test';
  return url.toString();
})();

function urlFor(database: string): string {
  const url = new URL(sourceUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

const createdDatabases: string[] = [];
const openPools: pg.Pool[] = [];

async function createScratchDatabase(suffix: string): Promise<string> {
  const name = `${SCRATCH_PREFIX}${suffix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (!name.startsWith(SCRATCH_PREFIX) || !/^[a-z0-9_]+$/.test(name) || name.length > 63) {
    throw new Error(`refusing scratch database name ${name}`);
  }
  const admin = new Pool({ connectionString: urlFor('postgres') });
  try {
    await admin.query(`create database "${name}"`);
    createdDatabases.push(name);
  } finally {
    await admin.end();
  }
  return name;
}

async function dropScratchDatabase(name: string): Promise<void> {
  if (!name.startsWith(SCRATCH_PREFIX)) throw new Error(`refusing to drop ${name}`);
  const admin = new Pool({ connectionString: urlFor('postgres') });
  try {
    await admin.query(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end();
  }
}

function poolFor(database: string, max = 4): pg.Pool {
  const pool = new Pool({ connectionString: urlFor(database), max });
  openPools.push(pool);
  return pool;
}

const MIGRATIONS = path.resolve(process.cwd(), 'packages/db/drizzle');
const P2_FILES = [
  '0025_p2_delivery_dates_and_seven_po_facts.sql',
  '0026_p2_maker_recipient_addresses.sql',
  '0027_p2_idempotency_keys.sql',
  '0028_p2_maker_po_display_numbers.sql',
  '0029_p2_user_display_language.sql',
  '0030_p2_artwork_submission_document_type.sql',
  '0031_p2_auditor_role.sql',
  // P2 review M-3: the auditor session guard (triggers only).
  '0032_p2_auditor_session_guard.sql'
];
const P2_TABLES = ['idempotency_keys', 'maker_po_display_numbers', 'maker_recipient_addresses', 'seven_po_order_facts'];

let tempRoot = '';
let fullFolder = '';
let through0024Folder = '';

async function copyMigrations(target: string): Promise<void> {
  await cp(MIGRATIONS, target, { recursive: true, filter: (candidate) => !candidate.split(path.sep).includes('.omc') });
}

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'kanei-p2-migration-'));
  fullFolder = path.join(tempRoot, 'full');
  through0024Folder = path.join(tempRoot, 'through-0024');
  await copyMigrations(fullFolder);
  await copyMigrations(through0024Folder);
  const journalPath = path.join(through0024Folder, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: Array<{ idx: number }> };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 24);
  await writeFile(journalPath, JSON.stringify(journal, null, 2));
});

afterAll(async () => {
  for (const pool of openPools) await pool.end().catch(() => undefined);
  if (process.env.KEEP_MIGRATION_SCRATCH_DB !== '1') {
    for (const name of createdDatabases) await dropScratchDatabase(name);
  }
});

async function migrationCount(pool: pg.Pool): Promise<number> {
  const result = await pool.query('select count(*)::int as n from drizzle.__drizzle_migrations');
  return result.rows[0].n as number;
}

async function enumLabels(pool: pg.Pool, typeName: string): Promise<string[]> {
  const result = await pool.query(
    `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder`,
    [typeName]
  );
  return result.rows.map((row) => row.enumlabel as string);
}

async function pgError(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
  throw new Error('expected the statement to fail');
}

/** Minimal rows a maker PO needs, inserted with plain SQL (works on 0024 and on 0031). */
async function seedBase(pool: pg.Pool, tag: string) {
  const ids = {
    admin: randomUUID(), staff: randomUUID(), customer: randomUUID(), seven: randomUUID(), maker: randomUUID(),
    project: randomUUID(), sevenPo: randomUUID(), order1: randomUUID(), order2: randomUUID(), order3: randomUUID()
  };
  await pool.query(
    `insert into users (id, username, password_hash, display_name, role) values
       ($1, $3, 'not-a-login-hash', '合成代表P2M', 'admin'), ($2, $4, 'not-a-login-hash', '合成担当P2M', 'staff')`,
    [ids.admin, ids.staff, `p2m_admin_${tag}`, `p2m_staff_${tag}`]
  );
  await pool.query(
    `insert into accounts (id, name, role, external_code) values
       ($1, $4, 'end_customer', $7), ($2, $5, 'seven', $8), ($3, $6, 'maker', $9)`,
    [ids.customer, ids.seven, ids.maker, `合成顧客${tag}`, `合成セブン${tag}`, `合成メーカー${tag}`, `C-${tag}`, `S-${tag}`, `M-${tag}`]
  );
  await pool.query(
    `insert into projects (id, code, name, business_unit, route, lead_source, end_customer_account_id, seven_account_id, maker_account_id, created_by_user_id)
     values ($1, $2, $3, 'F1', 'F1', 'KANEI', $4, $5, $6, $7)`,
    [ids.project, `P2M-${tag}`, `合成P2M-${tag}`, ids.customer, ids.seven, ids.maker, ids.admin]
  );
  await pool.query(
    `insert into seven_purchase_orders (id, project_id, po_number, created_by_user_id) values ($1, $2, $3, $4)`,
    [ids.sevenPo, ids.project, `SEVEN-P2M-${tag}`, ids.staff]
  );
  for (const [index, orderId] of [ids.order1, ids.order2, ids.order3].entries()) {
    await pool.query(
      `insert into film_supply_orders (id, project_id, code, seven_purchase_order_id, created_by_user_id) values ($1, $2, $3, $4, $5)`,
      [orderId, ids.project, `FSO-P2M-${tag}-${index + 1}`, ids.sevenPo, ids.staff]
    );
  }
  return ids;
}

const SHA = 'a'.repeat(64);

function insertMakerPo(executor: pg.Pool | pg.PoolClient, input: { id?: string; orderId: string; userId: string; createdAt: string; status?: string }) {
  return executor.query(
    `insert into maker_purchase_orders (id, film_supply_order_id, snapshot, snapshot_sha256, status, created_by_user_id, created_at, updated_at)
     values ($1, $2, '{"order":{"code":"x"}}'::jsonb, $3, $4, $5, $6, $6)`,
    [input.id ?? randomUUID(), input.orderId, SHA, input.status ?? 'CANCELLED', input.userId, input.createdAt]
  );
}

async function numberOf(pool: pg.Pool, makerPoId: string): Promise<string | undefined> {
  const result = await pool.query('select display_number from maker_po_display_numbers where maker_purchase_order_id = $1', [makerPoId]);
  return result.rows[0]?.display_number as string | undefined;
}

/** Every row of a table as JSON text, in a stable order. */
async function tableRows(pool: pg.Pool, table: string, orderBy: string): Promise<Array<Record<string, unknown>>> {
  const result = await pool.query(`select row_to_json(t) as row from (select * from "${table}" order by ${orderBy}) t`);
  return result.rows.map((row) => row.row as Record<string, unknown>);
}

const ORIGINAL_TABLES: Array<[string, string]> = [
  ['users', 'id'], ['accounts', 'id'], ['projects', 'id'], ['seven_purchase_orders', 'id'],
  ['film_supply_orders', 'id'], ['maker_purchase_orders', 'id']
];
const P2_NEW_COLUMNS: Record<string, string[]> = {
  users: ['display_language'],
  film_supply_orders: ['requested_delivery_date', 'planned_delivery_date']
};

function withoutColumns(rows: Array<Record<string, unknown>>, columns: string[]) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !columns.includes(key))));
}

/** The P1 (pre-0028) formula, verbatim from the P1 API: rank by (created_at, id) within the JST year. */
const P1_RANK_SQL = `
  select id::text as id, year::int as year, seq::int as seq from (
    select id,
           extract(year from (created_at at time zone 'Asia/Tokyo'))::int as year,
           row_number() over (
             partition by extract(year from (created_at at time zone 'Asia/Tokyo'))
             order by created_at, id
           ) as seq
    from maker_purchase_orders
  ) ranked`;

// --------------------------------------------------------------- (1) fresh
describe('P2 migrations on an empty database', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = poolFor(await createScratchDatabase('fresh'));
    await migrate(drizzle(pool), { migrationsFolder: fullFolder });
  });

  it('records all 33 migrations, ending with 0032', async () => {
    expect(await migrationCount(pool)).toBe(33);
    const last = await pool.query('select created_at::text as created_at from drizzle.__drizzle_migrations order by id desc limit 1');
    expect(last.rows[0].created_at).toBe('1796768760000');
  });

  it('creates the four P2 tables', async () => {
    const result = await pool.query(
      `select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1::text[]) order by table_name`,
      [P2_TABLES]
    );
    expect(result.rows.map((row) => row.table_name)).toEqual(P2_TABLES);
  });

  it('adds the three P2 columns with their types', async () => {
    const result = await pool.query(`
      select table_name, column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'film_supply_orders' and column_name in ('requested_delivery_date', 'planned_delivery_date'))
           or (table_name = 'users' and column_name = 'display_language'))
       order by table_name, column_name`);
    expect(result.rows).toEqual([
      { table_name: 'film_supply_orders', column_name: 'planned_delivery_date', data_type: 'date', is_nullable: 'YES' },
      { table_name: 'film_supply_orders', column_name: 'requested_delivery_date', data_type: 'date', is_nullable: 'YES' },
      { table_name: 'users', column_name: 'display_language', data_type: 'text', is_nullable: 'YES' }
    ]);
  });

  it('adds artwork_submission and auditor as the last enum values', async () => {
    const documentTypes = await enumLabels(pool, 'document_type');
    expect(documentTypes.at(-1)).toBe('artwork_submission');
    const roles = await enumLabels(pool, 'user_role');
    expect(roles).toEqual(['admin', 'staff', 'viewer', 'auditor']);
  });

  it('lets users_role_valid accept an auditor user', async () => {
    const id = randomUUID();
    await pool.query(
      `insert into users (id, username, password_hash, display_name, role) values ($1, $2, 'x', '合成監査P2M', 'auditor')`,
      [id, `p2m_auditor_${id.slice(0, 8)}`]
    );
    const stored = await pool.query('select role::text as role from users where id = $1', [id]);
    expect(stored.rows[0].role).toBe('auditor');
    const definition = await pool.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'users_role_valid'`);
    expect(definition.rows).toHaveLength(1);
    expect(definition.rows[0].def).toMatch(/'admin'.*'staff'.*'viewer'.*'auditor'/);
  });

  it('still refuses a role outside the vocabulary', async () => {
    const id = randomUUID();
    const error = await pgError(pool.query(
      `insert into users (id, username, password_hash, display_name, role) values ($1, $2, 'x', 'x', 'superuser')`,
      [id, `p2m_bad_${id.slice(0, 8)}`]
    ));
    expect(error.code).toBe('22P02');
  });

  it('installs the number trigger with a pinned search_path', async () => {
    const trigger = await pool.query(`
      select t.tgname, p.proconfig from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = 'maker_purchase_orders'::regclass and not t.tgisinternal and t.tgname = 'maker_purchase_orders_assign_display_number'`);
    expect(trigger.rows).toHaveLength(1);
    expect(trigger.rows[0].proconfig).toEqual(['search_path=pg_catalog, public']);
  });
});

// ------------------------------------------------- (2)(3) upgrade and replay
describe('P2 migrations on a database already at 0024 with real rows', () => {
  let pool: pg.Pool;
  let ids: Awaited<ReturnType<typeof seedBase>>;
  const before: Record<string, Array<Record<string, unknown>>> = {};
  // Maker POs chosen so that JST year, same-instant ties and insertion order all matter.
  const mpo = {
    a: '7a000000-0000-4000-8000-00000000000a',
    b: '7b000000-0000-4000-8000-00000000000b',
    c: '7c000000-0000-4000-8000-00000000000c',
    d: 'ffffffff-0000-4000-8000-00000000000d',
    e: '11111111-0000-4000-8000-00000000000e',
    f: '7f000000-0000-4000-8000-00000000000f'
  };

  beforeAll(async () => {
    pool = poolFor(await createScratchDatabase('upgrade'));
    await migrate(drizzle(pool), { migrationsFolder: through0024Folder });
    ids = await seedBase(pool, 'up');
    const rows: Array<[string, string, string, string]> = [
      [mpo.a, ids.order1, '2025-06-01T00:00:00.000Z', 'CANCELLED'],
      [mpo.b, ids.order1, '2025-12-31T14:59:59.000Z', 'CANCELLED'], // JST 2025-12-31 23:59:59
      [mpo.c, ids.order2, '2025-12-31T15:00:00.000Z', 'CANCELLED'], // JST 2026-01-01 00:00:00
      [mpo.d, ids.order2, '2026-03-01T00:00:00.000Z', 'CANCELLED'], // same instant as e, larger id
      [mpo.e, ids.order1, '2026-03-01T00:00:00.000Z', 'CANCELLED'],
      [mpo.f, ids.order3, '2026-01-01T00:00:00.000Z', 'DRAFT']
    ];
    for (const [id, orderId, createdAt, status] of rows) {
      await insertMakerPo(pool, { id, orderId, userId: ids.admin, createdAt, status });
    }
    for (const [table, orderBy] of ORIGINAL_TABLES) before[table] = await tableRows(pool, table, orderBy);
  });

  it('starts from exactly 25 applied migrations without the P2 objects', async () => {
    expect(await migrationCount(pool)).toBe(25);
    const tables = await pool.query(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = any($1::text[])`,
      [P2_TABLES]
    );
    expect(tables.rows[0].n).toBe(0);
  });

  describe('after 0025–0031', () => {
    beforeAll(async () => {
      await migrate(drizzle(pool), { migrationsFolder: fullFolder });
    });

    it('applies the eight new migrations (0025-0032)', async () => {
      expect(await migrationCount(pool)).toBe(33);
    });

    it('keeps every original column of every existing row unchanged', async () => {
      for (const [table, orderBy] of ORIGINAL_TABLES) {
        const after = await tableRows(pool, table, orderBy);
        expect(withoutColumns(after, P2_NEW_COLUMNS[table] ?? []), table).toEqual(before[table]);
      }
    });

    it('leaves the new columns of existing rows null', async () => {
      const orders = await pool.query('select requested_delivery_date, planned_delivery_date from film_supply_orders');
      expect(orders.rows).toHaveLength(3);
      for (const row of orders.rows) expect(row).toEqual({ requested_delivery_date: null, planned_delivery_date: null });
      const people = await pool.query('select display_language from users');
      for (const row of people.rows) expect(row.display_language).toBeNull();
    });

    it('backfills the maker PO numbers by JST year, then created_at, then id', async () => {
      const result = await pool.query('select maker_purchase_order_id::text as id, display_number from maker_po_display_numbers order by display_number');
      expect(Object.fromEntries(result.rows.map((row) => [row.id, row.display_number]))).toEqual({
        [mpo.a]: 'MPO-2025-0001',
        [mpo.b]: 'MPO-2025-0002',
        [mpo.c]: 'MPO-2026-0001',
        [mpo.f]: 'MPO-2026-0002',
        [mpo.e]: 'MPO-2026-0003',
        [mpo.d]: 'MPO-2026-0004'
      });
    });

    it('stores exactly the number the P1 rank formula computes', async () => {
      const ranked = await pool.query(P1_RANK_SQL);
      const stored = await pool.query('select maker_purchase_order_id::text as id, year, seq from maker_po_display_numbers');
      const key = (row: { id: string; year: number; seq: number }) => `${row.id}:${row.year}:${row.seq}`;
      expect(stored.rows.map(key).sort()).toEqual(ranked.rows.map(key).sort());
    });

    describe('replaying the seven P2 files on the same database', () => {
      let snapshotBefore: Record<string, unknown> = {};

      async function everything() {
        const out: Record<string, unknown> = {};
        for (const [table, orderBy] of ORIGINAL_TABLES) out[table] = await tableRows(pool, table, orderBy);
        out.maker_po_display_numbers = await tableRows(pool, 'maker_po_display_numbers', 'maker_purchase_order_id');
        out.constraints = (await pool.query(`
          select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint
           where conrelid in ('users'::regclass, 'film_supply_orders'::regclass, 'seven_po_order_facts'::regclass,
                              'maker_recipient_addresses'::regclass, 'idempotency_keys'::regclass, 'maker_po_display_numbers'::regclass)
           order by 1, 2`)).rows;
        out.triggers = (await pool.query(`
          select tgname from pg_trigger where tgrelid = 'maker_purchase_orders'::regclass and not tgisinternal order by tgname`)).rows;
        out.indexes = (await pool.query(`
          select indexname, indexdef from pg_indexes where schemaname = 'public'
             and tablename in ('film_supply_orders', 'maker_recipient_addresses', 'idempotency_keys', 'maker_po_display_numbers', 'seven_po_order_facts')
           order by indexname`)).rows;
        out.enums = { documentType: await enumLabels(pool, 'document_type'), userRole: await enumLabels(pool, 'user_role') };
        return out;
      }

      async function replay() {
        const client = await pool.connect();
        try {
          await client.query('begin');
          for (const file of P2_FILES) {
            const content = await readFile(path.join(fullFolder, file), 'utf8');
            for (const statement of content.split('--> statement-breakpoint')) {
              if (statement.trim().length > 0) await client.query(statement);
            }
          }
          await client.query('commit');
        } catch (error) {
          await client.query('rollback').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      }

      beforeAll(async () => {
        snapshotBefore = await everything();
      });

      it('runs all seven files again without an error, twice', async () => {
        await expect(replay()).resolves.toBeUndefined();
        await expect(replay()).resolves.toBeUndefined();
      });

      it('changes no row, constraint, trigger, index or enum value', async () => {
        expect(await everything()).toEqual(snapshotBefore);
      });

      it('still numbers a new insert exactly once, continuing the year', async () => {
        const id = randomUUID();
        await insertMakerPo(pool, { id, orderId: ids.order2, userId: ids.admin, createdAt: '2026-05-01T00:00:00.000Z' });
        const rows = await pool.query('select display_number from maker_po_display_numbers where maker_purchase_order_id = $1', [id]);
        expect(rows.rows).toEqual([{ display_number: 'MPO-2026-0005' }]);
      });

      it('treats a drizzle re-run as a no-op', async () => {
        await migrate(drizzle(pool), { migrationsFolder: fullFolder });
        expect(await migrationCount(pool)).toBe(33);
      });
    });
  });
});

// ------------------------------------------------------- (4) number trigger
describe('maker PO number trigger (0028)', () => {
  let pool: pg.Pool;
  let ids: Awaited<ReturnType<typeof seedBase>>;

  beforeAll(async () => {
    pool = poolFor(await createScratchDatabase('trigger'), 14);
    await migrate(drizzle(pool), { migrationsFolder: fullFolder });
    ids = await seedBase(pool, 'tr');
  });

  it('gives 10 concurrent inserts distinct, gap-free numbers and lets 2 rollbacks consume none', async () => {
    const createdAt = '2032-05-01T00:00:00.000Z';
    const rollbackAt = new Set([3, 7]);
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, async (_, index) => {
      const client = await pool.connect();
      const id = randomUUID();
      try {
        await client.query('begin');
        await insertMakerPo(client, { id, orderId: ids.order1, userId: ids.admin, createdAt });
        // Hold the transaction open so every other insert overlaps with it.
        await client.query('select pg_sleep(0.15)');
        await client.query(rollbackAt.has(index) ? 'rollback' : 'commit');
        return { id, committed: !rollbackAt.has(index) };
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }));
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(failures.map((failure) => String((failure as PromiseRejectedResult).reason))).toEqual([]);
    const committed = outcomes.flatMap((outcome) => outcome.status === 'fulfilled' && outcome.value.committed ? [outcome.value.id] : []);
    expect(committed).toHaveLength(8);
    const numbers = await pool.query(
      'select maker_purchase_order_id::text as id, seq, display_number from maker_po_display_numbers where year = 2032 order by seq'
    );
    expect(numbers.rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(numbers.rows.map((row) => row.display_number)).size).toBe(8);
    expect(numbers.rows.map((row) => row.id).sort()).toEqual([...committed].sort());
    expect(numbers.rows[0].display_number).toBe('MPO-2032-0001');
  });

  it('does not consume a number for a rolled-back insert', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await insertMakerPo(client, { orderId: ids.order2, userId: ids.admin, createdAt: '2033-02-01T00:00:00.000Z' });
      await client.query('rollback');
    } finally {
      client.release();
    }
    const id = randomUUID();
    await insertMakerPo(pool, { id, orderId: ids.order2, userId: ids.admin, createdAt: '2033-02-02T00:00:00.000Z' });
    expect(await numberOf(pool, id)).toBe('MPO-2033-0001');
  });

  it('counts 12/31 15:00 UTC as the next JST year', async () => {
    const lastOfYear = randomUUID();
    const firstOfNext = randomUUID();
    await insertMakerPo(pool, { id: lastOfYear, orderId: ids.order2, userId: ids.admin, createdAt: '2034-12-31T14:59:59.999Z' });
    await insertMakerPo(pool, { id: firstOfNext, orderId: ids.order2, userId: ids.admin, createdAt: '2034-12-31T15:00:00.000Z' });
    expect(await numberOf(pool, lastOfYear)).toBe('MPO-2034-0001');
    expect(await numberOf(pool, firstOfNext)).toBe('MPO-2035-0001');
  });

  it('widens the number past 9999 instead of wrapping', async () => {
    const seeded = randomUUID();
    await insertMakerPo(pool, { id: seeded, orderId: ids.order3, userId: ids.admin, createdAt: '2036-01-01T00:00:00.000Z' });
    await pool.query(`update maker_po_display_numbers set seq = 9999, display_number = 'MPO-2036-9999' where maker_purchase_order_id = $1`, [seeded]);
    const next = randomUUID();
    await insertMakerPo(pool, { id: next, orderId: ids.order3, userId: ids.admin, createdAt: '2036-01-02T00:00:00.000Z' });
    expect(await numberOf(pool, next)).toBe('MPO-2036-10000');
  });

  it('refuses a duplicate (year, seq) and a malformed number as a backstop', async () => {
    const one = randomUUID();
    await insertMakerPo(pool, { id: one, orderId: ids.order3, userId: ids.admin, createdAt: '2037-01-01T00:00:00.000Z' });
    const other = randomUUID();
    await pool.query(`alter table maker_purchase_orders disable trigger maker_purchase_orders_assign_display_number`);
    try {
      await insertMakerPo(pool, { id: other, orderId: ids.order3, userId: ids.admin, createdAt: '2037-01-02T00:00:00.000Z' });
    } finally {
      await pool.query(`alter table maker_purchase_orders enable trigger maker_purchase_orders_assign_display_number`);
    }
    const duplicate = await pgError(pool.query(
      `insert into maker_po_display_numbers (maker_purchase_order_id, year, seq, display_number) values ($1, 2037, 1, 'MPO-2037-0001')`, [other]
    ));
    expect(duplicate.code).toBe('23505');
    const malformed = await pgError(pool.query(
      `insert into maker_po_display_numbers (maker_purchase_order_id, year, seq, display_number) values ($1, 2037, 2, 'MPO-2037-2')`, [other]
    ));
    expect(malformed).toMatchObject({ code: '23514', constraint: 'maker_po_display_numbers_format' });
  });
});

// --------------------------------------------------------------- (5) CHECKs
describe('P2 CHECK constraints', () => {
  let pool: pg.Pool;
  let ids: Awaited<ReturnType<typeof seedBase>>;

  beforeAll(async () => {
    pool = poolFor(await createScratchDatabase('checks'));
    await migrate(drizzle(pool), { migrationsFolder: fullFolder });
    ids = await seedBase(pool, 'ck');
  });

  describe('seven_po_order_facts', () => {
    const insertFacts = (quantity: string | null, unit: string | null, amount: string | null, currency: string | null) => pool.query(
      `insert into seven_po_order_facts (seven_purchase_order_id, ordered_quantity, ordered_unit, total_amount, currency, created_by_user_id, updated_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $6)`,
      [ids.sevenPo, quantity, unit, amount, currency, ids.admin]
    );

    it('refuses a quantity without its unit and a unit without its quantity', async () => {
      expect(await pgError(insertFacts('10', null, null, null))).toMatchObject({ code: '23514', constraint: 'seven_po_order_facts_quantity_pair' });
      expect(await pgError(insertFacts(null, 'rolls', null, null))).toMatchObject({ code: '23514', constraint: 'seven_po_order_facts_quantity_pair' });
    });

    it('refuses an amount without its currency and a currency without its amount', async () => {
      expect(await pgError(insertFacts(null, null, '100', null))).toMatchObject({ code: '23514', constraint: 'seven_po_order_facts_amount_pair' });
      expect(await pgError(insertFacts(null, null, null, 'JPY'))).toMatchObject({ code: '23514', constraint: 'seven_po_order_facts_amount_pair' });
    });

    it('refuses a zero or negative quantity and a negative amount', async () => {
      expect(await pgError(insertFacts('0', 'rolls', null, null))).toMatchObject({ code: '23514', constraint: 'seven_po_order_facts_quantity_positive' });
      expect(await pgError(insertFacts('-1', 'rolls', null, null))).toMatchObject({ code: '23514', constraint: 'seven_po_order_facts_quantity_positive' });
      expect(await pgError(insertFacts(null, null, '-0.01', 'JPY'))).toMatchObject({ code: '23514', constraint: 'seven_po_order_facts_amount_nonnegative' });
    });

    it('refuses a currency that is not three capital letters', async () => {
      expect(await pgError(insertFacts(null, null, '1', 'jpy'))).toMatchObject({ code: '23514', constraint: 'seven_po_order_facts_currency_format' });
    });

    it('accepts both pairs set, and a zero amount', async () => {
      await insertFacts('12.5', 'meters', '0', 'JPY');
      const stored = await pool.query('select ordered_quantity::text as q, total_amount::text as a from seven_po_order_facts where seven_purchase_order_id = $1', [ids.sevenPo]);
      expect(stored.rows).toEqual([{ q: '12.500', a: '0.00' }]);
    });
  });

  describe('maker_recipient_addresses', () => {
    const insertAddress = (email: string, options: { isDefault?: boolean; isActive?: boolean; label?: string | null } = {}) => pool.query(
      `insert into maker_recipient_addresses (id, account_id, email, label, is_default, is_active, created_by_user_id, updated_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [randomUUID(), ids.maker, email, options.label ?? null, options.isDefault ?? false, options.isActive ?? true, ids.admin]
    );

    it('refuses an address that is not lower case', async () => {
      expect(await pgError(insertAddress('Orders@Maker.example.com'))).toMatchObject({ code: '23514', constraint: 'maker_recipient_addresses_email_lowercase' });
    });

    it('refuses an address that is not a mail address', async () => {
      expect(await pgError(insertAddress('not an address'))).toMatchObject({ code: '23514', constraint: 'maker_recipient_addresses_email_format' });
    });

    it('refuses the same address twice for one maker', async () => {
      await insertAddress('dup@maker.example.com');
      expect(await pgError(insertAddress('dup@maker.example.com'))).toMatchObject({ code: '23505', constraint: 'maker_recipient_addresses_account_email_unique' });
    });

    it('allows at most one default address per maker', async () => {
      await insertAddress('first-default@maker.example.com', { isDefault: true });
      expect(await pgError(insertAddress('second-default@maker.example.com', { isDefault: true })))
        .toMatchObject({ code: '23505', constraint: 'maker_recipient_addresses_one_default' });
    });

    it('refuses an inactive default address and a blank label', async () => {
      expect(await pgError(insertAddress('inactive@maker.example.com', { isDefault: true, isActive: false })))
        .toMatchObject({ code: '23514', constraint: 'maker_recipient_addresses_default_is_active' });
      expect(await pgError(insertAddress('blank@maker.example.com', { label: '   ' })))
        .toMatchObject({ code: '23514', constraint: 'maker_recipient_addresses_label_length' });
    });
  });

  describe('idempotency_keys', () => {
    const insertKey = (input: { key?: string; state: string; status?: number | null; body?: string | null; completed?: boolean }) => pool.query(
      `insert into idempotency_keys (user_id, idempotency_key, fingerprint, state, response_status, response_body, lease_expires_at, completed_at, expires_at)
       values ($1, $2, 'fp', $3, $4, $5, now() + interval '30 seconds', $6, now() + interval '1 day')`,
      [ids.staff, input.key ?? `key-${randomUUID()}`, input.state, input.status ?? null, input.body ?? null, input.completed ? new Date() : null]
    );

    it('accepts a pending row without an answer and a completed row with a 2xx answer', async () => {
      await insertKey({ state: 'pending' });
      await insertKey({ state: 'completed', status: 201, body: '{}', completed: true });
      const count = await pool.query('select count(*)::int as n from idempotency_keys where user_id = $1', [ids.staff]);
      expect(count.rows[0].n).toBe(2);
    });

    it('refuses a state outside pending/completed', async () => {
      // Any state other than pending/completed also breaks completed_has_answer,
      // so PostgreSQL may report either of the two CHECKs.
      const error = await pgError(insertKey({ state: 'done' }));
      expect(error.code).toBe('23514');
      expect(['idempotency_keys_state_vocabulary', 'idempotency_keys_completed_has_answer']).toContain(error.constraint);
    });

    it('refuses a pending row carrying an answer and a completed row without one', async () => {
      expect(await pgError(insertKey({ state: 'pending', status: 200, body: '{}' }))).toMatchObject({ code: '23514', constraint: 'idempotency_keys_completed_has_answer' });
      expect(await pgError(insertKey({ state: 'completed', status: 200, body: null, completed: true }))).toMatchObject({ code: '23514', constraint: 'idempotency_keys_completed_has_answer' });
    });

    it('refuses a completed row storing a non-2xx answer', async () => {
      expect(await pgError(insertKey({ state: 'completed', status: 422, body: '{}', completed: true }))).toMatchObject({ code: '23514', constraint: 'idempotency_keys_completed_has_answer' });
    });

    it('refuses a key outside the header format', async () => {
      expect(await pgError(insertKey({ key: 'short', state: 'pending' }))).toMatchObject({ code: '23514', constraint: 'idempotency_keys_key_format' });
    });
  });

  describe('users.display_language', () => {
    it('accepts ja, ja-ko, ko and null', async () => {
      for (const value of ['ja', 'ja-ko', 'ko', null]) {
        await pool.query('update users set display_language = $1 where id = $2', [value, ids.staff]);
        const stored = await pool.query('select display_language from users where id = $1', [ids.staff]);
        expect(stored.rows[0].display_language).toBe(value);
      }
    });

    it('refuses any other language value', async () => {
      for (const value of ['en', 'JA', 'ja_ko', '']) {
        expect(await pgError(pool.query('update users set display_language = $1 where id = $2', [value, ids.staff])), value)
          .toMatchObject({ code: '23514', constraint: 'users_display_language_vocabulary' });
      }
    });
  });
});
