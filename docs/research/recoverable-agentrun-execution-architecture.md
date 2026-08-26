# Recoverable AgentRun execution architecture

## Decision

For the self-hosted MVP, run Relay as three independently restartable concerns:

```text
Browser
  │
Relay web/API ─────────────── PostgreSQL
                                ├─ AgentRun current state
                                ├─ append-only AgentRun events
                                ├─ execution lease / attempt
                                └─ transactional notification outbox
  │
  └── execution worker ── local stdio ── codex app-server
          │                              │
          └── per-AgentRun workspace     └── persistent Codex state volume
```

The web/API process never owns Codex child processes. One separately supervised
execution worker claims an AgentRun with a database lease, starts (or reconnects to)
a local `codex app-server` over stdio, and has exclusive ownership of that run's
workspace and active provider turn. PostgreSQL is Relay's source of truth; Codex's
persisted thread is a recovery input, not Relay's user-visible history.

This is the smallest topology that meets the glossary's definition of a
**Recoverable AgentRun**: a web-server restart or deployment does not terminate the
worker, and a worker restart has sufficient durable information to reconcile instead
of guessing. It is intentionally a one-host, single-owner MVP architecture, not a
multi-tenant control plane.

## Why this boundary

The documented App Server is the Codex integration surface for product clients that
need authentication, conversation history, approvals, and streamed events. It
supports stdio, Unix sockets, and WebSocket transports; WebSocket transport is
experimental and unsupported for production workloads. The product therefore does
not need to expose an App Server network listener: a worker-local stdio child keeps
the attack surface and lifecycle small. [App Server overview and transports](https://learn.chatgpt.com/docs/app-server)

The same documentation recommends the Codex SDK for automation and CI. This finding
therefore answers the ticket under the repository's prior, owner-operated App Server
prototype decision; it does **not** establish App Server as the long-term production
automation boundary. Revisit the runtime adapter before multi-tenant or unattended
production use.

App Server's lifecycle is connection-local but its thread store is persistent:
clients start or resume a thread, start a turn, consume notifications, and receive
`turn/completed` as the terminal result. Stored threads can be read without resuming
and an earlier `thread.id` can be resumed from a new connection. [Lifecycle](https://learn.chatgpt.com/docs/app-server#lifecycle-overview) [Threads](https://learn.chatgpt.com/docs/app-server#threads) [Start or resume a thread](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread)

That supports history and reconciliation after a process restart, but OpenAI does
not document a promise that an in-flight turn continues across App Server process
loss, nor an exactly-once execution guarantee. Treat a lost worker/App Server
connection as **unknown**, never as success or as permission to blindly replay work.
This is also consistent with `thread/fork`: an in-progress source turn cannot be
copied as a normal completed turn and is instead marked interrupted when forked
without a completed boundary. [Fork semantics](https://learn.chatgpt.com/docs/app-server#start-or-resume-a-thread)

The checked-in prototype already validates the local route: it persists the
provider `threadId` and each `turnId`, records streamed lifecycle events, resumes a
thread in a new process, and confirms cancellation only when a later
`turn/completed` says `interrupted`. It is useful evidence for the boundary, but its
JSON artifact is deliberately not a concurrent, transactional production store.

## Durable state and event contract

Persist these in one PostgreSQL transaction where applicable:

| Record | Minimum durable fields | Purpose |
| --- | --- | --- |
| `AgentRun` | id, request/message reference, state, desired state, workspace reference, provider, provider thread ID, active turn ID, attempt number, lease owner/expiry, timestamps | The stable product object and recovery cursor. |
| `AgentRunEvent` | run ID, monotonic Relay sequence, observed time, provider item/turn ID when present, type, safe payload/summary | Immutable user-visible history and audit trail. |
| notification outbox | event ID, destination/channel, delivery state | Allows committed run history to be delivered after an API/realtime outage. |

Create the AgentRun as `queued`, claim it under a lease, then atomically persist the
thread ID before sending work and the turn ID before treating the turn as
recoverable. Append provider notifications idempotently (provider item ID plus event
kind where available); emit a Relay sequence for ordering. Preserve concise status,
tool/action summaries, approval/clarification requests, terminal result, and links
to artifacts—not an assumption that a connected browser retained the stream.

`item/completed` is the authoritative final item state, and `turn/completed` carries
only `completed`, `interrupted`, or `failed` as a terminal turn status. [Turn and item events](https://learn.chatgpt.com/docs/app-server#turn-events) A Relay status projection may be rebuilt from these events; it must not infer
completion from a quiet socket.

## Recovery semantics

1. On worker startup and periodically, reclaim only expired leases for non-terminal
   AgentRuns. A running worker renews its lease; a second worker must not own the
   same run.
2. Put a reclaimed run in visible `recovering` status and read its recorded provider
   thread first with `thread/read`. Record the reconciliation result as a Relay
   event.
3. If the stored provider turn is terminal, append/reconcile its authoritative
   terminal event and project the matching Relay state.
4. If the turn cannot be established as terminal, retain the prior work and move the
   run to `paused`/`waiting_for_approval` with an explicit “execution interrupted by
   recovery” event. A human may resume by creating a new turn on the stored thread,
   after seeing the history and workspace state. Automated retry is permissible only
   for a separately classified idempotent action; it must be a new attempt, never a
   claim that the original turn continued.
5. On a normal web/API restart, no recovery action is needed beyond reconnecting
   clients and draining the outbox: the worker and provider process remain alive.

This distinguishes surviving a web deployment from recovering a worker failure and
avoids duplicate repository side effects.

## Cancellation

Cancellation is a durable intent first: transactionally record `cancel_requested`,
publish it to the worker, then call `turn/interrupt` using the persisted thread and
turn IDs. Keep the AgentRun non-terminal until the worker receives or reconciles a
terminal provider event. A successful interrupt ends as `interrupted`; after a
worker failure, recovery repeats reconciliation before reporting the outcome.
[Interrupt a turn](https://learn.chatgpt.com/docs/app-server#interrupt-a-turn)

## Infrastructure baseline and limits

Use one self-hosted deployment unit (host, VM, or equivalent) with:

- a web/API service;
- one supervised execution-worker service;
- PostgreSQL with backups;
- persistent storage for the owner-authorized Codex credential/thread store and for
  per-AgentRun workspaces; and
- a process supervisor/health checks and orderly worker draining during deployments.

No Redis, Temporal, Kubernetes, distributed event bus, or externally exposed App
Server listener is justified for this MVP. PostgreSQL leases and the transactional
outbox supply the required queue/recovery mechanics. Introduce a dedicated queue or
multi-worker scheduler only when measured concurrency, isolation, or throughput
requires it.

Use a distinct workspace (for example a worktree) per AgentRun and restrict each
turn to that workspace, with restricted reads and network disabled unless explicitly
approved. App Server supports per-turn workspace-write policies and permission
controls; its `thread/shellCommand` and explicit process APIs run outside the
sandbox, so Relay must not expose them as autonomous agent operations. [Sandbox and approval policy](https://learn.chatgpt.com/docs/app-server#sandbox-policy) [Thread shell commands](https://learn.chatgpt.com/docs/app-server#run-a-thread-shell-command) [Process execution](https://learn.chatgpt.com/docs/app-server#process-execution)

## Consequences

- An AgentRun is independent of a channel message and of a particular live process,
  preserving the established domain model.
- The product can show durable, attributed history through API/realtime outages and
  can safely surface waiting/recovery states.
- In-flight execution has **at-least-once recovery management**, not exactly-once
  provider execution. Side-effecting work remains protected by workspace isolation,
  explicit GitHub permissions, and human approval where required.
- App Server remains the supported owner-operated prototype integration, but its
  experimental remote transport and lack of a documented account-level concurrency
  guarantee mean Relay must queue runs and keep the integration local for the MVP.
  [App Server remote-host guidance](https://learn.chatgpt.com/docs/app-server#connect-a-remote-code-mode-host)
