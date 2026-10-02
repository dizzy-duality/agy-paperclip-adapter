// filesystemScope wiring: execute() hands Paperclip's sandbox builder the right
// mounts. A fake `bwrap` records the argument list Paperclip builds and then
// runs the confined command, so this checks exactly what bwrap would receive.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGY_STATE_READONLY_SUBPATHS, execute } from "../dist/execute.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "fixtures/agy-1.2.14-unknown-conversation.stdout.jsonl");
// Paperclip supports filesystem/network scopes only on Linux (bwrap).
const linuxOnly = { skip: process.platform !== "linux" && "local process scopes are Linux-only in Paperclip" };

test("filesystemScope=workspace mounts ~/.gemini rw with its executable parts read-only", linuxOnly, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sandbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const gemini = path.join(home, ".gemini");
  for (const sub of ["config/skills", "antigravity-cli/bin", "antigravity-cli/builtin", "antigravity-cli/updater"]) {
    fs.mkdirSync(path.join(gemini, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(gemini, "antigravity-cli/settings.json"), "{}");
  fs.mkdirSync(workspace);

  const argsFile = path.join(root, "bwrap-args");
  const bwrap = path.join(root, "bwrap");
  fs.writeFileSync(
    bwrap,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${argsFile}'`,
      'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
      "shift",
      'exec "$@"',
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  const agy = path.join(root, "agy");
  fs.writeFileSync(agy, `#!/bin/sh\ncat '${FIXTURE}'\n`, { mode: 0o755 });

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previousHome;
  });

  const result = await execute({
    runId: "run-sandbox",
    agent: { id: "agent-1", companyId: "company-1", name: "t", adapterType: "agy_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      command: agy,
      cwd: workspace,
      timeoutSec: 30,
      skillsScope: "global",
      filesystemScope: "workspace",
      filesystemSandboxCommand: bwrap,
    },
    context: {},
    onLog: async () => {},
  });
  assert.equal(result.errorMessage, null, "the confined run completed");

  const args = fs.readFileSync(argsFile, "utf8").split("\n");
  const bindIndex = (flag, p) => args.findIndex((value, i) => value === flag && args[i + 1] === p && args[i + 2] === p);

  const rwState = bindIndex("--bind", gemini);
  assert.ok(rwState >= 0, "~/.gemini is mounted read-write");
  for (const sub of AGY_STATE_READONLY_SUBPATHS) {
    const ro = bindIndex("--ro-bind", path.join(gemini, sub));
    assert.ok(ro > rwState, `${sub} is mounted read-only after (so over) the rw ~/.gemini`);
  }
  assert.ok(bindIndex("--bind", workspace) >= 0, "the workspace is mounted read-write");
  assert.equal(bindIndex("--bind", home), -1, "the rest of HOME is not mounted");
});
