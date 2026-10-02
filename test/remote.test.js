// execute() against a sandbox target (an agent pod), end to end through the
// real adapter-utils sync code. The target's runner executes commands locally
// in a temp "pod" directory, so workspace sync, the login hand-off, skill
// delivery and the workspace restore all really happen.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { execute } from "../dist/execute.js";
import { SIMPLE_RUN } from "./fixtures.js";

const TOKEN = '{"auth_method":"oauth","token":{"refresh_token":"fake-refresh"}}';

function localRunner() {
  return {
    execute: ({ command, args = [], cwd, env, stdin, timeoutMs }) =>
      new Promise((resolve) => {
        // A pod runs commands with the image environment plus the run env.
        const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const timer = timeoutMs ? setTimeout(() => child.kill("SIGKILL"), timeoutMs) : null;
        child.on("close", (exitCode, signal) => {
          if (timer) clearTimeout(timer);
          resolve({ exitCode, signal, timedOut: false, stdout, stderr, pid: child.pid ?? null, startedAt: new Date().toISOString() });
        });
        child.stdin.end(stdin ?? "");
      }),
  };
}

test("a sandbox run gets the workspace, the login and the skills, and its changes come back", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-remote-"));
  const realHome = process.env.HOME;
  t.after(() => {
    process.env.HOME = realHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  // The Paperclip host: its home holds the agy login, its workspace a file.
  const hostHome = path.join(root, "host-home");
  fs.mkdirSync(path.join(hostHome, ".gemini", "antigravity-cli"), { recursive: true });
  fs.writeFileSync(path.join(hostHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"), TOKEN, { mode: 0o600 });
  fs.writeFileSync(path.join(hostHome, ".gemini", "antigravity-cli", "history.jsonl"), "must not travel\n");
  process.env.HOME = hostHome;
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "input.txt"), "from host\n");
  const skillSource = path.join(root, "skill-src", "hello-skill");
  fs.mkdirSync(skillSource, { recursive: true });
  fs.writeFileSync(path.join(skillSource, "SKILL.md"), "---\nname: hello-skill\ndescription: hi\n---\n\nhi\n");

  // The pod: a remote cwd, and an agy that checks what it was given.
  const pod = path.join(root, "pod");
  fs.mkdirSync(path.join(pod, "workspace"), { recursive: true });
  const stdoutFile = path.join(root, "run.jsonl");
  fs.writeFileSync(stdoutFile, SIMPLE_RUN + "\n");
  const agy = path.join(root, "agy");
  fs.writeFileSync(
    agy,
    `#!/bin/sh
set -e
tok="$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
[ "$(cat "$tok")" = '${TOKEN}' ] || { echo "login missing in pod HOME=$HOME" >&2; exit 41; }
case "$(ls -l "$tok")" in -rw-------*) ;; *) echo "login not 0600" >&2; exit 42;; esac
[ ! -e "$HOME/.gemini/antigravity-cli/history.jsonl" ] || { echo "history travelled" >&2; exit 43; }
[ "$(cat input.txt)" = "from host" ] || { echo "workspace not synced to $(pwd)" >&2; exit 44; }
skills=
prev=
for a in "$@"; do [ "$prev" = --add-dir ] && [ -f "$a/.agents/skills/hello-skill/SKILL.md" ] && skills=yes; prev="$a"; done
[ -n "$skills" ] || { echo "skills not delivered" >&2; exit 45; }
echo "made in pod" > made-in-pod.txt
cat '${stdoutFile}'
`,
    { mode: 0o755 },
  );

  const logs = [];
  const result = await execute({
    runId: "run-remote-1",
    authToken: "run-token-for-test",
    agent: { id: "agent-1", companyId: "company-1", name: "agy", adapterType: "agy_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      command: agy,
      cwd: workspace,
      timeoutSec: 60,
      graceSec: 1,
      skillsRootPath: path.join(root, "skill-root"),
      paperclipRuntimeSkills: [{ key: "local/hello-skill", runtimeName: "hello-skill", source: skillSource }],
      paperclipSkillSync: { desiredSkills: ["local/hello-skill"] },
    },
    context: {},
    executionTarget: {
      kind: "remote",
      transport: "sandbox",
      providerKey: "kubernetes",
      remoteCwd: path.join(pod, "workspace"),
      runner: localRunner(),
    },
    onLog: async (_stream, chunk) => {
      logs.push(chunk);
    },
  });

  assert.equal(result.errorMessage, null, `run failed: ${result.errorMessage}\n${logs.join("")}`);
  assert.equal(result.exitCode, 0);
  assert.equal(
    fs.readFileSync(path.join(workspace, "made-in-pod.txt"), "utf8"),
    "made in pod\n",
    "the pod's change is restored into the host workspace",
  );
  assert.deepEqual(
    fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("agy-auth-") && fs.existsSync(path.join(os.tmpdir(), n, "antigravity-oauth-token"))),
    [],
    "no staged copy of the login is left on the host",
  );
});
