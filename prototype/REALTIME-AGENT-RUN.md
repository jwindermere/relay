# Realtime AgentRun status prototype

> **PROTOTYPE — throw this away after the delivery contract is decided.**

## Question

Does a commit-first, sequence-reconciled AgentRun model give both pilot members
concise shared-channel status through a dropped realtime wake-up, a browser
reconnect, a Relay web restart, and an indeterminate worker failure—without
duplicating updates or replaying provider side effects?

This is a logic prototype, not production SvelteKit code. Its pure model uses plain,
JSON-shaped state and actions so the same boundary can be exercised later from
SvelteKit load functions, authenticated endpoints, and WebSocket handlers. The
terminal shell exists only to make failure cases easy to drive by hand.

## Run it

```sh
npm run prototype:realtime-agent-run
```

Enter one action per line. A useful review path is:

1. Press `a` three times to reach working.
2. Press `2` to take Pilot B offline.
3. Press `a`, then `m`, to commit activity while Pilot B is absent and deliberately
   drop one wake-up. The durable outbox should show one pending entry.
4. Press `o` to simulate the web process's outbox retry. Pilot A should catch up and
   the pending count should return to zero.
5. Press `2` to reconnect Pilot B. Their cursor should catch up from the durable log.
6. Press `d`. Neither member should gain duplicate channel updates.
7. Press `x` to restart the web process, then `1` and `2` to reconnect both members.
   The AgentRun and cursors should reconcile without losing or duplicating events.
8. Reset with `z`, advance to working, then press `k`. The run should become
   `paused` after recovery, with no automatic replay.

## Candidate answer to validate

- Persist each safe, user-visible AgentRun event, its outbox entry, and the current
  status update in one transaction, using a per-run monotonic sequence.
- Retry undispatched outbox entries so a lost PostgreSQL wake-up does not strand a
  committed event.
- Publish only a compact WebSocket wake-up after commit. A wake-up is not delivery
  and may be lost or repeated.
- On connect/reconnect and every wake-up, fetch authorised events after the member's
  last applied sequence. Apply them in order and ignore already-applied sequences.
- Show one AgentRun status projection plus concise activity/result entries in the
  shared agent channel; keep provider internals and private reasoning out of it.
- A web restart only drops sockets. A worker/provider loss with an unknown outcome
  records `recovering`, then `paused`, and requires human review before a new turn.

## Verdict

Accepted through hands-on review with both simulated pilot-member views on
2026-08-20. Commit-first durable events plus an outbox, best-effort WebSocket
wake-ups, per-member sequence reconciliation, restart-safe web delivery, and a
human-reviewed pause after an indeterminate worker failure are sufficient for the
MVP specification.
