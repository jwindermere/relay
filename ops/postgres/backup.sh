#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_DIRECTORY:?BACKUP_DIRECTORY is required}"

umask 077
mkdir -p "$BACKUP_DIRECTORY"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$BACKUP_DIRECTORY/relay-$timestamp.dump"
temporary="$backup.partial"

cleanup() {
  rm -f "$temporary" "$temporary.sha256"
}
trap cleanup EXIT HUP INT TERM

pg_dump \
  --dbname "$DATABASE_URL" \
  --format custom \
  --compress 9 \
  --no-owner \
  --no-acl \
  --file "$temporary"
pg_restore --list "$temporary" >/dev/null
sha256sum "$temporary" >"$temporary.sha256"
mv "$temporary" "$backup"
sed "s|$(basename "$temporary")|$(basename "$backup")|" \
  "$temporary.sha256" >"$backup.sha256"
rm -f "$temporary.sha256"
trap - EXIT HUP INT TERM

printf '%s\n' "$backup"
