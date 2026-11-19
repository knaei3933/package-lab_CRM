#!/usr/bin/env bash
# T-30 isolated restore test. The target must be a scratch database; the script
# refuses the canonical main database. It reports hashes, references, audit
# preservation, append-only locks, RPO, and RTO without changing main.
# Required env:
#   RESTORE_DATABASE_URL   empty scratch PostgreSQL database
#   BACKUP_DUMP            unencrypted custom pg_dump from a test backup
#   DOCUMENT_STORAGE_TAR   document tar matching that backup
#   RESTORED_STORAGE_DIR   empty scratch directory to unpack documents
# Optional: RESTORE_SOURCE_STORAGE_DIR, RESTORE_REPORT, PG_RESTORE_CMD
set -euo pipefail
require() { [[ -n "${!1:-}" ]] || { echo "missing env: $1" >&2; exit 2; }; }
require RESTORE_DATABASE_URL; require BACKUP_DUMP; require DOCUMENT_STORAGE_TAR; require RESTORED_STORAGE_DIR

db_name=$(node --input-type=module -e 'process.stdout.write(decodeURIComponent(new URL(process.env.RESTORE_DATABASE_URL).pathname.slice(1)))')
if [[ "$db_name" == 'kanei_crm_mvp' ]]; then
  echo 'refusing canonical main database' >&2
  exit 2
fi
started=$(date +%s)
mkdir -p "$RESTORED_STORAGE_DIR"
chmod 0700 "$RESTORED_STORAGE_DIR"
tar --extract --file="$DOCUMENT_STORAGE_TAR" --directory="$RESTORED_STORAGE_DIR"

pg_restore_cmd=${PG_RESTORE_CMD:-pg_restore}
"$pg_restore_cmd" --dbname="$RESTORE_DATABASE_URL" --no-owner --exit-on-error "$BACKUP_DUMP"

report=${RESTORE_REPORT:-restore-verification-$(date -u +%Y%m%dT%H%M%SZ).json}
node scripts/restore-verification.mjs \
  "$RESTORE_DATABASE_URL" \
  "$RESTORED_STORAGE_DIR" \
  "${RESTORE_SOURCE_STORAGE_DIR:-}" \
  "$started" \
  "$report"
printf 'restore verification report: %s\n' "$report"
