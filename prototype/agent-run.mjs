import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const repositoryDirectory = resolve(process.cwd());
const outputDirectory = resolve(repositoryDirectory, "prototype/runs");
const argumentsByName = new Map(
  process.argv.slice(2).map((argument, index, argumentsList) => [
    argument,
    argumentsList[index + 1],
  ]),
);
const prompt = argumentsByName.get("--prompt") ?? "Inspect README.md and report its title in one sentence.";
const followUp = argumentsByName.get("--follow-up");
const cancelAfterMilliseconds = Number(argumentsByName.get("--cancel-after-ms") ?? 0);
const workspaceDirectory = resolve(argumentsByName.get("--workspace") ?? repositoryDirectory);
const resumePath = argumentsByName.get("--resume");

if (!Number.isFinite(cancelAfterMilliseconds) || cancelAfterMilliseconds < 0) {
  throw new Error("--cancel-after-ms must be a non-negative number.");
}

const lifecycle = [];
const requests = new Map();
let requestId = 0;
let threadId;
let activeTurnId;
let cancellationTimer;
let artifactPath;
let appServerFailure;

const appServer = spawn(process.env.RELAY_CODEX_BIN ?? "codex", ["app-server", "--stdio"], {
  cwd: workspaceDirectory,
  stdio: ["pipe", "pipe", "pipe"],
});

appServer.stderr.setEncoding("utf8");
appServer.stderr.on("data", (message) => record("app-server/stderr", { message }));
appServer.on("error", (error) => {
  appServerFailure = error;
  failOutstandingRequests(error);
});
appServer.on("exit", (code, signal) => {
  appServerFailure = new Error(`codex app-server exited (code ${code}, signal ${signal}).`);
  failOutstandingRequests(appServerFailure);
});

createInterface({ input: appServer.stdout }).on("line", (line) => {
  try {
    handleMessage(JSON.parse(line));
  } catch (error) {
    record("relay/protocol-error", { line, message: error.message });
  }
});

function record(method, params) {
  lifecycle.push({ at: new Date().toISOString(), method, params });
}

function failOutstandingRequests(error) {
  for (const request of requests.values()) request.reject(error);
  requests.clear();
}

function send(method, params) {
  const id = ++requestId;
  const message = { id, method, params };
  record("relay/request", message);

  return new Promise((resolveRequest, rejectRequest) => {
    requests.set(id, { resolve: resolveRequest, reject: rejectRequest, method });
    appServer.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

function handleMessage(message) {
  if (message.id !== undefined) {
    const request = requests.get(message.id);
    if (!request) return;

    requests.delete(message.id);
    if (message.error) {
      request.reject(new Error(`${request.method}: ${message.error.message}`));
      return;
    }

    record(`${request.method}/response`, message.result);
    request.resolve(message.result);
    return;
  }

  record(message.method, message.params);
  if (message.method === "turn/started") activeTurnId = message.params.turn.id;
  if (message.method === "turn/completed") activeTurnId = undefined;
}

function waitForCompletion(turnId) {
  return waitForEvent(
    (event) => event.method === "turn/completed" && event.params.turn.id === turnId,
  ).then((event) => event.params.turn);
}

function waitForEvent(predicate) {
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setInterval(() => {
      if (appServerFailure) {
        clearInterval(timer);
        rejectEvent(appServerFailure);
        return;
      }
      const event = lifecycle.findLast(predicate);
      if (event) {
        clearInterval(timer);
        resolveEvent(event);
      }
    }, 50);
  });
}

async function startTurn(input) {
  const turn = await send("turn/start", {
    threadId,
    input: [{ type: "text", text: input }],
  });
  const completed = lifecycle.some(
    (event) => event.method === "turn/completed" && event.params.turn.id === turn.turn.id,
  );
  activeTurnId = completed ? undefined : turn.turn.id;
  await persistArtifact();
  return turn.turn.id;
}

async function main() {
  await send("initialize", {
    clientInfo: { name: "relay-agent-run-prototype", version: "0.1.0" },
    capabilities: {},
  });

  if (resumePath) {
    const previousArtifact = JSON.parse(await readFile(resolve(resumePath), "utf8"));
    threadId = previousArtifact.threadId;
    if (!threadId) throw new Error("The AgentRun artifact does not contain a threadId.");
    artifactPath = resolve(resumePath);
    lifecycle.push(...previousArtifact.lifecycle);
    await send("thread/resume", { threadId });
    await persistArtifact();
  } else {
    await mkdir(outputDirectory, { recursive: true });
    artifactPath = resolve(outputDirectory, `agent-run-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`);
    console.log(`AgentRun artifact: ${artifactPath}`);
    const thread = await send("thread/start", {
      cwd: workspaceDirectory,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });
    threadId = thread.thread.id;
    await persistArtifact();
  }

  const initialPrompt = resumePath && !argumentsByName.has("--prompt") ? undefined : prompt;
  if (initialPrompt) {
    const firstTurnId = await startTurn(initialPrompt);
    if (argumentsByName.has("--cancel-after-ms")) {
      await waitForEvent(
        (event) => event.method === "turn/started" && event.params.turn.id === firstTurnId,
      );
      await new Promise((resolveDelay) => {
        cancellationTimer = setTimeout(resolveDelay, cancelAfterMilliseconds);
      });
      if (!activeTurnId) throw new Error("The turn completed before cancellation could be requested.");
      await send("turn/interrupt", { threadId, turnId: activeTurnId });
      await persistArtifact();
    }
    const completedTurn = await waitForCompletion(firstTurnId);
    clearTimeout(cancellationTimer);
    if (argumentsByName.has("--cancel-after-ms") && completedTurn.status !== "interrupted") {
      throw new Error(`Expected an interrupted turn after cancellation, received ${completedTurn.status}.`);
    }
    await persistArtifact();
  }

  if (followUp) {
    const followUpTurnId = await startTurn(followUp);
    await waitForCompletion(followUpTurnId);
    await persistArtifact();
  }
}

async function persistArtifact() {
  if (!artifactPath) return;
  const artifact = {
    prototype: "persistent-codex-backed-agent-run",
    appServer: "codex app-server --stdio",
    workspaceDirectory,
    authentication: "managed local Codex credential store (run `codex login status` to verify)",
    threadId,
    activeTurnId,
    turns: lifecycle
      .filter((event) => event.method === "turn/start/response")
      .map((event) => {
        const turn = event.params.turn;
        const completion = lifecycle.findLast(
          (candidate) => candidate.method === "turn/completed" && candidate.params.turn.id === turn.id,
        );
        return {
          id: turn.id,
          status: completion?.params.turn.status ?? turn.status,
          startedAt: turn.startedAt ?? null,
          completedAt: completion?.params.turn.completedAt ?? null,
        };
      }),
    lifecycle,
    constraints: [
      "Persist the Codex threadId and every turnId before treating an AgentRun as recoverable.",
      "Map streamed item events to concise visible status; a quiet connection is not completion.",
      "Treat turn/completed status as authoritative for completed, failed, or interrupted outcomes.",
      "A follow-up is a new turn/start on the same thread; it is not a reply injected into the original turn.",
      "Cancellation requires turn/interrupt with both persisted identifiers and remains asynchronous until turn/completed.",
      "The local app-server integration is experimental and not a production-grade multi-tenant service boundary.",
      "The owner account's plan entitlement and rate limits govern capacity; Relay must surface exhausted usage.",
      "Codex does not guarantee account-level concurrency here, so Relay must queue AgentRuns and isolate their workspaces.",
    ],
  };
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

async function writeArtifact() {
  if (!artifactPath) {
    await mkdir(outputDirectory, { recursive: true });
    artifactPath = resolve(outputDirectory, `agent-run-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`);
    console.log(`AgentRun artifact: ${artifactPath}`);
  }
  await persistArtifact();
}

function reportFailure(error) {
  record("relay/failure", { message: error.message });
  console.error(error);
}

main()
  .catch(async (error) => {
    reportFailure(error);
    await writeArtifact();
    process.exitCode = 1;
  })
  .finally(() => appServer.kill());
