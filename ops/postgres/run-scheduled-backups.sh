#!/bin/sh
set -eu

: "${BACKUP_INTERVAL_SECONDS:=86400}"
: "${BACKUP_RETENTION_DAYS:=14}"

case "$BACKUP_INTERVAL_SECONDS:$BACKUP_RETENTION_DAYS" in
  *[!0-9:]*|:*|*:) echo 'backup interval and retention must be positive integers' >&2; exit 1 ;;
esac

while true; do
  /ops/postgres/backup.sh
  find "$BACKUP_DIRECTORY" -type f \
    \( -name 'relay-*.dump' -o -name 'relay-*.dump.sha256' -o -name 'relay-*.restore-report.json' \) \
    -mtime "+$BACKUP_RETENTION_DAYS" -delete
  sleep "$BACKUP_INTERVAL_SECONDS"
done
