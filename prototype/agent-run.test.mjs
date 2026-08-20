import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("the CLI writes an inspectable completed AgentRun artifact from streamed events", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "relay-agent-run-"));
  const codexFixture = join(fixtureDirectory, "codex.mjs");
  await writeFile(codexFixture, `#!/usr/bin/env node
import { createInterface } from "node:readline";
setInterval(() => {}, 1_000);
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ id: request.id, result }) + String.fromCharCode(10));
  if (request.method === "initialize") reply({});
  if (request.method === "thread/start") reply({ thread: { id: "thread-1" } });
  if (request.method === "turn/start") {
    reply({ turn: { id: "turn-1" } });
    for (const message of [
      { method: "turn/started", params: { turn: { id: "turn-1" } } },
      { method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: {}, startedAtMs: 1 } },
      { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: {}, completedAtMs: 2 } },
      { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } },
    ]) process.stdout.write(JSON.stringify(message) + String.fromCharCode(10));
  }
});
`);
  await chmod(codexFixture, 0o755);

  const output = await run(process.execPath, ["prototype/agent-run.mjs", "--prompt", "fixture prompt"], {
    RELAY_CODEX_BIN: codexFixture,
  });
  assert.equal(output.code, 0, `${output.stdout}\n${output.stderr}`);

  const artifactPath = output.stdout.match(/AgentRun artifact: (.+)/)?.[1];
  assert.ok(artifactPath, output.stdout);
  const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  assert.equal(artifact.threadId, "thread-1");
  assert.ok(artifact.lifecycle.some((event) => event.method === "item/started"));
  assert.equal(
    artifact.lifecycle.find((event) => event.method === "turn/completed").params.turn.status,
    "completed",
  );
});

function run(command, argumentsList, additionalEnvironment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, argumentsList, {
      cwd: resolve("."),
      env: { ...process.env, ...additionalEnvironment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}
