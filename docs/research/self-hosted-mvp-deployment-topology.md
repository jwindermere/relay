# Smallest self-hosted MVP deployment topology

## Decision

Deploy the **Self-hosted MVP** on one business-controlled host (a VM is
sufficient) with a TLS reverse proxy, PostgreSQL, and two independently supervised
Relay processes: `web` and `worker`.

```text
Internet
   |
TLS reverse proxy (:443; only public listener)
   |
Relay web/API + WebSocket endpoint ---- PostgreSQL (private network + data volume)
   |                                             ^
   |                                             | durable state, event/outbox rows
   |                                             |
browser <---- authenticated WebSocket ------------+
                                                 |
Relay worker -- local stdio -- codex app-server -- persistent Codex state volume
   |
   +-- per-AgentRun worktree volume
   +-- server-side GitHub broker --> GitHub App / linked pilot repository
```

`web` serves the SvelteKit application, authenticated HTTP actions, and the
authenticated WebSocket endpoint. `worker` alone claims and executes an
**AgentRun**, owns its worktree, talks to a local `codex app-server` over stdio, and
uses the GitHub broker. PostgreSQL is the source of truth for the MVP pilot
workspace, membership, messages, AgentRun state/events, leases, outbox, provider
connection metadata, and audit records. This is the smallest topology that preserves
the already-selected recovery property: a `web` deployment must not interrupt an
in-progress AgentRun.

The worker can launch and supervise one local App Server per active run (or retain a
single worker-local server if the runtime adapter proves that reliable). It must not
publish an App Server port. The documented App Server supports stdio and says its
remote WebSocket transport is experimental/unsupported for production workloads;
keeping it worker-local removes an unnecessary network authentication boundary.
[App Server transports](https://developers.openai.com/codex/app-server/)

This is a one-host, one-worker topology, deliberately sized for the two-person MVP.
It is not an HA or multi-tenant production topology.

## Required deployable units and durable storage

| Unit | Required responsibility | Persistent state / exposure |
| --- | --- | --- |
| TLS reverse proxy | Terminate HTTPS, redirect HTTP, forward only to `web`; set request-size/time limits suitable for WebSocket upgrades. | The only public listener. PostgreSQL, `worker`, and App Server have no public port. |
| `web` | SvelteKit pages/API, Better Auth session handling, Relay authorisation, WebSocket fan-out, read-model recovery endpoints. | Stateless other than configuration; horizontally scaling it is deferred. |
| `worker` | PostgreSQL lease claimant, AgentRun recovery/queue loop, Codex App Server parent, workspace lifecycle, GitHub-broker caller. | One active worker only; its process may restart without making a run successful by assumption. |
| PostgreSQL | Authoritative transactional database, AgentRun event/outbox store and lease coordination. | A private, durable database volume and a tested off-host backup destination. |
| Codex state volume | Owner-authorised managed-login credential store and persisted thread data. | Private to the worker OS identity; encrypted backup where recovery of that connection is required. |
| Agent workspace volume | One restricted worktree per AgentRun; contains repository working state until retained/cleaned under the run policy. | Not browser-readable; treat as sensitive and back it up only if its recovery value justifies it. |

Use a service supervisor or Compose-equivalent that restarts failed services and
waits for PostgreSQL health before starting dependent services. Compose, for example,
can gate a dependent service on a `service_healthy` healthcheck, but this is startup
ordering—not application recovery logic. [Docker Compose startup order and
healthchecks](https://docs.docker.com/compose/how-tos/startup-order/)

## Realtime transport and delivery contract

Use one authenticated, same-origin **WebSocket** endpoint in `web`, multiplexed by
the current Pilot member's workspace/channel subscriptions. It publishes compact
invalidations or summaries for new messages, AgentRun state/events, and approval or
clarification requests. On every connect/reconnect, the browser first fetches the
authorised current projection and events after its last Relay sequence, then resumes
the socket. A socket is therefore an acceleration path, not the record of work.

For the single host, `web` may receive worker wake-ups with PostgreSQL
`LISTEN`/`NOTIFY` and read the committed event/outbox row before fan-out. PostgreSQL
delivers a notification only after the notifying transaction commits and recommends
putting larger data in a table and sending a key; this makes it appropriate as a
wake-up signal, not as the durable event stream. [PostgreSQL
NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html) [PostgreSQL
LISTEN](https://www.postgresql.org/docs/current/sql-listen.html)

The transactionally persisted AgentRun event/outbox remains authoritative. If the
browser, WebSocket, `web`, or notification listener is unavailable, reconnect and
outbox processing recover visible status without fabricating an execution result.
This directly carries forward the Recoverable AgentRun decision.

## Configuration, secrets, and access boundaries

Provision a root-owned deployment configuration file or secret manager, inject only
the secrets needed by each service, and never expose them to browser JavaScript,
logs, AgentRun prompts, or worktrees.

| Secret / configuration | Holder | Rule |
| --- | --- | --- |
| database URL and session/auth secrets | `web` (and database URL to `worker`) | Separate least-privilege database roles where practical; database not Internet-reachable. |
| Relay encryption key | server processes that encrypt/decrypt provider connection material | Back up/recover it with the encrypted data; rotation is an operator procedure. |
| GitHub App private key, installation ID, webhook secret | GitHub broker only | Mint short-lived installation tokens server-side; neither browser nor unrestricted agent shell receives them, per the existing GitHub decision. |
| Codex managed-login credential store | worker/App Server OS identity only | The Provider account owner completes the documented managed login locally; do not collect passwords or copy browser session tokens. |
| TLS certificate material | reverse proxy only | Renew automatically and keep HTTP closed/redirected. |

Bind all inter-service communication to localhost or a private container network.
Every WebSocket upgrade must validate the server-side session and current
workspace-membership authorisation, then re-check it for subscriptions/actions; a
cookie is not a role grant.

## Database migrations, backup, and deploy behaviour

Run schema migrations as an explicit, versioned, single-run deployment step using
the same release artifact, before admitting the new `web`/`worker` version. Maintain
an application-schema version row and refuse normal startup when the binary and
schema are incompatible. Keep Better Auth migrations restricted to its `auth` schema
and Relay domain migrations in `public`, as decided in the authentication finding.

Use expand/contract migrations: first deploy additive, backwards-compatible schema
changes; switch both processes; only remove old columns/behaviour in a later release.
Do not run destructive migrations while an old worker might still write the old
schema. Take and verify a backup before any irreversible migration.

Perform scheduled off-host PostgreSQL backups and regularly test restoration into an
isolated database. `pg_dump` creates a consistent backup without blocking normal
readers/writers; `pg_dumpall --globals-only` is additionally needed if roles or other
cluster-global objects must be recreated. [PostgreSQL `pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html)
[PostgreSQL backup and restore](https://www.postgresql.org/docs/current/backup.html)

Deployment sequence:

1. Verify the database backup and migration plan, then put `web` into maintenance
   for new state-changing requests (or briefly stop it).
2. For a web-only release, migrate compatibly, replace `web`, and let browsers
   reconnect/replay from durable sequences. Leave `worker` running.
3. For a worker release, first mark it draining: it claims no new AgentRuns and
   completes or reaches a safe waiting boundary for its current run. Replace it only
   then. If a forced restart loses an in-flight provider connection, let the lease
   expire and apply the established recovery rule: reconcile the stored thread and
   pause an indeterminate turn rather than replaying repository side effects.
4. Start/health-check `web`, drain the transactional outbox, and remove maintenance.

## Object storage

Do **not** deploy S3-compatible object storage initially. The MVP's primary artifact
is a GitHub pull request; messages, event summaries, approval records, and artifact
links fit in PostgreSQL. Codex thread data and worktrees need filesystem volumes, not
an object-store API. Introduce object storage only when the MVP accepts durable
user-uploaded files, large generated artifacts, or backup retention that the local
volumes cannot safely provide. At that point, store object metadata/authorisation in
PostgreSQL and private object bytes in an S3-compatible store; do not make arbitrary
agent workspace files browser-downloadable.

## Explicit deferrals and acceptance checks

Defer Redis, Temporal, Kubernetes, multiple workers, multi-host WebSocket fan-out,
managed database failover, S3/object storage, public App Server access, external
identity provider, multi-workspace operations, and high-availability/zero-downtime
deployments. Add them only in response to measured concurrency, file-storage,
availability, or tenant-isolation needs.

Before treating the topology as operable, demonstrate:

1. both Pilot members can sign in over HTTPS, invoke the shared MVP engineering
   agent, and receive/recover WebSocket status after a browser or `web` restart;
2. a `web` deployment leaves an active AgentRun running, and a `worker` kill follows
   the recorded lease/thread reconciliation path without duplicate GitHub writes;
3. the GitHub App can make the permitted branch/commit/PR operations only, while
   no token/private key is observable in the browser or agent workspace;
4. a restore drill reconstructs a fresh PostgreSQL instance from the scheduled
   backup and Relay can read its AgentRun history; and
5. an operator can rotate each secret and revoke the owner connection without
   exposing credentials or leaving new runs able to use it.

## Relationship to existing findings

This note operationalises, rather than supersedes,
[the self-hosted authentication decision](self-hosted-authentication-and-pilot-membership.md),
[the GitHub access decision](github-linked-pilot-repository-access-enforcement.md),
and [the Recoverable AgentRun architecture](recoverable-agentrun-execution-architecture.md).
There is no checked-in ADR that conflicts with this topology.
