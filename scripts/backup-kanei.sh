#!/usr/bin/env bash
# Representative-approved operations only. Credentials never appear in argv.
# Required env:
#   DATABASE_URL           logical dump target (main/production)
#   DOCUMENT_STORAGE_DIR   validated private document root
#   BACKUP_ROOT            output directory (e.g. mounted backup volume)
#   BACKUP_GPG_PUBLIC_KEY  armored public key file; backup is encrypted to it
# Optional:
#   BACKUP_RETENTION_DAYS  default 35
#   BACKUP_ALERT_CMD       command receiving "<subject>\n<body>" on stdin
#   PG_DUMP_CMD            default: pg_dump (must honor PGPASSFILE)
set -euo pipefail
umask 077

require_env() {
  local name=$1
  if [[ -z "${!name:-}" ]]; then
    echo "required environment variable is missing: ${name}" >&2
    exit 2
  fi
}
for name in DATABASE_URL DOCUMENT_STORAGE_DIR BACKUP_ROOT BACKUP_GPG_PUBLIC_KEY; do require_env "$name"; done

mkdir -p "$BACKUP_ROOT"
chmod 0700 "$BACKUP_ROOT"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
# Ciphertext and pipes stay outside the likely-synced backup root.
work=$(mktemp -d "${TMPDIR:-/tmp}/kanei-backup-work-${timestamp}.XXXXXX")
chmod 0700 "$work"
db_fifo="$work/database.fifo"
pgpass="$work/pgpass"
cleanup_status=0
cleanup() {
  cleanup_status=$?
  rm -rf "$work"
  if (( cleanup_status != 0 )) && [[ -n "${BACKUP_ALERT_CMD:-}" ]]; then
    printf '%s\n%s\n' "KANEI backup FAILED ${timestamp}" "work directory was removed; inspect operator logs" | "$BACKUP_ALERT_CMD" || true
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT

[[ -d "$DOCUMENT_STORAGE_DIR" ]] || { echo "DOCUMENT_STORAGE_DIR is not a directory" >&2; exit 2; }
[[ -r "$BACKUP_GPG_PUBLIC_KEY" ]] || { echo "GPG public key is not readable" >&2; exit 2; }
pg_dump_cmd=${PG_DUMP_CMD:-pg_dump}
retention_days=${BACKUP_RETENTION_DAYS:-35}

# Write credentials to a 0600 PGPASSFILE and pass only the database name to
# pg_dump; neither DATABASE_URL nor the password enters argv.
node --input-type=module - "$pgpass" <<'JS'
import pg from 'pg';
const [pgpassPath] = process.argv.slice(2);
const url = new URL(process.env.DATABASE_URL);
if (!url.hostname || !url.pathname.slice(1)) throw new Error('DATABASE_URL is not parseable');
const line = [
  url.hostname,
  url.port || '5432',
  decodeURIComponent(url.pathname.slice(1)),
  decodeURIComponent(url.username || ''),
  decodeURIComponent(url.password || '')
].join(':') + '\n';
const fs = await import('node:fs/promises');
const handle = await fs.open(pgpassPath, 'wx', 0o600);
await handle.writeFile(line, { mode: 0o600 });
await handle.close();
JS
database_name=$(node --input-type=module - <<'JS'
const url = new URL(process.env.DATABASE_URL);
process.stdout.write(decodeURIComponent(url.pathname.slice(1)));
JS
)

# pg_dump streams through a FIFO directly into encryption; no plaintext dump.
mkfifo "$db_fifo" 0600
db_encrypted="$work/database.dump.gpg"
("$pg_dump_cmd" --format=custom --file="$db_fifo" "$database_name") &
dump_pid=$!
gpg --batch --yes --trust-model always --recipient-file "$BACKUP_GPG_PUBLIC_KEY" \
  --output "$db_encrypted" --encrypt "$db_fifo"
wait "$dump_pid"

# The document tar is likewise streamed directly into encryption.
storage_encrypted="$work/documents.tar.gpg"
tar --create --directory="$DOCUMENT_STORAGE_DIR" --numeric-owner . \
  | gpg --batch --yes --trust-model always --recipient-file "$BACKUP_GPG_PUBLIC_KEY" \
    --output "$storage_encrypted" --encrypt

manifest="$work/MANIFEST.json.gpg"
manifest_plain="$work/MANIFEST.json"
db_sha=$(sha256sum "$db_encrypted" | awk '{print $1}')
storage_sha=$(sha256sum "$storage_encrypted" | awk '{print $1}')
cat > "$manifest_plain" <<JSON
{
  "backup_started_at": "${started}",
  "backup_completed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": { "format": "pg_dump/custom encrypted stream", "sha256_encrypted": "${db_sha}" },
  "document_storage": { "archive": "documents.tar.gpg", "sha256_encrypted": "${storage_sha}" },
  "retention_days": ${retention_days},
  "encrypted": true,
  "plaintext_intermediates": false
}
JSON
chmod 0600 "$manifest_plain"
gpg --batch --yes --trust-model always --recipient-file "$BACKUP_GPG_PUBLIC_KEY" \
  --output "$manifest" --encrypt "$manifest_plain"

db_output="${BACKUP_ROOT}/kanei-database-${timestamp}.dump.gpg"
docs_output="${BACKUP_ROOT}/kanei-documents-${timestamp}.tar.gpg"
manifest_output="${BACKUP_ROOT}/kanei-manifest-${timestamp}.json.gpg"
install -m 0600 "$db_encrypted" "$db_output"
install -m 0600 "$storage_encrypted" "$docs_output"
install -m 0600 "$manifest" "$manifest_output"
find "$BACKUP_ROOT" -maxdepth 1 -type f \( -name 'kanei-database-*.dump.gpg' -o -name 'kanei-documents-*.tar.gpg' -o -name 'kanei-manifest-*.json.gpg' \) -mtime "+${retention_days}" -print -delete

if [[ -n "${BACKUP_ALERT_CMD:-}" ]]; then
  printf '%s\n%s\n' "KANEI backup completed ${timestamp}" "encrypted outputs: $(basename "$db_output"), $(basename "$docs_output")" | "$BACKUP_ALERT_CMD"
fi
printf 'backup complete: %s, %s, %s\n' "$db_output" "$docs_output" "$manifest_output"
