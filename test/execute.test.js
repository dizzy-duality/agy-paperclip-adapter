// End-to-end tests of execute() against a fake `agy` that replays captured
// output, so the real argument handling, process runner and result mapping
// all run.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { execute } from "../dist/execute.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REQUESTED = "3f2b8c1e-0000-4000-8000-000000000000";
const STARTED = "0219eb32-665a-495f-8745-a7b85e229dee";

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-exec-"));
}

// A fake agy: writes the given stdout/stderr files and exits, or sleeps.
function fakeAgy(dir, { stdoutFile, stderrFile, sleepSec }) {
  const script = path.join(dir, "agy");
  const lines = ["#!/bin/sh"];
  if (stderrFile) lines.push(`cat '${stderrFile}' >&2`);
  if (stdoutFile) lines.push(`cat '${stdoutFile}'`);
  if (sleepSec) lines.push(`sleep ${sleepSec} & wait`);
  lines.push("exit 0");
  fs.writeFileSync(script, lines.join("\n") + "\n", { mode: 0o755 });
  return script;
}

function makeCtx(dir, command, overrides = {}) {
  const logs = [];
  const ctx = {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "agy test", adapterType: "agy_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command, cwd: dir, timeoutSec: 30, graceSec: 1, skillsScope: "global" },
    context: {},
    onLog: async (stream, chunk) => {
      logs.push(chunk);
    },
    ...overrides,
  };
  return { ctx, logs };
}

test("a resume that agy silently restarts is reported, and the new conversation is kept", async () => {
  const dir = makeTmp();
  const command = fakeAgy(dir, {
    stdoutFile: path.join(here, "fixtures/agy-1.2.14-unknown-conversation.stdout.jsonl"),
    stderrFile: path.join(here, "fixtures/agy-1.2.14-unknown-conversation.stderr.txt"),
  });
  const { ctx, logs } = makeCtx(dir, command, {
    runtime: {
      sessionId: REQUESTED,
      sessionParams: { conversationId: REQUESTED, cwd: dir },
      sessionDisplayId: REQUESTED,
      taskKey: null,
    },
  });

  const result = await execute(ctx);

  assert.equal(result.errorMessage, null, "the run itself succeeded");
  assert.equal(result.sessionId, STARTED, "the new conversation is stored for the next heartbeat");
  assert.deepEqual(result.resultJson.conversationReset, { requested: REQUESTED, started: STARTED });
  assert.ok(
    logs.some((line) => line.includes(`could not resume conversation "${REQUESTED}"`)),
    "the operator sees the reset in the run log",
  );
});

test("a fresh conversation is not reported as a reset", async () => {
  const dir = makeTmp();
  const command = fakeAgy(dir, {
    stdoutFile: path.join(here, "fixtures/agy-1.2.14-unknown-conversation.stdout.jsonl"),
  });
  const { ctx } = makeCtx(dir, command);
  const result = await execute(ctx);
  assert.equal(result.sessionId, STARTED);
  assert.equal(result.resultJson.conversationReset, undefined);
});

test("Stop during a run kills agy and returns the acknowledgement the server requires", async () => {
  const dir = makeTmp();
  const command = fakeAgy(dir, { sleepSec: 30 });
  const controller = new AbortController();
  let registered = false;
  let spawnedPid = null;
  const { ctx } = makeCtx(dir, command, {
    signal: controller.signal,
    onCancellationReady: async () => {
      registered = true;
    },
    onSpawn: async (meta) => {
      spawnedPid = meta.pid;
      setTimeout(() => controller.abort(), 50);
    },
  });

  const started = Date.now();
  const result = await execute(ctx);

  assert.equal(registered, true, "the adapter opted in to signal cancellation");
  assert.ok(spawnedPid, "the server still receives the pid");
  assert.ok(Date.now() - started < 10_000, "agy was killed, not waited out");
  assert.equal(result.errorCode, "cancelled");
  assert.equal(result.resultJson.executionCancellation.state, "acknowledged");
});

test("a run stopped before agy starts never spawns it", async () => {
  const dir = makeTmp();
  const command = fakeAgy(dir, { sleepSec: 30 });
  const controller = new AbortController();
  let spawned = false;
  const { ctx } = makeCtx(dir, command, {
    signal: controller.signal,
    onCancellationReady: async () => controller.abort(),
    onSpawn: async () => {
      spawned = true;
    },
  });
  const result = await execute(ctx);
  assert.equal(spawned, false);
  assert.equal(result.resultJson.executionCancellation.state, "acknowledged");
});
