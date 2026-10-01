import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { armProcessCancellation } from "../dist/cancellation.js";

// A detached shell with a grandchild, like agy plus a tool it started. Killing
// only the shell would leave the grandchild running.
function spawnGroup() {
  const child = spawn("sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
  return child;
}

// A live (non-zombie) member of the process group. kill(-pgid, 0) is not
// enough: where PID 1 does not reap orphans (some containers), killed members
// linger as zombies and still count as "existing".
function groupAlive(pgid) {
  const out = execFileSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" });
  return out.split("\n").some((line) => {
    const [group, stat] = line.trim().split(/\s+/);
    return Number(group) === pgid && stat && !stat.startsWith("Z");
  });
}

async function waitFor(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test("Stop during a run terminates the whole process group", async () => {
  const controller = new AbortController();
  const cancellation = armProcessCancellation({ signal: controller.signal, graceSec: 5 });
  const child = spawnGroup();
  await cancellation.onSpawn({ pid: child.pid, processGroupId: child.pid, startedAt: new Date().toISOString() });
  assert.equal(groupAlive(child.pid), true);

  controller.abort();
  await once(child, "exit");
  assert.equal(await waitFor(() => !groupAlive(child.pid)), true, "grandchild survived the Stop");
  cancellation.dispose();
});

test("Stop that arrives before spawn terminates the child as soon as it starts", async () => {
  const controller = new AbortController();
  controller.abort();
  const cancellation = armProcessCancellation({ signal: controller.signal, graceSec: 5 });
  const child = spawnGroup();
  await cancellation.onSpawn({ pid: child.pid, processGroupId: child.pid, startedAt: new Date().toISOString() });
  await once(child, "exit");
  assert.equal(await waitFor(() => !groupAlive(child.pid)), true);
  cancellation.dispose();
});

test("a child that ignores SIGTERM is killed after the grace period", async () => {
  const controller = new AbortController();
  const cancellation = armProcessCancellation({ signal: controller.signal, graceSec: 0.2 });
  const child = spawn("sh", ["-c", "trap '' TERM; sleep 30 & wait"], { detached: true, stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 100)); // let the trap install
  await cancellation.onSpawn({ pid: child.pid, processGroupId: child.pid, startedAt: new Date().toISOString() });
  controller.abort();
  await once(child, "exit");
  assert.equal(await waitFor(() => !groupAlive(child.pid)), true);
  cancellation.dispose();
});
