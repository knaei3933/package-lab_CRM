#!/usr/bin/env bash
# T-30 isolated restore test. The target must be an explicitly confirmed empty
# scratch database. The canonical/main names are always refused.
# Required env:
#   RESTORE_DATABASE_URL       empty scratch PostgreSQL database
#   RESTORE_TARGET_DB          same DB name, operator confirmation
#   RESTORE_CONFIRM_TOKEN      must equal kanei-restore-confirm-20261119
#   BACKUP_DATABASE_GPG        encrypted database dump segment
#   BACKUP_DOCUMENTS_GPG       encrypted document tar segment
#   RESTORED_STORAGE_DIR       empty scratch directory to unpack documents
#   RESTORE_GPG_HOMEDIR        private-key GNUPGHOME
# Optional: RESTORE_SOURCE_STORAGE_DIR, RESTORE_REPORT, PG_RESTORE_CMD
set -euo pipefail
umask 077
require() { [[ -n "${!1:-}" ]] || { echo "missing env: $1" >&2; exit 2; }; }
for name in RESTORE_DATABASE_URL RESTORE_TARGET_DB RESTORE_CONFIRM_TOKEN BACKUP_DATABASE_GPG BACKUP_DOCUMENTS_GPG RESTORED_STORAGE_DIR RESTORE_GPG_HOMEDIR; do require "$name"; done
[[ "$RESTORE_CONFIRM_TOKEN" == 'kanei-restore-confirm-20261119' ]] || { echo 'restore confirmation token mismatch' >&2; exit 2; }

url_name=$(node --input-type=module -e 'process.stdout.write(decodeURIComponent(new URL(process.env.RESTORE_DATABASE_URL).pathname.slice(1)))')
[[ "$url_name" == "$RESTORE_TARGET_DB" ]] || { echo 'RESTORE_TARGET_DB does not match the URL' >&2; exit 2; }
case "$url_name" in
  kanei_crm_mvp|kanei_crm_mvp_test|*prod*|*production*)
    echo "refusing production/canonical restore target: $url_name" >&2
    exit 2
  ;;
esac
[[ -d "$RESTORED_STORAGE_DIR" ]] && [[ -z "$(find "$RESTORED_STORAGE_DIR" -mindepth 1 -print -quit)" ]] || { echo 'RESTORED_STORAGE_DIR must already exist and be empty' >&2; exit 2; }

started=$(date +%s)
# The target must contain no application tables before restore.
nonempty=$(psql "$RESTORE_DATABASE_URL" -Atqc "select count(*) from information_schema.tables where table_schema='public'")
[[ "$nonempty" == 0 ]] || { echo "restore target is not empty (public tables: $nonempty)" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/kanei-restore-XXXXXX")
chmod 0700 "$work"
trap 'rm -rf "$work"' EXIT
# Decrypt only into pipes: no plaintext dump or document tar is stored.
db_fifo="$work/database.fifo"
docs_fifo="$work/documents.fifo"
mkfifo "$db_fifo" 0600 "$docs_fifo" 0600
GNUPGHOME="$RESTORE_GPG_HOMEDIR" gpg --batch --yes --decrypt --output "$db_fifo" "$BACKUP_DATABASE_GPG" &
decrypt_pid=$!
pg_restore_cmd=${PG_RESTORE_CMD:-pg_restore}
"$pg_restore_cmd" --dbname="$RESTORE_DATABASE_URL" --no-owner --exit-on-error "$db_fifo"
wait "$decrypt_pid"
GNUPGHOME="$RESTORE_GPG_HOMEDIR" gpg --batch --yes --decrypt --output "$docs_fifo" "$BACKUP_DOCUMENTS_GPG" &
docs_decrypt_pid=$!
tar --extract --file="$docs_fifo" --directory="$RESTORED_STORAGE_DIR"
wait "$docs_decrypt_pid"

report=${RESTORE_REPORT:-restore-verification-$(date -u +%Y%m%dT%H%M%SZ).json}
node scripts/restore-verification.mjs \
  "$RESTORE_DATABASE_URL" \
  "$RESTORED_STORAGE_DIR" \
  "${RESTORE_SOURCE_STORAGE_DIR:-}" \
  "$started" \
  "$report"
printf 'restore verification report: %s\n' "$report"
