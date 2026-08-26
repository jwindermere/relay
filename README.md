# relay

Relay's production foundation is a SvelteKit web service, an independently managed
worker, and PostgreSQL. The disposable product and execution prototypes remain under
[`prototype/`](prototype/README.md) as design evidence; production code lives under
[`src/`](src/).

## Local production stack

Copy `.env.example` to `.env`, provision the referenced secret files and off-host
backup mount, then bootstrap the production-shaped stack once:

```sh
docker compose up --build
```

For every later upgrade, use the drain- and compatibility-aware commands in
[`ops/README.md`](ops/README.md); do not repeat generic `docker compose up`.

Only the TLS proxy publishes a host port; the web service is available at the
configured `https://RELAY_HOSTNAME`. Its `GET /health` endpoint
returns `200` only when PostgreSQL is reachable and both the Relay migration stream
in `public` and the Better Auth migration stream in `auth` match the binary's required
versions. The worker reports readiness and database health as structured log events.
Both processes exit before normal startup when the database is unreachable or
incompatible.

Deployment replacement, backup restoration, migration compatibility, and independent
secret-rotation procedures are documented in [`ops/README.md`](ops/README.md).
The final two-member acceptance journey is driven by
[`ops/pilot-journey.sh`](ops/pilot-journey.sh); it combines the automated safety
contracts with real Pilot-member delegation and a durable evidence report.

The worker exclusively leases queued AgentRuns from PostgreSQL and runs one Codex
turn at a time through worker-local app-server stdio. Its Codex state and isolated
per-AgentRun workspaces live on private durable volumes, so browser and web-process
restarts do not interrupt active execution.

Migrations are an explicit deployment step and run automatically as a one-shot
Compose service before web or worker starts:

```sh
DATABASE_URL=postgres://relay:relay@localhost:5432/relay npm run db:migrate
```

For local development, run `npm run dev:web` and `npm run dev:worker` separately
after migrating PostgreSQL. Useful checks are `npm run check`, `npm run build`, and
`npm test`. Database integration tests use a disposable PostgreSQL container, or an
existing disposable database supplied with `TEST_DATABASE_URL`. A missing database
runtime fails the check; use `SKIP_DATABASE_TESTS=true` only when intentionally
running the non-database checks.

## Bootstrap and authentication

Public registration is disabled. After migrations have run, bootstrap the verified
Provider account owner and the single MVP pilot Workspace from the local terminal:

```sh
DATABASE_URL=postgres://relay:relay@localhost:5432/relay \
RELAY_OWNER_PASSWORD='use-a-long-unique-password' \
npm run bootstrap:owner -- \
  --email owner@example.com \
  --name 'Provider account owner' \
  --workspace 'MVP pilot workspace'
```

The command is one-time and fails without changing data after Relay has already been
bootstrapped. The password is read from the environment rather than a command-line
argument and is stored only as Better Auth's password hash. The owner can then sign
in at <http://localhost:3000/sign-in>. Browser sessions are opaque PostgreSQL-backed
Better Auth sessions; protected HTTP endpoints and the `/realtime` WebSocket resolve
the active Workspace membership on the server for each protected interaction.

The owner creates the second Pilot member's 24-hour invitation through
`POST /api/workspace/invitations`. The returned registration path creates only an
unverified account for the invited email. Relay then asks the configured email
delivery gateway to send Better Auth's one-hour verification link; the collaborator
must follow that link, sign in, and call the returned acceptance path. Acceptance
rechecks the verified session email and atomically creates the membership while
consuming the invitation.

Configure `RELAY_EMAIL_DELIVERY_URL` as an HTTPS endpoint that accepts this server-side
request (and `RELAY_EMAIL_DELIVERY_TOKEN` when it requires a bearer credential):

```json
{
  "to": "member@example.com",
  "template": "verify-relay-email",
  "verificationUrl": "https://relay.example/api/auth/verify-email?token=..."
}
```

The gateway response must be successful before registration reports success. Relay
stores neither the invitation's raw token nor the email-verification token.

## Prototypes

The existing prototypes still prove persistent Codex-backed AgentRun execution
through the owner's local Codex/ChatGPT login and the accepted Channel interaction.

## Codex Provider connection

An authenticated active Workspace owner can connect or replace the Workspace's Codex
Provider connection from the Channel sidebar. Relay starts the official managed ChatGPT
device-code flow through the local `codex app-server`; it never accepts an OpenAI API
key. Set `RELAY_CODEX_BIN` only when the `codex` executable is not available on the
service user's `PATH`.

The other Pilot member sees only whether the connection is ready. Codex retains its
managed credentials in the local service account's protected state, while Relay stores
only an opaque local reference and safe connection state. Disabling or disconnecting
the connection makes it unavailable for new Agent execution without deleting its row,
the Agent, Messages, or future execution history.

After connecting Codex and accepting a disposable engineering request, the Provider
account owner can prove the real managed-login execution path with:

```sh
DATABASE_URL=postgres://relay:relay@localhost:5432/relay \
RELAY_AGENT_WORKSPACE_ROOT=/tmp/relay-managed-login-smoke \
npm run smoke:codex-worker
```

The command claims exactly one queued AgentRun and succeeds only after the run has a
persisted `turn/completed` result. Run it with the continuously supervised worker
stopped so the smoke command can claim the prepared request.

## Two-member pilot proof

Run the repeatable acceptance wizard from the deployed checkout:

```sh
ops/pilot-journey.sh
```

The wizard keeps human-only browser, restart, worker-loss, and GitHub review actions
explicit. Its final command reads PostgreSQL and exits non-zero until both active
Pilot members have independently delegated, the required lifecycle evidence exists,
durable effects are unique, and a completed AgentRun exposes a real `github.com`
pull-request Artifact. Re-run only the report with:

```sh
docker compose exec web npm run start:verify-pilot
```

## Linked pilot repository

Configure a dedicated GitHub App with exactly these repository permissions: Metadata
read, Contents write, and Pull requests write. Do not grant account, organisation,
Administration, Actions, Workflows, Deployments, or other repository permissions. Set
`RELAY_GITHUB_APP_ID` and `RELAY_GITHUB_PRIVATE_KEY`, then install the App using
**Only select repositories** and select the one pilot repository.

The active Workspace owner links the resulting installation ID in Relay and may name
release branches in addition to the repository's server-resolved default branch.
Relay discovers the sole selected repository through GitHub, stores stable installation,
repository, owner, and node identities, and verifies every configured branch. The
Workspace-owned GitHub connection remains a separate credential boundary from the
Project's Linked pilot repository. Agent
execution remains unavailable unless active rules require a pull request with at least
one review by someone other than the last pusher, dismiss stale approvals, require at
least one status check, block force pushes and deletion, and do not let the Relay App
bypass the ruleset. The owner can re-verify or disable the link from the Channel
sidebar; other Pilot members see readiness without sensitive connection configuration.

The worker checks out repository content through the server-side broker into a
credential-free local Git workspace. It publishes only the AgentRun's `relay/<AgentRun>`
branch and pull request after Codex completes; installation tokens remain inside the
broker. A completed request posts one concise Agent result Message and exposes its
single pull-request Artifact as a GitHub review link to both Pilot members. Configure
`RELAY_GITHUB_WEBHOOK_SECRET` on both Relay and the App webhook at
`POST /api/github/webhooks` so signed deliveries can be deduplicated and correlated.

To exercise the complete boundary against a disposable protected repository, provide
`RELAY_GITHUB_CONTRACT_INSTALLATION_ID`, `RELAY_GITHUB_CONTRACT_REPOSITORY_ID`,
`RELAY_GITHUB_CONTRACT_REPOSITORY_OWNER`, `RELAY_GITHUB_CONTRACT_REPOSITORY_NAME`, and
`RELAY_GITHUB_CONTRACT_DEFAULT_BRANCH` alongside the App credentials, then run
`npm run test:github-contract`. Each run deliberately leaves its topic branch and
open pull request as reviewable evidence because deletion and merge are forbidden.

See [prototype/README.md](prototype/README.md).
