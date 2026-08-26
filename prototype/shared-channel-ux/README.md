# Shared-channel AgentRun UX prototype

> **PROTOTYPE — throw this away after the interaction decisions are captured.**

## Question

What lightweight SvelteKit plus daisyUI experience most clearly lets two authenticated pilot members delegate repository work to the MVP engineering Agent in a shared Channel, follow concise status, answer a clarification, understand restart recovery, and review a pull-request Artifact?

## Run it

From the repository root:

```sh
npm run prototype:shared-channel-ux -- --open
```

The accepted **Channel chronicle** route keeps the familiar shared Channel clean. Humans and Agents share one Direct messages list, Agent status expands on hover/focus, and progress is requested through the ordinary message composer.

Use the Jules/Ravi switcher to change the authenticated pilot view. Advance the eight-step scenario to exercise the accepted mention, concise activity, clarification answer attribution, continued work, web-process restart and reconciliation, and completed pull-request Artifact.

No action mutates real data. All state is in memory and reloads reset the journey.

## Verdict

Accepted through hands-on review on 2026-08-20.

- Keep the primary surface familiar and Channel-first, following the interaction shape of Slack or Mattermost.
- Permit the MVP engineering Agent to be mentioned in any eligible Project-linked Channel; `#agent-work` is an example, not a privileged Agent-only Channel.
- Keep the Channel clean rather than showing a permanent AgentRun panel or a special progress shortcut.
- Put humans and Agents together under Direct messages. Show Alex's concise current status there and reveal Task detail on hover or keyboard focus.
- Let a pilot ask `@Alex` for progress through the ordinary message composer and receive a concise conversational update.
- Surface only exceptional lifecycle moments in the Channel: clarification, restart/recovery, result, and the pull-request Artifact.
- Keep provider internals, durable sequence numbers, worker details, and raw reasoning out of the everyday collaboration UI.
