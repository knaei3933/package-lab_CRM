import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { filmSupplyOrderStatus } from '@kanei/db/schema';
import pg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sourceUrl = (() => {
  const url = new URL(process.env.DATABASE_URL!);
  url.hostname = '127.0.0.1';
  url.port = '5434';
  url.pathname = '/kanei_crm_mvp_test';
  return url.toString();
})();
const { Pool } = pg;
const run = promisify(execFile);

/** Parse the guarded test URL without putting credentials into source. */
function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}

async function createScratchDatabase(prefix: string): Promise<string> {
  const source = new URL(sourceUrl);
  const name = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new Pool({ connectionString: source.toString().replace(/\/[^/?#]*(?:\?|$)/, '/postgres') });
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  return name;
}

async function dropScratchDatabase(name: string): Promise<void> {
  const source = new URL(sourceUrl);
  const admin = new Pool({ connectionString: source.toString().replace(/\/[^/?#]*(?:\?|$)/, '/postgres') });
  try {
    await admin.query(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end();
  }
}

async function scratchUrl(name: string): Promise<string> {
  const source = new URL(sourceUrl);
  source.pathname = `/${name}`;
  return source.toString();
}

async function enumValues(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query(
      `select unnest(enum_range(null::film_supply_order_status)) as value
         order by enum_range(null::film_supply_order_status)::text`
    );
    return result.rows.map((row) => row.value as string);
  } finally {
    await client.end();
  }
}

async function pgEnumValues(connectionString: string, typeName: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query(
      `select e.enumlabel as value
         from pg_enum e
         join pg_type t on t.oid = e.enumtypid
        where t.typname = $1
        order by e.enumsortorder`,
      [typeName]
    );
    return result.rows.map((row) => row.value as string);
  } finally {
    await client.end();
  }
}

async function migrationRows(connectionString: string): Promise<Array<{ id: number; hash: string; created_at: string }>> {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const result = await client.query(
      'select id, hash, created_at::text as "created_at" from drizzle.__drizzle_migrations order by id'
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

let tempRoot = '';

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'kanei-migration-test-'));
  await cp(path.resolve(process.cwd(), 'packages/db/drizzle'), path.join(tempRoot, 'drizzle'), { recursive: true });
});

afterAll(async () => {
  // Temp databases are scratch test databases only; the main DB is untouched.
  if (process.env.KEEP_MIGRATION_SCRATCH_DB !== '1') {
    const files = await readFile(path.join(tempRoot, 'scratch-dbs.txt'), 'utf8').catch(() => '');
    for (const name of files.split('\n').filter(Boolean)) await dropScratchDatabase(name);
  }
});

async function runThrough0020(migrationsFolder: string, connectionString: string): Promise<void> {
  const journalPath = path.join(migrationsFolder, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= 20);
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    await client.query('create schema if not exists drizzle');
    await client.query(`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`);
    for (const entry of entries) {
      const content = await readFile(path.join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
      for (const statement of content.split('--> statement-breakpoint\n')) {
        await client.query(statement);
      }
      await client.query(
        `insert into drizzle.__drizzle_migrations ("hash", "created_at") values ($1, $2)`,
        [entry.tag, entry.when]
      );
    }
    // 0015 intentionally leaves a transaction open so 0016 can use committed
    // enum values; commit this staged replay before closing.
    await client.query('commit');
  } finally {
    await client.end();
  }
}

describe('drizzle migration ordering and 0021', () => {
  it('keeps every journal timestamp strictly increasing', async () => {
    const journal = JSON.parse(
      await readFile(path.resolve(process.cwd(), 'packages/db/drizzle/meta/_journal.json'), 'utf8')
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    expect(journal.entries).toHaveLength(22);
    for (let index = 1; index < journal.entries.length; index += 1) {
      expect(journal.entries[index]!.when, journal.entries[index]!.tag)
        .toBeGreaterThan(journal.entries[index - 1]!.when);
    }
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 21,
      tag: '0021_m9_cancelled_film_order_status',
      when: expect.any(Number)
    });
    expect(journal.entries.at(-1)!.when).toBeGreaterThan(1795731560000);

    // Schema and SQL migrations must agree; 0021 adds an irreversible enum value.
    expect(filmSupplyOrderStatus.enumValues).toContain('CANCELLED');
    expect(filmSupplyOrderStatus.enumValues?.indexOf('CANCELLED'))
      .toBe((filmSupplyOrderStatus.enumValues?.length ?? 0) - 1);
  });

  it('migrates a fresh database through 0021 and adds CANCELLED', async () => {
    const name = await createScratchDatabase('kanei_crm_mvp_migration_fresh');
    await readFile(path.join(tempRoot, 'scratch-dbs.txt'), 'utf8')
      .catch(() => '')
      .then((old) => writeFile(path.join(tempRoot, 'scratch-dbs.txt'), `${old}${name}\n`));
    const url = await scratchUrl(name);
    const pool = new Pool({ connectionString: url });
    try {
      // Drizzle wraps all pending files in one transaction, so historical enum
      // additions followed by checks cannot use ADD VALUE in a fresh run. Mirror
      // the committed-before-use requirement with two transaction phases.
      const staged = path.join(tempRoot, 'through-0020');
      await cp(path.resolve(process.cwd(), 'packages/db/drizzle'), staged, { recursive: true });
      await runThrough0020(staged, url);
      await migrate(drizzle(pool), { migrationsFolder: path.join(tempRoot, 'drizzle') });

      expect(await enumValues(url)).toContain('CANCELLED');
      expect(await enumValues(url)).toEqual(expect.arrayContaining(['CANCELLATION_REVIEW', 'CANCELLED']));
      const rows = await migrationRows(url);
      expect(rows).toHaveLength(22);
      expect(rows.at(-1)).toMatchObject({ created_at: '1795818360000' });
    } finally {
      await pool.end();
    }
  });

  it('runs the real npm db:migrate command on an empty scratch database', async () => {
    const name = await createScratchDatabase('kanei_crm_mvp_migrate_real_command');
    await readFile(path.join(tempRoot, 'scratch-dbs.txt'), 'utf8')
      .catch(() => '')
      .then((old) => writeFile(path.join(tempRoot, 'scratch-dbs.txt'), `${old}${name}\n`));
    const url = await scratchUrl(name);
    const result = await run('npm', ['run', 'db:migrate'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8'
    });
    expect(result.stdout).toContain('migrations applied successfully');
    expect(await migrationRows(url)).toHaveLength(22);
    const values = await enumValues(url);
    expect(values).toContain('CANCELLED');
    expect(values.indexOf('CANCELLED')).toBe(values.length - 1);
  });

  it('applies only 0021 to a database already migrated through 0020', async () => {
    const name = await createScratchDatabase('kanei_crm_mvp_migration_existing');
    await readFile(path.join(tempRoot, 'scratch-dbs.txt'), 'utf8')
      .catch(() => '')
      .then((old) => writeFile(path.join(tempRoot, 'scratch-dbs.txt'), `${old}${name}\n`));
    const url = await scratchUrl(name);
    const pool = new Pool({ connectionString: url });
    const staged = path.join(tempRoot, 'through-0020-existing');
    try {
      await cp(path.resolve(process.cwd(), 'packages/db/drizzle'), staged, { recursive: true });
      await runThrough0020(staged, url);
      expect(await migrationRows(url)).toHaveLength(21);
      expect(await enumValues(url)).not.toContain('CANCELLED');

      await migrate(drizzle(pool), { migrationsFolder: path.join(tempRoot, 'drizzle') });
      const rows = await migrationRows(url);
      expect(rows).toHaveLength(22);
      expect(rows.at(-1)).toMatchObject({ created_at: '1795818360000' });
      const values = await enumValues(url);
      expect(values).toContain('CANCELLED');
      expect(values.indexOf('CANCELLED')).toBe(values.length - 1);
    } finally {
      await pool.end();
    }
  });

  it('recovers by rerunning after 0015 committed but a later migration failed', async () => {
    const name = await createScratchDatabase('kanei_crm_mvp_migration_partial');
    await readFile(path.join(tempRoot, 'scratch-dbs.txt'), 'utf8')
      .catch(() => '')
      .then((old) => writeFile(path.join(tempRoot, 'scratch-dbs.txt'), `${old}${name}\n`));
    const url = await scratchUrl(name);
    const pool = new Pool({ connectionString: url });
    const staged = path.join(tempRoot, 'partial-run');
    try {
      await cp(path.resolve(process.cwd(), 'packages/db/drizzle'), staged, { recursive: true });
      const failingFile = path.join(staged, '0017_m8_oper2_evidence_manual_verification.sql');
      const original = await readFile(failingFile, 'utf8');
      await writeFile(failingFile, `${original}\nSELECT 1 / 0;\n`);

      await expect(migrate(drizzle(pool), { migrationsFolder: staged }))
        .rejects.toMatchObject({ cause: { code: '22012' } });
      expect(await migrationRows(url)).toHaveLength(15);
      expect(await pgEnumValues(url, 'maker_po_event_type')).toEqual(expect.arrayContaining([
        'MAKER_PO_ACCEPT_RECORDED_PROVISIONAL',
        'MAKER_PO_CANCELLED',
      ]));
      expect(await pgEnumValues(url, 'maker_purchase_order_status')).toContain('CANCELLED');
      expect(await pgEnumValues(url, 'maker_po_event_verification_status')).toContain('PENDING_MANUAL_VERIFICATION');

      // 0015 already committed its two-phase transaction. The idempotent column
      // and guarded constraint let the same pending migration replay safely.
      await writeFile(failingFile, original);
      await migrate(drizzle(pool), { migrationsFolder: staged });
      expect(await migrationRows(url)).toHaveLength(22);
      expect(await enumValues(url)).toContain('CANCELLED');
    } finally {
      await pool.end();
    }
  });

  it('raises on payment-terms definition drift and avoids an equivalent duplicate', async () => {
    const name = await createScratchDatabase('kanei_crm_mvp_migration_0015_drift');
    await readFile(path.join(tempRoot, 'scratch-dbs.txt'), 'utf8')
      .catch(() => '')
      .then((old) => writeFile(path.join(tempRoot, 'scratch-dbs.txt'), `${old}${name}\n`));
    const url = await scratchUrl(name);
    const pool = new Pool({ connectionString: url });
    const staged = path.join(tempRoot, 'drift-run');
    const migrationSql = await readFile(
      path.resolve(process.cwd(), 'packages/db/drizzle/0015_m7_sec3_payment_terms.sql'),
      'utf8'
    );
    try {
      await cp(path.resolve(process.cwd(), 'packages/db/drizzle'), staged, { recursive: true });
      await migrate(drizzle(pool), { migrationsFolder: staged });

      const query = async (text: string) => {
        const client = new pg.Client({ connectionString: url });
        await client.connect();
        try {
          return await client.query(text);
        } finally {
          await client.end();
        }
      };

      const run0015 = async () => {
        const client = new pg.Client({ connectionString: url });
        await client.connect();
        try {
          for (const statement of migrationSql.split('--> statement-breakpoint\n')) {
            await client.query(statement);
          }
          await client.query('commit');
        } finally {
          await client.end();
        }
      };

      await query('alter table film_supply_orders drop constraint film_supply_orders_payment_terms_vocabulary');
      await query('alter table film_supply_orders add constraint film_supply_orders_payment_terms_vocabulary check (false)');

      await expect(run0015()).rejects.toThrow(/payment_terms constraint definition drift/);

      await query('alter table film_supply_orders drop constraint film_supply_orders_payment_terms_vocabulary');
      await query(`alter table film_supply_orders add constraint payment_terms_equivalent_check check ("payment_terms" is null or "payment_terms" in ('prepaid', 'on_delivery', 'undetermined'))`);
      await run0015();
      const constraintPool = new Pool({ connectionString: url });
      const constraints = await constraintPool.query(`
        select conname, pg_get_constraintdef(oid) as definition
        from pg_constraint
        where conrelid = 'film_supply_orders'::regclass
          and pg_get_constraintdef(oid) like '%payment_terms%'
      `);
      await constraintPool.end();
      expect(constraints.rows).toHaveLength(1);
      expect(constraints.rows[0]?.conname).toBe('payment_terms_equivalent_check');

      // A differently spelled membership check is drift, not an equivalent.
      // It must make 0015 fail closed rather than silently add a second guard.
      await query(`alter table film_supply_orders add constraint looser_payment_terms_check check ("payment_terms" is null or "payment_terms" in ('credit','prepaid','on_delivery','undetermined'))`);
      await expect(run0015()).rejects.toThrow(/non-canonical CHECK constraint/);
      await query('alter table film_supply_orders drop constraint looser_payment_terms_check');

      // A DOMAIN over text is not the declared text contract, even when its
      // default renders the same way.
      await query('alter table film_supply_orders drop constraint payment_terms_equivalent_check');
      await query('alter table film_supply_orders drop column payment_terms');
      await query('create domain kanei_payment_terms_text as text');
      await query(`alter table film_supply_orders add column payment_terms kanei_payment_terms_text default 'undetermined'`);
      await expect(run0015()).rejects.toThrow(/DOMAIN columns are not accepted/);
    } finally {
      await pool.end();
    }
  });
});
