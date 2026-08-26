#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required to prove the restore is isolated}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"

if [ "$DATABASE_URL" = "$RESTORE_DATABASE_URL" ]; then
  echo 'restore drill target must be isolated from the source database' >&2
  exit 1
fi

source_system_identifier="$(
  psql "$DATABASE_URL" --no-psqlrc --tuples-only --no-align \
    --command 'SELECT system_identifier FROM pg_control_system()'
)"
restore_system_identifier="$(
  psql "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align \
    --command 'SELECT system_identifier FROM pg_control_system()'
)"
if [ -z "$source_system_identifier" ] || [ -z "$restore_system_identifier" ]; then
  echo 'restore drill could not verify PostgreSQL instance identities' >&2
  exit 1
fi
if [ "$source_system_identifier" = "$restore_system_identifier" ]; then
  echo 'restore drill target must be a separate PostgreSQL instance' >&2
  exit 1
fi

target_user_tables="$(
  psql "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "
    SELECT count(*)
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema');
  "
)"
if [ "$target_user_tables" != '0' ]; then
  echo 'restore drill target must be a fresh database with no user tables' >&2
  exit 1
fi

checksum="$BACKUP_FILE.sha256"
test -r "$BACKUP_FILE"
test -r "$checksum"
(cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$checksum")")

pg_restore \
  --dbname "$RESTORE_DATABASE_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  --exit-on-error \
  "$BACKUP_FILE"

report="$BACKUP_FILE.restore-report.json"
psql "$RESTORE_DATABASE_URL" --no-psqlrc --tuples-only --no-align --command "
  SELECT json_build_object(
    'agentRuns', (SELECT count(*) FROM public.agent_run),
    'agentRunEvents', (SELECT count(*) FROM public.agent_run_event),
    'messages', (SELECT count(*) FROM public.message)
  );
" >"$report"

printf '%s\n' "$report"
