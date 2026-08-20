const normalJourney = [
  { type: "status", status: "queued", summary: "Engineering request queued" },
  { type: "status", status: "planning", summary: "Planning the repository change" },
  { type: "activity", status: "working", summary: "Inspecting the affected code" },
  { type: "activity", status: "working", summary: "Implementing the change" },
  { type: "status", status: "waiting_for_input", summary: "Waiting for a pilot member to clarify the acceptance case" },
  { type: "activity", status: "working", summary: "Clarification received; running checks" },
  { type: "result", status: "completed", summary: "Pull request ready for review" },
];

export function createPrototypeState() {
  return {
    clock: 0,
    journeyStep: 0,
    durable: {
      run: { id: "run-pilot-1", status: "not_started", latestSequence: 0 },
      events: [],
      outbox: [],
      nextSequence: 1,
    },
    web: { epoch: 1, socketAvailable: true },
    clients: {
      pilotA: createClient("Pilot A"),
      pilotB: createClient("Pilot B"),
    },
    lastAction: "Prototype initialised",
  };
}

export function reduce(previous, action) {
  const state = structuredClone(previous);
  state.clock += 1;

  switch (action.type) {
    case "advance": {
      const event = normalJourney[state.journeyStep];
      if (!event) {
        state.lastAction = "The normal journey is already terminal; reset to replay it";
        return state;
      }
      commit(state, event);
      state.journeyStep += 1;
      drainOutbox(state);
      state.lastAction = `Committed sequence ${state.durable.run.latestSequence} and sent a socket wake-up`;
      return state;
    }
    case "commit_without_wakeup":
      commit(state, {
        type: "activity",
        status: activeStatus(state),
        summary: "Checking the linked pilot repository (wake-up deliberately dropped)",
      });
      state.lastAction = "Committed an event but dropped its best-effort socket wake-up";
      return state;
    case "drain_outbox": {
      const pending = pendingOutboxCount(state);
      drainOutbox(state);
      state.lastAction = `Retried ${pending} committed outbox ${pending === 1 ? "entry" : "entries"}`;
      return state;
    }
    case "duplicate_wakeup":
      wakeConnectedClients(state);
      wakeConnectedClients(state);
      state.lastAction = "Sent the same wake-up twice; sequence reconciliation deduplicated it";
      return state;
    case "toggle_client": {
      const client = state.clients[action.client];
      client.connected = !client.connected;
      if (client.connected) reconcile(client, state.durable.events);
      state.lastAction = `${client.name} ${client.connected ? "reconnected and reconciled" : "disconnected"}`;
      return state;
    }
    case "restart_web":
      state.web.epoch += 1;
      state.web.socketAvailable = true;
      for (const client of Object.values(state.clients)) client.connected = false;
      state.lastAction = "Web restarted; sockets were lost, durable run state was unchanged";
      return state;
    case "worker_loss":
      commit(state, {
        type: "status",
        status: "recovering",
        summary: "Worker lease expired; reconciling the recorded provider turn",
      });
      commit(state, {
        type: "status",
        status: "paused",
        summary: "Execution outcome is unknown; human review is required before a new turn",
      });
      drainOutbox(state);
      state.lastAction = "Worker loss reconciled to paused; no execution was replayed";
      return state;
    case "reset":
      return createPrototypeState();
    default:
      state.lastAction = `Unknown action: ${action.type}`;
      return state;
  }
}

export const prototypeContract = {
  delivery: "Commit event and outbox together; retry undispatched outbox entries; reconnect and every socket wake-up fetch events after the member cursor; duplicates are harmless.",
  recovery: "A web restart drops sockets only. An indeterminate worker/provider loss records recovery and pauses the AgentRun; it never silently replays side effects.",
};

function createClient(name) {
  return {
    name,
    connected: true,
    cursor: 0,
    runStatus: "not_started",
    channelUpdates: [],
  };
}

function activeStatus(state) {
  return state.durable.run.status === "not_started" ? "queued" : state.durable.run.status;
}

function commit(state, event) {
  const committed = {
    sequence: state.durable.nextSequence++,
    observedAt: `T+${state.clock}`,
    ...event,
  };
  state.durable.events.push(committed);
  state.durable.outbox.push({ sequence: committed.sequence, dispatched: false });
  state.durable.run.status = committed.status;
  state.durable.run.latestSequence = committed.sequence;
}

function drainOutbox(state) {
  for (const entry of state.durable.outbox) entry.dispatched = true;
  wakeConnectedClients(state);
}

function pendingOutboxCount(state) {
  return state.durable.outbox.filter((entry) => !entry.dispatched).length;
}

function wakeConnectedClients(state) {
  if (!state.web.socketAvailable) return;
  for (const client of Object.values(state.clients)) {
    if (client.connected) reconcile(client, state.durable.events);
  }
}

function reconcile(client, events) {
  const missing = events.filter((event) => event.sequence > client.cursor);
  for (const event of missing) {
    client.runStatus = event.status;
    client.channelUpdates.push({
      sequence: event.sequence,
      type: event.type,
      summary: event.summary,
    });
    client.cursor = event.sequence;
  }
}
