#!/bin/sh
set -eu

compose_bin="${RELAY_COMPOSE_BIN:-docker}"
drain_seconds="${RELAY_WORKER_DRAIN_SECONDS:-1800}"

backup_database() {
  "$compose_bin" compose run --rm --no-deps --entrypoint /bin/sh backup -ec \
    'export DATABASE_URL="$(cat /run/secrets/database_url)"; exec /ops/postgres/backup.sh'
}

case "${1:-}" in
  web)
    "$compose_bin" compose build migrate web
    backup_database
    "$compose_bin" compose run --rm --env RELAY_REQUIRE_EXPAND_ONLY=true migrate
    "$compose_bin" compose up --detach --no-deps web evaluation-retention
    ;;
  worker)
    "$compose_bin" compose build migrate worker
    "$compose_bin" compose stop --timeout "$drain_seconds" worker
    backup_database
    "$compose_bin" compose run --rm --env RELAY_REQUIRE_EXPAND_ONLY=true migrate
    "$compose_bin" compose up --detach --no-deps worker evaluation-retention
    ;;
  contract)
    "$compose_bin" compose build migrate web worker
    "$compose_bin" compose stop --timeout "$drain_seconds" worker
    "$compose_bin" compose stop web
    backup_database
    "$compose_bin" compose run --rm migrate
    "$compose_bin" compose up --detach --no-deps web worker evaluation-retention
    ;;
  *)
    echo 'usage: ops/deploy.sh web|worker|contract' >&2
    exit 2
    ;;
esac
