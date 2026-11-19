#!/usr/bin/env bash
# Representative-approved operations only. This script never prints a DATABASE_URL.
# Required env:
#   DATABASE_URL           logical dump target (main/production)
#   DOCUMENT_STORAGE_DIR   validated private document root
#   BACKUP_ROOT            output directory (e.g. mounted backup volume)
#   BACKUP_GPG_PUBLIC_KEY  armored public key file; backup is encrypted to it
# Optional:
#   BACKUP_RETENTION_DAYS  default 35
#   BACKUP_ALERT_CMD       command receiving "<subject>\n<body>" on stdin
#   PG_DUMP_CMD            default: pg_dump (use a version-matched wrapper)
set -euo pipefail

require_env() {
  local name=$1
  if [[ -z "${!name:-}" ]]; then
    echo "required environment variable is missing: ${name}" >&2
    exit 2
  fi
}
for name in DATABASE_URL DOCUMENT_STORAGE_DIR BACKUP_ROOT BACKUP_GPG_PUBLIC_KEY; do require_env "$name"; done

umask 077
mkdir -p "$BACKUP_ROOT"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d "${BACKUP_ROOT}/.kanei-backup-work-${timestamp}.XXXXXX")
trap 'rm -rf "$work"' EXIT
db_dump="$work/database.dump"
storage_tar="$work/documents.tar"
manifest="$work/MANIFEST.json"

[[ -d "$DOCUMENT_STORAGE_DIR" ]] || { echo "DOCUMENT_STORAGE_DIR is not a directory" >&2; exit 2; }
[[ -r "$BACKUP_GPG_PUBLIC_KEY" ]] || { echo "GPG public key is not readable" >&2; exit 2; }
pg_dump_cmd=${PG_DUMP_CMD:-pg_dump}
retention_days=${BACKUP_RETENTION_DAYS:-35}

echo "creating consistent logical dump"
"$pg_dump_cmd" --format=custom --file="$db_dump" "$DATABASE_URL"
db_sha=$(sha256sum "$db_dump" | awk '{print $1}')
db_bytes=$(stat -c '%s' "$db_dump")

echo "packaging private document storage"
tar --create --file="$storage_tar" --directory="$DOCUMENT_STORAGE_DIR" --numeric-owner .
storage_sha=$(sha256sum "$storage_tar" | awk '{print $1}')
storage_files=$(tar --list --file="$storage_tar" | grep -vc '/$' || true)

cat > "$manifest" <<JSON
{
  "backup_started_at": "${started}",
  "backup_completed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "database": { "format": "pg_dump/custom", "bytes": ${db_bytes}, "sha256": "${db_sha}" },
  "document_storage": { "archive": "documents.tar", "files": ${storage_files}, "sha256": "${storage_sha}" },
  "retention_days": ${retention_days},
  "encrypted": true
}
JSON

archive="$work/kanei-backup-${timestamp}.tar"
tar --create --file="$archive" --directory="$work" "$(basename "$db_dump")" "$(basename "$storage_tar")" MANIFEST.json
output="${BACKUP_ROOT}/kanei-backup-${timestamp}.tar.gpg"
gpg --batch --yes --trust-model always --recipient-file "$BACKUP_GPG_PUBLIC_KEY" --output "$output" --encrypt "$archive"
chmod 0600 "$output"

find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'kanei-backup-*.tar.gpg' -mtime "+${retention_days}" -print -delete

if [[ -n "${BACKUP_ALERT_CMD:-}" ]]; then
  printf '%s\n%s\n' "KANEI backup completed ${timestamp}" "encrypted backup: $(basename "$output")" | "$BACKUP_ALERT_CMD"
fi
printf 'backup complete: %s\n' "$output"
