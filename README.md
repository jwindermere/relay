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
returns `200` only when PostgreSQL is reachable and both the `relay` and `auth`
schemas match the binary's required versions. The worker reports readiness and
database health as structured log events. Both processes exit before normal startup
when the database is unreachable or incompatible.

Migrations are an explicit deployment step and run automatically as a one-shot
Compose service before web or worker starts:

```sh
DATABASE_URL=postgres://relay:relay@localhost:5432/relay npm run db:migrate
```

For local development, run `npm run dev:web` and `npm run dev:worker` separately
after migrating PostgreSQL. Useful checks are `npm run check`, `npm run build`, and
`npm test`. Database integration tests use a disposable PostgreSQL container, or an
existing database supplied with `TEST_DATABASE_URL`.

## Prototypes

The existing prototypes still prove persistent Codex-backed AgentRun execution
through the owner's local Codex/ChatGPT login and the accepted Channel interaction.
See [prototype/README.md](prototype/README.md).
