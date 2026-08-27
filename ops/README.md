# Self-hosted operations

The final MVP acceptance exercise is the interactive
[`pilot-journey.sh`](pilot-journey.sh) wizard. Run it only against the dedicated pilot
Workspace and Linked pilot repository: its pre-agreed worker-loss stage deliberately
kills the worker during disposable work so recovery and pause can be reviewed without
replaying possible repository effects.
The wizard refuses `SKIP_DATABASE_TESTS`, runs the focused live GitHub contract, limits
its database audit to evidence created after the wizard starts, and records the
human-confirmed portions in `.relay/pilot-journey-evidence.json`. The database audit
is deliberately not presented as proof of browser behavior or pull-request suitability.

Relay's production Compose topology exposes only Caddy on host port 443. `web`,
`worker`, PostgreSQL, and the worker-local Codex app-server have no published host
port. The proxy shares only an edge network with `web`; PostgreSQL and the worker
remain on a separate backend network. PostgreSQL, Codex state, and per-AgentRun workspaces use separate private
durable volumes. Caddy receives TLS material but no application secret; the worker
receives Codex state and GitHub credentials but no authentication, email, WebSocket,
or TLS secret.

## Provision and start

Copy `.env.example` to `.env`, create every referenced secret file with mode `0600`,
and mount an off-host filesystem at `RELAY_BACKUP_DIRECTORY`. The database URL file
must use the password in the PostgreSQL password file. Do not put a credential value
in `.env`; Compose mounts each file only into its listed consumers.

The TLS certificate must cover `RELAY_HOSTNAME`. Without the optional Jitsi deployment,
port 443 must be the only ingress allowed by the host firewall. Self-hosted Calls add
UDP 10000 and a dedicated hostname as described in [`jitsi/README.md`](jitsi/README.md).
Start the stack with:

For first-time bootstrap only:

```sh
docker compose up --build --detach
```

After bootstrap, never use a generic `compose up` as an upgrade command because it
does not establish the drain and migration-compatibility boundaries below. Use only
the deployment commands for upgrades.

The backup service immediately writes a verified custom-format dump and then repeats
at `RELAY_BACKUP_INTERVAL_SECONDS`. A completed backup consists of a `.dump` and its
`.dump.sha256`; partial files are removed. The configured destination must be remote
storage or an off-host mounted filesystem—using a local directory does not satisfy
the recovery requirement.

## Compatible replacement

Use the deployment commands instead of replacing both application services together:

```sh
ops/deploy.sh web
ops/deploy.sh worker
ops/deploy.sh contract
```

A web replacement builds the release and its matching migrator, takes a verified
database backup, applies only migrations declared compatible with the running worker,
and replaces only `web`; the active worker and Codex child process remain running.
A worker replacement builds the release and matching migrator, sends `SIGTERM`, and
Compose waits up to 30 minutes while the worker stops claiming new AgentRuns and
finishes its current cycle. Only after it drains
does the command back up, migrate, and start the replacement. If the host or process
is forcibly lost, do not manually requeue the AgentRun: its expired lease follows Relay's
durable `recovering` and potentially `paused` reconciliation path.

Migration files are append-only and versioned. A migration that only expands the
schema and remains safe for the previous runtime may declare this first-line marker:

```sql
-- minimum-runtime-version: 14
```

Without the marker, the migration requires its own schema interface version. Runtime
startup accepts a newer schema only when every applied migration declares it safe;
it refuses an older schema or a contract migration requiring a newer runtime. Remove
old columns or behavior only in a later contract release after every old web and
worker process has been replaced. The ordinary `web` and `worker` commands accept
expand-compatible migrations only. Use `contract` for a later removal: it drains the
worker, stops the old web runtime, backs up, applies the contract migration with no
old runtime active, and then starts both replacements.

## Isolated restore drill

Never restore a drill over the live database. Provision a fresh isolated PostgreSQL
17 database, make the backup directory available to a PostgreSQL client container,
and run:

```sh
docker run --rm --network host \
  --volume "$RELAY_BACKUP_DIRECTORY:/backups" \
  --volume "$PWD/ops/postgres:/ops:ro" \
  --env DATABASE_URL="$LIVE_DATABASE_URL" \
  --env RESTORE_DATABASE_URL="$ISOLATED_RESTORE_DATABASE_URL" \
  --env BACKUP_FILE="/backups/relay-YYYYMMDDTHHMMSSZ.dump" \
  postgres:17-alpine sh /ops/restore-drill.sh
```

The drill verifies that source and target have different PostgreSQL system identities,
refuses a target containing user tables, verifies the checksum, restores with
`--exit-on-error`, and writes a `.restore-report.json` containing Message, AgentRun,
and AgentRun-event counts. Sign
in to an isolated Relay instance using the restored database and inspect at least one
real Shared agent channel lifecycle before recording the drill as successful. The
database role itself is host provisioning state and must be recreated separately.

## Independent rotation and revocation

Replace only the named file or state, then restart only the listed consumer. Keep the
old value available until that consumer is healthy unless the incident requires
immediate revocation.

| Boundary | Credential | Rotation or revocation | Expected impact |
| --- | --- | --- | --- |
| Application/database | PostgreSQL password and database URL files | Change the database role password, replace both files, restart `web`, `worker`, `migrate`, and `backup`. | Brief application/worker database reconnect; durable state remains. |
| Application/email | Email delivery token file | Replace it and restart `web`. | Invitation email delivery only. |
| Authentication | Better Auth secret file | Replace it and restart `web`; revoke individual sessions or membership in Relay when narrower response is possible. | Rotation invalidates authentication cookies; AgentRun execution continues. |
| Codex | Worker-only managed-login state | Disconnect the Provider connection to stop new claims, drain the worker, and perform managed logout/login as the worker OS identity. | Existing history remains; new work waits until reconnection. |
| GitHub | App private key file or webhook secret file | Rotate the App key and restart `web` plus `worker`; rotate the webhook secret and restart only `web`. Revoke the App installation for immediate repository cutoff. | GitHub work pauses or fails safely; authentication and TLS remain available. |
| WebSocket | Realtime ticket secret file | Replace it and restart `web`. | Outstanding one-minute socket tickets are rejected; browsers fetch a new ticket and reconcile durable events. Sessions and worker execution remain valid. |
| TLS | Certificate and private-key files | Replace them and restart only `proxy`. | Existing HTTP/WebSocket connections reconnect; application processes continue. |

Codex state and per-AgentRun workspaces are operationally sensitive even though they are
volumes rather than environment secrets. Back up Codex state only with encryption;
do not expose either volume to the browser, `web`, or the proxy.
