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
  echo 'restore confirmation token mismatch' >&2; exit 2;
}
readarray -t target < <(node --input-type=module - <<'JS'
const url = new URL(process.env.RESTORE_DATABASE_URL);
for (const value of [url.hostname, url.port || '5432', decodeURIComponent(url.pathname.slice(1)), decodeURIComponent(url.username || '')]) {
  process.stdout.write(`${value}\n`);
}
JS
)
[[ "${target[2]}" == "$RESTORE_TARGET_DB" ]] || { echo 'RESTORE_TARGET_DB does not match URL' >&2; exit 2; }
case "$RESTORE_TARGET_DB" in
  kanei_crm_mvp|kanei_crm_mvp_test|*prod*|*production*)
    echo "refusing protected restore target: $RESTORE_TARGET_DB" >&2; exit 2;;
esac
[[ -d "$RESTORED_STORAGE_DIR" ]] || { echo 'RESTORED_STORAGE_DIR must exist' >&2; exit 2; }
[[ -z "$(find "$RESTORED_STORAGE_DIR" -mindepth 1 -print -quit)" ]] || { echo 'RESTORED_STORAGE_DIR must be empty' >&2; exit 2; }
[[ -r "$BACKUP_DATABASE_GPG" && -r "$BACKUP_DOCUMENTS_GPG" ]] || { echo 'backup segments not readable' >&2; exit 2; }
[[ -d "$RESTORE_GPG_HOMEDIR" ]] || { echo 'RESTORE_GPG_HOMEDIR missing' >&2; exit 2; }

started=$(date +%s)
# Export libpq fields; target name is passed as PGDATABASE, not a credential URL.
export PGHOST="${target[0]}"
export PGPORT="${target[1]}"
export PGDATABASE="${target[2]}"
export PGUSER="${target[3]}"
if [[ -z "${PGPASSFILE:-}" ]]; then
  PGPASSFILE=$(mktemp "${TMPDIR:-/tmp}/kanei-restore-pgpass.XXXXXX")
  chmod 0600 "$PGPASSFILE"
  export PGPASSFILE
  node --input-type=module - "$PGPASSFILE" <<'NODE'
import { open } from 'node:fs/promises';
const [path] = process.argv.slice(2);
const url = new URL(process.env.RESTORE_DATABASE_URL);
const escape = value => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
const line = [escape(url.hostname), url.port || '5432', escape(decodeURIComponent(url.pathname.slice(1))), escape(decodeURIComponent(url.username || '')), escape(decodeURIComponent(url.password || ''))].join(':') + '\n';
const handle = await open(path, 'w', 0o600);
await handle.writeFile(line, { mode: 0o600 });
await handle.close();
NODE
fi
export RESTORE_TARGET_DB
export RESTORE_CONFIRM_TOKEN
export RESTORE_GPG_HOMEDIR

nonempty=$(psql --dbname="$PGDATABASE" --tuples-only --no-align -c \
  "select count(*) from information_schema.tables where table_schema='public'")
[[ "$nonempty" == 0 ]] || { echo "restore target is not empty (public tables: $nonempty)" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/kanei-restore-XXXXXX")
chmod 0700 "$work"
restore_status=0
cleanup() { restore_status=$?; rm -rf "$work"; exit "$restore_status"; }
trap cleanup EXIT

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
  --source "${RESTORE_SOURCE_STORAGE_DIR}" --started "$started" --report "$report"
printf 'restore verification report: %s\n' "$report"
