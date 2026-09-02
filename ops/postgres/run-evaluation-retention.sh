#!/bin/sh
set -eu

: "${EVALUATION_RETENTION_INTERVAL_SECONDS:=3600}"

case "$EVALUATION_RETENTION_INTERVAL_SECONDS" in
  *[!0-9]*|''|0) echo 'evaluation retention interval must be a positive integer' >&2; exit 1 ;;
esac

while true; do
  psql "$DATABASE_URL" --set ON_ERROR_STOP=1 --command \
    'SELECT public.purge_expired_collaboration_evaluation()'
  sleep "$EVALUATION_RETENTION_INTERVAL_SECONDS"
done
