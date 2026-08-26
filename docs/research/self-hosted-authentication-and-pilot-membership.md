# Self-hosted authentication and pilot membership model

## Decision

Use **Better Auth with PostgreSQL-backed opaque sessions**, mounted in the Relay
SvelteKit server hook.  Relay, not the authentication library's organisation
plugin, owns the **MVP pilot workspace**, **Pilot member**, invitation, and
provider-connection records.

Start with invite-only email-and-password sign-in plus mandatory verified email
before a person can accept an invitation. Add passkeys as an optional second
factor/sign-in method once the pilot's email flow is proven. Public sign-up is
off: the first Provider account owner is bootstrapped locally, and thereafter an
existing owner creates an invitation for the other pilot member.

This fits the one-host, two-person **Self-hosted MVP** and maintains the existing
decision that the Codex/ChatGPT credential belongs to a **Provider account owner**,
not to the shared **MVP engineering agent**.

## Why this option

Better Auth has a documented SvelteKit integration: its handler runs in the server
hook and the application can put the authenticated session/user on `event.locals`
for server-side authorisation. Its PostgreSQL adapter accepts a normal `pg` pool and
supports schema migration. [SvelteKit integration](https://better-auth.com/docs/integrations/svelte-kit)
[PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql)

Keep its tables in an `auth` PostgreSQL schema and Relay's domain tables in `public`.
The adapter documents use of `search_path` for a non-default schema and limits its
migrations to that configured schema. [Better Auth PostgreSQL schemas](https://better-auth.com/docs/adapters/postgresql#use-a-non-default-schema)

Better Auth's organisation plugin does model invitations and roles, but its
documentation is currently labelled **v1.8 (Beta)**. It would also make a library
schema the source of truth for Relay's product concepts. Do not adopt that plugin
for the MVP; retain the small, explicit Relay model below. [Organisation plugin](https://better-auth.com/docs/beta/plugins/organization)

### Viable alternatives considered

| Option | Result |
| --- | --- |
| Better Auth + Relay-owned workspace/membership | **Choose.** Gives the SvelteKit/PostgreSQL integration needed now without another operated service or surrendering the domain boundary. |
| Better Auth organisation plugin | Do not choose for the MVP: it is on the beta documentation track and duplicates the product's workspace/membership model. Its invitation guidance nevertheless confirms the important security property that acceptance should bind to the invited email and a logged-in session. [Invitation acceptance](https://better-auth.com/docs/beta/plugins/organization#accept-invitation) |
| Auth.js | Viable for identity/session handling; it has a SvelteKit handler. It still leaves invitations, workspace membership, and provider ownership to Relay, so offers no material MVP advantage over Better Auth here. [Auth.js SvelteKit example](https://authjs.dev/) |
| A separately operated identity provider (for example Keycloak) | Defer. It adds a security-critical service, lifecycle, and administration surface to a two-person, single-host pilot while Relay would still need its own workspace and provider-connection authorisation. |
| Build password/session handling in Relay | Reject. It enlarges the security-sensitive surface without advancing the pilot question; use a maintained authentication library instead. |

## Minimal roles and durable data boundaries

Only two workspace-scoped roles are needed:

| Role | May | May not |
| --- | --- | --- |
| `owner` | invite/revoke Pilot members; manage the MVP pilot workspace; initiate, disconnect, and replace the owner-owned Codex connection; invoke the shared agent | transfer a provider connection to another person without that person's fresh authorisation |
| `member` | view/use the workspace and invoke the shared MVP engineering agent within its established autonomy boundary | invite or revoke members; create, read, export, disconnect, or replace another person's provider credential |

The initial workspace has exactly one `owner` and one `member`. Model role on the
membership, rather than as a global user role, even though the MVP has one workspace.
It preserves the correct boundary if a later user belongs to more than one workspace.

| Boundary | Minimum fields and rules |
| --- | --- |
| `auth.user`, `auth.session`, `auth.account` | Managed only by Better Auth. Relay reads the stable user ID/session identity; it never stores raw passwords. Session cookies are the browser credential, not a workspace role grant. |
| `public.workspace` | `id`, name, timestamps. Create only through the local bootstrap transaction. |
| `public.workspace_membership` | `workspace_id`, `user_id`, `role`, joined/revoked timestamps; unique `(workspace_id, user_id)`. Every Relay server action/load resolves this record after session validation. |
| `public.workspace_invitation` | random, single-use token **hash**; workspace, invitee email, intended role, inviter, expiry, accepted/revoked timestamps. Acceptance requires an authenticated user with a verified email matching the invitation, then consumes the invitation and creates membership in one transaction. |
| `public.provider_connection` | `id`, `workspace_id`, `owner_user_id`, provider kind, state, timestamps and encrypted credential-reference/secret material. The `(workspace_id, provider kind)` uniqueness constraint enforces the MVP's one connected provider account; `owner_user_id` must reference a current owner membership. Never expose tokens to a member or to client JavaScript. |
| AgentRun and channel data | Authorise through current workspace membership. Store only a connection ID/audit reference, never a credential in an AgentRun or message. The worker receives the connection only through a server-side, least-privilege execution path. |

Use foreign keys and unique/check constraints for the relationships above, and
perform invitation acceptance, membership creation, and connection ownership changes
in database transactions. PostgreSQL documents foreign-key constraints as the
referential-integrity mechanism. [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK)

The web/API uses a privileged server database role, so database row-level security
is not the primary authorisation mechanism for this MVP: PostgreSQL notes that table
owners normally bypass RLS and roles with `BYPASSRLS` always do. Enforce membership
in Relay's server-side query/service boundary, keep the database unreachable from
browsers, and consider RLS later only with a deliberately non-owner application role.
[PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

## Request and session rules

1. Mount Better Auth in `hooks.server.ts`; obtain the session server-side and attach
   only identity/session data to `event.locals`. Better Auth documents that this
   population is explicit rather than automatic. [SvelteKit integration](https://better-auth.com/docs/integrations/svelte-kit)
2. For each protected load, action, endpoint, WebSocket upgrade, and worker command,
   resolve `session.user.id` to a non-revoked workspace membership and make the
   role/connection-owner decision on the server. Never rely on a role supplied by
   the browser or cached only in a cookie.
3. Send an invitation email with an unguessable raw token only in the URL; retain
   its hash and expiry. On acceptance, require verified-email proof and match the
   email exactly under the chosen normalisation rule. This mirrors the stricter
   invitation guidance in Better Auth's official organisation documentation.
   [Email-verification requirement](https://better-auth.com/docs/beta/plugins/organization#email-verification-requirement)
4. Use HTTPS in the deployed MVP, secure/HTTP-only/same-site session cookies, CSRF
   protection for state-changing browser requests, rate limits on sign-in/reset/
   invitation endpoints, and audit events for membership and provider-connection
   changes. These are implementation requirements, not claims supplied by the
   library.

## Provider-connection ownership flow

An `owner` starts a server-side “connect Codex” flow. Relay records a pending
`provider_connection` associated with that owner's user ID, then lets that owner
complete the documented Codex managed login in the locally supervised execution
environment. Relay records only the connection state/reference required to use it;
the protected Codex credential store remains outside normal user-visible data.
Both Pilot members may delegate work through the shared channel, but the execution
uses the owner-authorised connection under the established MVP engineering autonomy
policy. Disconnect/replacement is owner-only and must invalidate the worker's
connection reference before deleting/revoking any credential material.

This remains consistent with the prior conclusion that managed ChatGPT OAuth is the
owner-operated MVP route and that copied session tokens/password collection are not
appropriate application credentials. [Codex account MVP research](codex-chatgpt-account-mvp.md)

## Delivery slice

Implement in this order:

1. PostgreSQL schemas/migrations and local bootstrap for one owner and one MVP pilot
   workspace.
2. Better Auth email/password + verified email + SvelteKit hook/session boundary.
3. Relay membership resolver and owner/member guards, used by every protected route.
4. Owner-issued, expiring, single-use invitation flow and audit trail.
5. Owner-only provider-connection lifecycle, then the existing AgentRun worker uses
   the connection reference.

Defer social login, SSO/SCIM, multi-workspace switching, self-service workspace
creation, delegated organisation administration, and a second provider account.
