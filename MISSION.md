# Mission: Evaluate the Relay realtime AgentRun prototype

## Why
Make an informed product and architecture decision for the Relay MVP by experiencing how both pilot members receive and recover AgentRun updates during normal operation and failures.

## Success looks like
- Explain the roles of the durable event log, outbox, WebSocket wake-up, and member cursor
- Drive the prototype through offline, missed-wake-up, web-restart, and worker-loss cases
- Accept the candidate contract or identify a behavior that should change

## Constraints
- Judge behavior, not implementation detail or visual polish
- Keep the lesson short and grounded in the active Wayfinder ticket

## Out of scope
- Production database schema, SvelteKit implementation, and UI styling
