#!/bin/sh
set -eu

compose_bin="${RELAY_COMPOSE_BIN:-docker}"
drain_seconds="${RELAY_WORKER_DRAIN_SECONDS:-1800}"

backup_database() {
  "$compose_bin" compose run --rm --entrypoint /bin/sh backup -ec \
    'export DATABASE_URL="$(cat /run/secrets/database_url)"; exec /ops/postgres/backup.sh'
}

case "${1:-}" in
  web)
    "$compose_bin" compose build web
    backup_database
    "$compose_bin" compose run --rm migrate
    "$compose_bin" compose up --detach --no-deps web
    ;;
  worker)
    "$compose_bin" compose build worker
    "$compose_bin" compose stop --timeout "$drain_seconds" worker
    backup_database
    "$compose_bin" compose run --rm migrate
    "$compose_bin" compose up --detach --no-deps worker
    ;;
  *)
    echo 'usage: ops/deploy.sh web|worker' >&2
    exit 2
    ;;
esac
