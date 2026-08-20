# Persistent Codex-backed AgentRun prototype

This disposable proof starts the locally authenticated `codex app-server`, creates a
thread, starts a real turn, records its streamed lifecycle, and writes an inspectable
AgentRun artifact to `prototype/runs/`.

## Run it

The owner must already be authenticated through the supported managed flow:

```sh
codex login status
npm run prototype:agent-run -- --prompt "Inspect README.md and report its title."
```

Send follow-up input on the same persisted thread:

```sh
npm run prototype:agent-run -- \
  --prompt "Inspect README.md and report its title." \
  --follow-up "Now restate that title in uppercase."
```

Prove cancellation by interrupting a real turn after a short delay:

```sh
npm run prototype:agent-run -- \
  --workspace /tmp \
  --prompt "Think through a long list of numbers without accessing any files." \
  --cancel-after-ms 1000
```

`--workspace` defaults to the repository root. Point it at a disposable directory
when the proof should not provide repository context.

The JSON artifact contains the thread ID, turn IDs, all protocol events and the
integration constraints the Relay AgentRun contract must accommodate. The run output
is intentionally ignored by Git because it may contain workspace-specific details.

The artifact is written immediately after `thread/start` and each `turn/start`, so a
new process can reopen it with `--resume path/to/artifact.json` and then send a
follow-up turn. The provider's locally persisted thread history must remain available.

## What this establishes

- The existing local ChatGPT-authenticated Codex installation can back a real turn;
  no API key is used by this prototype.
- `threadId` and `turnId` are the durable provider identifiers Relay needs to retain.
- `item/started`, `item/completed` and `turn/completed` make lifecycle status visible.
- A follow-up is a second `turn/start` on the same thread.
- Cancellation is an asynchronous `turn/interrupt`, confirmed only by a later
  `turn/completed` event.
- The integration is experimental; capacity follows the owner's plan/rate limit and
  has no documented account-level concurrency guarantee, so Relay must queue runs.

This deliberately does not expose a network listener, collect provider credentials,
or make a multi-user control plane. Those are product concerns outside the smallest
supported local proof.
