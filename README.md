# relay

Relay's production foundation is a SvelteKit web service, an independently managed
worker, and PostgreSQL. The disposable product and execution prototypes remain under
[`prototype/`](prototype/README.md) as design evidence; production code lives under
[`src/`](src/).

## Local production stack

Copy `.env.example` to `.env`, then start the production-shaped stack:

```sh
docker compose up --build
```

The web service is available at <http://localhost:3000>. Its `GET /health` endpoint
returns `200` only when PostgreSQL is reachable and both the Relay migration stream
in `public` and the Better Auth migration stream in `auth` match the binary's required
versions. The worker reports readiness and database health as structured log events.
Both processes exit before normal startup when the database is unreachable or
incompatible.

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
See [prototype/README.md](prototype/README.md).
