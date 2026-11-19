import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const backup = readFileSync('scripts/backup-kanei.sh', 'utf8');
const restore = readFileSync('scripts/restore-verification.sh', 'utf8');
const restoreNode = readFileSync('scripts/restore-verification.mjs', 'utf8');

describe('backup/restore operational contract', () => {
  it('exports PGPASSFILE and all libpq fields for backup', () => {
    for (const name of ['PGPASSFILE', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER']) {
      expect(backup).toMatch(new RegExp(`^export ${name}=`, 'm'));
    }
    expect(backup).not.toContain('mkfifo');
    expect(backup).not.toContain('"$DATABASE_URL"');
  });

  it('restores via stdin and libpq environment without a credential URL argument', () => {
    expect(restore).not.toContain('mkfifo');
    expect(restore).not.toContain('pg_restore --dbname="$RESTORE_DATABASE_URL"');
    expect(restore).toContain('export PGHOST=');
    expect(restore).toContain('export PGDATABASE=');
    expect(restoreNode).not.toContain('new pg.Client({ connectionString: databaseUrl })');
    expect(restoreNode).toContain('new pg.Client()');
  });

  it('requires the restore source so hashes cannot silently read the live storage', () => {
    expect(restore).toContain('RESTORE_SOURCE_STORAGE_DIR; do');
  });
});
