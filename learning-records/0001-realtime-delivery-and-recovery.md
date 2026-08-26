# Durable history is separate from realtime delivery

The user successfully drove both pilot-member views through missed wake-ups,
reconnection, a web restart, and worker loss. They established that web restarts
must not alter durable AgentRun history and corrected the key recovery distinction:
an unknown worker outcome pauses for human review because automatic replay could
duplicate repository side effects.
