#!/usr/bin/env bash
# T-30 isolated restore test. Refuses canonical/production targets, requires a
# confirmed empty scratch DB, and streams decrypted bytes without plaintext.
# Required:
#   RESTORE_DATABASE_URL, RESTORE_TARGET_DB, RESTORE_CONFIRM_TOKEN
#   BACKUP_DATABASE_GPG, BACKUP_DOCUMENTS_GPG, RESTORE_GPG_HOMEDIR
#   RESTORED_STORAGE_DIR, RESTORE_SOURCE_STORAGE_DIR
# Optional: RESTORE_REPORT, PG_RESTORE_CMD, PGPASSFILE
set -euo pipefail
umask 077
require() { [[ -n "${!1:-}" ]] || { echo "missing env: $1" >&2; exit 2; }; }
for name in RESTORE_DATABASE_URL RESTORE_TARGET_DB RESTORE_CONFIRM_TOKEN BACKUP_DATABASE_GPG \
  BACKUP_DOCUMENTS_GPG RESTORE_GPG_HOMEDIR RESTORED_STORAGE_DIR RESTORE_SOURCE_STORAGE_DIR; do
  require "$name"
done
[[ "$RESTORE_CONFIRM_TOKEN" == 'kanei-restore-confirm-20261119' ]] || {
  echo 'restore confirmation token mismatch' >&2;
  exit 2;
}
work=$(mktemp -d "${TMPDIR:-/tmp}/kanei-restore-XXXXXX")
chmod 0700 "$work"
restore_status=0
cleanup() { restore_status=$?; rm -rf "$work"; exit "$restore_status"; }
trap cleanup EXIT
parse_database_url="$work/connection.tsv"
if ! node --input-type=module - "$parse_database_url" <<'NODE'
import { writeFile } from 'node:fs/promises';
const [connectionPath] = process.argv.slice(2);
let url;
try {
  url = new URL(process.env.RESTORE_DATABASE_URL);
  if (!url.hostname || !url.pathname.slice(1)) throw new Error('missing host or database');
} catch {
  console.error('RESTORE_DATABASE_URL is invalid; connection details were not printed');
  process.exit(2);
}
const values = [
  url.hostname,
  url.port || '5432',
  decodeURIComponent(url.pathname.slice(1)),
  decodeURIComponent(url.username || '')
].join('\t') + '\n';
await writeFile(connectionPath, values, { mode: 0o600, flag: 'w' });
NODE
then
  echo 'RESTORE_DATABASE_URL is invalid; connection details were not printed' >&2
  exit 2
fi
IFS=$'\t' read -r target_host target_port target_database target_user < "$parse_database_url"
[[ "$target_database" == "$RESTORE_TARGET_DB" ]] || { echo 'RESTORE_TARGET_DB does not match URL' >&2; exit 2; }
case "$RESTORE_TARGET_DB" in
  kanei_crm_mvp|kanei_crm_mvp_test|*prod*|*production*)
    echo "refusing protected restore target: $RESTORE_TARGET_DB" >&2;
    exit 2;;
esac
[[ -d "$RESTORED_STORAGE_DIR" ]] || { echo 'RESTORED_STORAGE_DIR must exist' >&2; exit 2; }
[[ -z "$(find "$RESTORED_STORAGE_DIR" -mindepth 1 -print -quit)" ]] || { echo 'RESTORED_STORAGE_DIR must be empty' >&2; exit 2; }
[[ -r "$BACKUP_DATABASE_GPG" && -r "$BACKUP_DOCUMENTS_GPG" ]] || { echo 'backup segments not readable' >&2; exit 2; }
[[ -d "$RESTORE_GPG_HOMEDIR" ]] || { echo 'RESTORE_GPG_HOMEDIR missing' >&2; exit 2; }

started=$(date +%s)
# Export libpq fields; target name is passed as PGDATABASE, not a credential URL.
# The generated pgpass is inside the trapped cleanup directory.
export PGHOST="$target_host"
export PGPORT="$target_port"
export PGDATABASE="$target_database"
export PGUSER="$target_user"
if [[ -z "${PGPASSFILE:-}" ]]; then
  PGPASSFILE="$work/pgpass"
  export PGPASSFILE
  node --input-type=module - "$PGPASSFILE" <<'NODE'
import { writeFile } from 'node:fs/promises';
const [path] = process.argv.slice(2);
let url;
try {
  url = new URL(process.env.RESTORE_DATABASE_URL);
} catch {
  console.error('RESTORE_DATABASE_URL is invalid; connection details were not printed');
  process.exit(2);
}
const escape = value => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
const line = [escape(url.hostname), url.port || '5432', escape(decodeURIComponent(url.pathname.slice(1))), escape(decodeURIComponent(url.username || '')), escape(decodeURIComponent(url.password || ''))].join(':') + '\n';
await writeFile(path, line, { mode: 0o600, flag: 'w' });
NODE
fi
export RESTORE_TARGET_DB
export RESTORE_CONFIRM_TOKEN
export RESTORE_GPG_HOMEDIR

# Fail before pg_restore if this is not a custom-format archive. Decryption is
# repeated below so no plaintext dump is ever written to disk.
set +o pipefail
db_magic=$(gpg --homedir "$RESTORE_GPG_HOMEDIR" --batch --quiet --decrypt "$BACKUP_DATABASE_GPG" \
  | head -c 5)
set -o pipefail
[[ "$db_magic" == 'PGDMP' ]] || { echo 'database backup is not pg_dump custom format; use the matching backup script' >&2; exit 2; }

nonempty=$(psql --dbname="$PGDATABASE" --tuples-only --no-align -c \
  "select count(*) from information_schema.tables where table_schema='public'")
[[ "$nonempty" == 0 ]] || { echo "restore target is not empty (public tables: $nonempty)" >&2; exit 2; }

# pg_restore accepts a custom-format stream on stdin; tar consumes the other
# decrypted stream. No plaintext dump or document tar is written.
gpg --homedir "$RESTORE_GPG_HOMEDIR" --batch --quiet --decrypt "$BACKUP_DATABASE_GPG" \
  | "${PG_RESTORE_CMD:-pg_restore}" --dbname="$PGDATABASE" --no-owner --exit-on-error
gpg --homedir "$RESTORE_GPG_HOMEDIR" --batch --quiet --decrypt "$BACKUP_DOCUMENTS_GPG" \
  | tar --extract --directory="$RESTORED_STORAGE_DIR"

report=${RESTORE_REPORT:-restore-verification-$(date -u +%Y%m%dT%H%M%SZ).json}
export RESTORE_REPORT
node scripts/restore-verification.mjs \
  --database "$PGDATABASE" --restored "$RESTORED_STORAGE_DIR" \
  --source "$RESTORE_SOURCE_STORAGE_DIR" --started "$started" --report "$report"
printf 'restore verification report: %s\n' "$report"
