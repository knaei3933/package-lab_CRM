#!/usr/bin/env bash
# Representative-approved operations only. Credentials are never passed in argv.
# Required env:
#   DATABASE_URL           logical dump target
#   DOCUMENT_STORAGE_DIR   validated private document root
#   BACKUP_ROOT            output directory
#   BACKUP_GPG_PUBLIC_KEY  armored recipient key
# Optional:
#   BACKUP_RETENTION_DAYS  default 35
#   BACKUP_ALERT_CMD       receives "<subject>\n<body>" on success/failure
#   PG_DUMP_CMD            executable invoked as "<cmd> <database>"; defaults pg_dump
set -euo pipefail
umask 077

require_env() {
  local name=$1
  [[ -n "${!name:-}" ]] || { echo "required environment variable is missing: ${name}" >&2; exit 2; }
}
for name in DATABASE_URL DOCUMENT_STORAGE_DIR BACKUP_ROOT BACKUP_GPG_PUBLIC_KEY; do require_env "$name"; done

mkdir -p "$BACKUP_ROOT"
chmod 0700 "$BACKUP_ROOT"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
# Ciphertext stays in backup root; temporary plaintext/pgpass stay in a private
# directory outside likely-synced backup storage.
work=$(mktemp -d "${TMPDIR:-/tmp}/kanei-backup-work-${timestamp}.XXXXXX")
chmod 0700 "$work"
pgpass="$work/pgpass"
output_db="${BACKUP_ROOT}/kanei-database-${timestamp}.dump.gpg"
output_docs="${BACKUP_ROOT}/kanei-documents-${timestamp}.tar.gpg"
output_manifest="${BACKUP_ROOT}/kanei-manifest-${timestamp}.json.gpg"
completed=false
cleanup_status=0
cleanup() {
  cleanup_status=$?
  rm -rf "$work"
  if (( cleanup_status != 0 )) && [[ -n "${BACKUP_ALERT_CMD:-}" ]]; then
    printf '%s\n%s\n' "KANEI backup FAILED ${timestamp}" "temporary work was removed; inspect operator logs" | "$BACKUP_ALERT_CMD" || true
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT

[[ -d "$DOCUMENT_STORAGE_DIR" ]] || { echo "DOCUMENT_STORAGE_DIR is not a directory" >&2; exit 2; }
[[ -r "$BACKUP_GPG_PUBLIC_KEY" ]] || { echo "BACKUP_GPG_PUBLIC_KEY is not readable" >&2; exit 2; }
retention_days=${BACKUP_RETENTION_DAYS:-35}

# Generate libpq's 0600 pgpass file and export all connection fields. pg_dump
# receives only the database name, never a credential-bearing URL.
node --input-type=module - "$pgpass" <<'JS'
import { open } from 'node:fs/promises';
import pg from 'pg';
const [pgpassPath] = process.argv.slice(2);
const url = new URL(process.env.DATABASE_URL);
if (!url.hostname || !url.pathname.slice(1)) throw new Error('DATABASE_URL is not parseable');
const escapePgpass = (value) => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:');
const line = [
  escapePgpass(url.hostname),
  url.port || '5432',
  escapePgpass(decodeURIComponent(url.pathname.slice(1))),
  escapePgpass(decodeURIComponent(url.username || '')),
  escapePgpass(decodeURIComponent(url.password || ''))
].join(':') + '\n';
const handle = await open(pgpassPath, 'wx', 0o600);
await handle.writeFile(line, { mode: 0o600 });
await handle.close();
JS
readarray -t connection < <(node --input-type=module - <<'JS'
import pg from 'pg';
const url = new URL(process.env.DATABASE_URL);
const values = [
  url.hostname,
  url.port || '5432',
  decodeURIComponent(url.pathname.slice(1)),
  decodeURIComponent(url.username || '')
];
for (const value of values) process.stdout.write(`${value}\n`);
JS
)
export PGPASSFILE="$pgpass"
export PGHOST="${connection[0]}"
export PGPORT="${connection[1]}"
export PGDATABASE="${connection[2]}"
export PGUSER="${connection[3]}"
chmod 0600 "$PGPASSFILE"

pg_dump_cmd=${PG_DUMP_CMD:-pg_dump}
db_gpg="$work/database.dump.gpg"
# Stream custom dump directly into encryption. No plaintext dump file exists.
"$pg_dump_cmd" "$PGDATABASE" \
  | gpg --batch --yes --trust-model always --recipient-file "$BACKUP_GPG_PUBLIC_KEY" \
    --output "$db_gpg" --encrypt
[[ -s "$db_gpg" ]] || { echo 'encrypted database segment is empty' >&2; exit 2; }

docs_gpg="$work/documents.tar.gpg"
tar --create --directory="$DOCUMENT_STORAGE_DIR" --numeric-owner . \
  | gpg --batch --yes --trust-model always --recipient-file "$BACKUP_GPG_PUBLIC_KEY" \
    --output "$docs_gpg" --encrypt
[[ -s "$docs_gpg" ]] || { echo 'encrypted document segment is empty' >&2; exit 2; }

manifest="$work/MANIFEST.json"
db_sha=$(sha256sum "$db_gpg" | awk '{print $1}')
docs_sha=$(sha256sum "$docs_gpg" | awk '{print $1}')
cat > "$manifest" <<JSON
{
  "backup_started_at": "${started}",
  "backup_completed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": {"format":"pg_dump/custom encrypted stream","sha256_encrypted":"${db_sha}"},
  "document_storage": {"archive":"documents.tar.gpg","sha256_encrypted":"${docs_sha}"},
  "retention_days": ${retention_days},
  "encrypted": true,
  "plaintext_intermediates": false
}
JSON
chmod 0600 "$manifest"
gpg --batch --yes --trust-model always --recipient-file "$BACKUP_GPG_PUBLIC_KEY" \
  --output "$output_manifest" --encrypt "$manifest"
install -m 0600 "$db_gpg" "$output_db"
install -m 0600 "$docs_gpg" "$output_docs"
completed=true

find "$BACKUP_ROOT" -maxdepth 1 -type f \( \
  -name 'kanei-database-*.dump.gpg' -o \
  -name 'kanei-documents-*.tar.gpg' -o \
  -name 'kanei-manifest-*.json.gpg' \) -mtime "+${retention_days}" -print -delete

if [[ -n "${BACKUP_ALERT_CMD:-}" ]]; then
  printf '%s\n%s\n' "KANEI backup completed ${timestamp}" \
    "outputs: $(basename "$output_db"), $(basename "$output_docs"), $(basename "$output_manifest")" \
    | "$BACKUP_ALERT_CMD"
fi
printf 'backup complete: %s, %s, %s\n' "$output_db" "$output_docs" "$output_manifest"
