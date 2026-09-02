#!/bin/sh
set -eu

compose_bin="${RELAY_COMPOSE_BIN:-docker}"
compose_file="${RELAY_COMPOSE_FILE:-}"
compose_project="${RELAY_COMPOSE_PROJECT:-}"
release_source="${RELAY_DEPLOY_SOURCE:-build}"
drain_seconds="${RELAY_WORKER_DRAIN_SECONDS:-1800}"

compose() {
  if [ -n "$compose_file" ] && [ -n "$compose_project" ]; then
    "$compose_bin" compose --file "$compose_file" --project-name "$compose_project" "$@"
  elif [ -n "$compose_file" ]; then
    "$compose_bin" compose --file "$compose_file" "$@"
  elif [ -n "$compose_project" ]; then
    "$compose_bin" compose --project-name "$compose_project" "$@"
  else
    "$compose_bin" compose "$@"
  fi
}

prepare_release() {
  case "$release_source" in
    build) compose build "$@" ;;
    pull) compose pull "$@" ;;
    *)
      echo 'RELAY_DEPLOY_SOURCE must be build or pull' >&2
      exit 2
      ;;
  esac
}

backup_database() {
  compose run --rm --no-deps --entrypoint /bin/sh backup -ec \
    'export DATABASE_URL="$(cat /run/secrets/database_url)"; exec /ops/postgres/backup.sh'
}

case "${1:-}" in
  web)
    prepare_release migrate web
    backup_database
    compose run --rm --env RELAY_REQUIRE_EXPAND_ONLY=true migrate
    compose up --detach --no-deps web evaluation-retention
    ;;
  worker)
    prepare_release migrate worker
    compose stop --timeout "$drain_seconds" worker
    backup_database
    compose run --rm --env RELAY_REQUIRE_EXPAND_ONLY=true migrate
    compose up --detach --no-deps worker evaluation-retention
    ;;
  contract)
    prepare_release migrate web worker
    compose stop --timeout "$drain_seconds" worker
    compose stop web
    backup_database
    compose run --rm migrate
    compose up --detach --no-deps web worker evaluation-retention
    ;;
  *)
    echo 'usage: ops/deploy.sh web|worker|contract' >&2
    exit 2
    ;;
esac
