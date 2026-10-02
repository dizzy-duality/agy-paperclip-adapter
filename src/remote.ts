/**
 * Prepare a remote execution target (an SSH host or a sandbox pod) for one agy
 * run, mirroring the first-party gemini_local adapter:
 *
 * - sync the workspace to the target, and restore it back afterwards;
 * - on a managed home (sandbox pods), point HOME at the per-run runtime root
 *   and install the host's agy login there, so agy needs no state baked into
 *   the image;
 * - deliver the synced skill root into the run's runtime root;
 * - start the Paperclip API bridge when the target asks for one.
 *
 * Only `antigravity-oauth-token` travels. Verified on agy 1.2.14: a run in an
 * empty HOME with only that file succeeds, refreshes the access token in the
 * copy, and leaves the refresh token unchanged, so the host's file stays valid
 * no matter how many pods used a copy.
 */

import {
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The one file agy needs to authenticate, relative to $HOME. */
export const AGY_AUTH_TOKEN_SUBPATH = path.posix.join(".gemini", "antigravity-cli", "antigravity-oauth-token");

type OnLog = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

export interface PreparedAgyRemoteRun {
  /** The workspace directory inside the target. */
  executionCwd: string;
  /** The target with its remote cwd set to `executionCwd`. */
  runtimeTarget: AdapterExecutionTarget | null;
  /** Directory to pass to agy as `--add-dir` for skills, inside the target. */
  skillsAddDir: string | null;
  bridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>>;
  /** Stop the bridge and restore the workspace; throws if the restore failed. */
  finish: () => Promise<void>;
}

const q = (value: string) => JSON.stringify(value);

export async function prepareAgyRemoteRun(input: {
  runId: string;
  target: AdapterExecutionTarget | null;
  /** Workspace directory on the Paperclip host. */
  localCwd: string;
  /** Remote cwd before the workspace sync (the target's default). */
  executionCwd: string;
  /** Host skill root (the directory holding `.agents/skills`), if any. */
  localSkillsRoot: string | null;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  onLog: OnLog;
  onRuntimeProgress?: Parameters<typeof prepareAdapterExecutionTargetRuntime>[0]["onRuntimeProgress"];
  /** Called after the workspace is synced, to re-point PAPERCLIP_WORKSPACE_* at the remote dir. */
  onExecutionCwd: (executionCwd: string) => void;
  homeDir?: string;
}): Promise<PreparedAgyRemoteRun> {
  const { runId, target, localCwd, env, timeoutSec, graceSec, onLog } = input;
  const shellOpts = { cwd: localCwd, env, timeoutSec, graceSec, onLog };

  const managedHome = adapterExecutionTargetUsesManagedHome(target);
  const hostToken = path.join(input.homeDir ?? os.homedir(), AGY_AUTH_TOKEN_SUBPATH);
  // Stage the token alone in a private temp dir: syncing ~/.gemini itself
  // would ship every other agent's conversations and the operator's config.
  let authStageDir: string | null = null;
  if (managedHome) {
    const tokenExists = await fs.stat(hostToken).then((s) => s.isFile()).catch(() => false);
    if (tokenExists) {
      authStageDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-auth-"));
      await fs.copyFile(hostToken, path.join(authStageDir, path.posix.basename(AGY_AUTH_TOKEN_SUBPATH)));
      await fs.chmod(path.join(authStageDir, path.posix.basename(AGY_AUTH_TOKEN_SUBPATH)), 0o600);
    } else {
      await onLog(
        "stdout",
        `[paperclip] No agy login at ${hostToken}; the run will fail with an auth error. Sign in once on the Paperclip host (agy, then quit).\n`,
      );
    }
  }
  const removeAuthStage = () =>
    authStageDir ? fs.rm(authStageDir, { recursive: true, force: true }).catch(() => undefined) : Promise.resolve();

  let restoreWorkspace: (() => Promise<void>) | null = null;
  let bridge: PreparedAgyRemoteRun["bridge"] = null;
  let executionCwd = input.executionCwd;
  let skillsAddDir: string | null = null;

  try {
    await onLog("stdout", `[paperclip] Syncing workspace and agy runtime assets to ${describeAdapterExecutionTarget(target)}.\n`);
    const prepared = await prepareAdapterExecutionTargetRuntime({
      runId,
      target,
      adapterKey: "agy",
      timeoutSec,
      workspaceLocalDir: localCwd,
      onProgress: (line) => onLog("stdout", line),
      onRuntimeProgress: input.onRuntimeProgress,
      assets: [
        ...(authStageDir ? [{ key: "auth", localDir: authStageDir }] : []),
        ...(input.localSkillsRoot ? [{ key: "skills", localDir: input.localSkillsRoot, followSymlinks: true }] : []),
      ],
    });
    // The pod now has its copy; the host copy must not linger.
    await removeAuthStage();
    restoreWorkspace = () => prepared.restoreWorkspace((line) => onLog("stdout", line));
    executionCwd = prepared.workspaceRemoteDir ?? executionCwd;
    input.onExecutionCwd(executionCwd);

    const managedHomeDir = managedHome && prepared.runtimeRootDir ? prepared.runtimeRootDir : null;
    if (managedHomeDir) env.HOME = managedHomeDir;

    // Only into a managed home: on an SSH host HOME is the user's real home,
    // with its own agy login that must not be overwritten.
    if (managedHomeDir && prepared.assetDirs.auth) {
      const tokenPath = path.posix.join(managedHomeDir, AGY_AUTH_TOKEN_SUBPATH);
      const source = path.posix.join(prepared.assetDirs.auth, path.posix.basename(AGY_AUTH_TOKEN_SUBPATH));
      await runAdapterExecutionTargetShellCommand(
        runId,
        target,
        `umask 077 && mkdir -p ${q(path.posix.dirname(tokenPath))} && cp ${q(source)} ${q(tokenPath)} && rm -rf ${q(prepared.assetDirs.auth)}`,
        shellOpts,
      );
    }

    // Assets land in this run's own runtime root on the target, so the skill
    // root's copy can be handed to agy as is: it keeps the .agents/skills
    // layout agy scans, and concurrent runs never share it.
    skillsAddDir = prepared.assetDirs.skills ?? null;

    const runtimeTarget = overrideAdapterExecutionTargetRemoteCwd(target, executionCwd) ?? null;
    if (adapterExecutionTargetUsesPaperclipBridge(target)) {
      bridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeTarget),
        runtimeRootDir: prepared.runtimeRootDir,
        adapterKey: "agy",
        timeoutSec,
        hostApiToken: env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (bridge) Object.assign(env, bridge.env);
    }

    let finished = false;
    const activeBridge = bridge;
    const activeRestore = restoreWorkspace;
    return {
      executionCwd,
      runtimeTarget,
      skillsAddDir,
      bridge,
      finish: async () => {
        if (finished) return;
        finished = true;
        const [, restored] = await Promise.allSettled([activeBridge?.stop(), activeRestore()]);
        // A run whose changes never reached the host must not read as success.
        if (restored.status === "rejected") throw restored.reason;
      },
    };
  } catch (error) {
    await Promise.allSettled([bridge?.stop(), restoreWorkspace?.(), removeAuthStage()]);
    throw error;
  }
}
