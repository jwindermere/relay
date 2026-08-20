import { createInterface } from "node:readline";
import {
  createPrototypeState,
  prototypeContract,
  reduce,
} from "./realtime-agent-run-model.mjs";

let state = createPrototypeState();
const input = createInterface({ input: process.stdin, output: process.stdout });

render();
input.on("line", (line) => {
  const key = line.trim().toLowerCase();
  if (key === "q") return input.close();

  const action = {
    a: { type: "advance" },
    m: { type: "commit_without_wakeup" },
    o: { type: "drain_outbox" },
    d: { type: "duplicate_wakeup" },
    "1": { type: "toggle_client", client: "pilotA" },
    "2": { type: "toggle_client", client: "pilotB" },
    x: { type: "restart_web" },
    k: { type: "worker_loss" },
    z: { type: "reset" },
  }[key];

  state = reduce(state, action ?? { type: `unknown:${key}` });
  render();
});

function render() {
  console.clear();
  console.log("\x1b[1mPROTOTYPE — durable realtime AgentRun delivery\x1b[0m");
  console.log("Does commit-first sequence reconciliation keep both pilot members informed through missed wake-ups and restarts?\n");
  console.log(`\x1b[1mLast action\x1b[0m ${state.lastAction}`);
  console.log(`\x1b[1mDurable AgentRun\x1b[0m status=${state.durable.run.status} latestSequence=${state.durable.run.latestSequence}`);
  console.log(`\x1b[1mDurable outbox\x1b[0m pending=${state.durable.outbox.filter((entry) => !entry.dispatched).length}`);
  console.log(`\x1b[1mWeb process\x1b[0m epoch=${state.web.epoch} socket=${state.web.socketAvailable ? "available" : "down"}`);
  console.log(`\x1b[2mDelivery: ${prototypeContract.delivery}\x1b[0m`);
  console.log(`\x1b[2mRecovery: ${prototypeContract.recovery}\x1b[0m\n`);

  console.log("\x1b[1mDurable event log\x1b[0m");
  if (!state.durable.events.length) console.log("  (empty)");
  for (const event of state.durable.events.slice(-7)) {
    console.log(`  #${event.sequence} ${event.type.padEnd(8)} ${event.status.padEnd(18)} ${event.summary}`);
  }

  console.log();
  for (const client of Object.values(state.clients)) renderClient(client);

  console.log("\n\x1b[1mActions\x1b[0m");
  console.log("[a] advance normal run  [m] commit + miss wake-up  [o] drain outbox");
  console.log("[d] duplicate wake-up   [1] toggle Pilot A        [2] toggle Pilot B");
  console.log("[x] restart web         [k] lose worker           [z] reset  [q] quit");
  process.stdout.write("> ");
}

function renderClient(client) {
  const connection = client.connected ? "connected" : "offline";
  console.log(`\x1b[1m${client.name}\x1b[0m ${connection} cursor=${client.cursor} status=${client.runStatus}`);
  const lastUpdates = client.channelUpdates.slice(-3);
  if (!lastUpdates.length) console.log("  shared channel: (no AgentRun updates)");
  for (const update of lastUpdates) {
    console.log(`  shared channel #${update.sequence}: ${update.summary}`);
  }
}
