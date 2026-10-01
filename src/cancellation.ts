/**
 * Operator Stop for a local agy run.
 *
 * Paperclip's Stop button kills a run's process only when the process is in
 * the server's own `runningProcesses` map. An external adapter is loaded from
 * its own directory with its own copy of @paperclipai/adapter-utils, so the
 * child it spawns is registered in that copy's map, which the server never
 * reads. The supported path for such adapters is signal-based cancellation:
 * the adapter calls `ctx.onCancellationReady()`, the server aborts
 * `ctx.signal` on Stop, and the adapter terminates its own child and returns a
 * result whose `resultJson.executionCancellation.state` is "acknowledged".
 * Without that acknowledgement the server reports "provider termination could
 * not be verified".
 */

import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

type SpawnMeta = { pid: number; processGroupId: number | null; startedAt: string };
type OnSpawn = (meta: SpawnMeta) => Promise<void>;

type Kill = (pid: number, signal: NodeJS.Signals) => void;

export interface ProcessCancellation {
  /** Pass to the process runner in place of the caller's onSpawn. */
  onSpawn: OnSpawn;
  /** Call once the process runner has returned (the child has exited). */
  dispose: () => void;
}

/**
 * Arm `signal` against the child the process runner is about to spawn. On
 * abort: SIGTERM to the child's process group (agy and every tool it started),
 * then SIGKILL after `graceSec` if the runner has not returned by then.
 */
export function armProcessCancellation(input: {
  signal: AbortSignal | undefined;
  graceSec: number;
  onSpawn?: OnSpawn;
  kill?: Kill;
}): ProcessCancellation {
  const { signal, graceSec, onSpawn } = input;
  const kill: Kill = input.kill ?? ((pid, sig) => process.kill(pid, sig));
  let target: number | null = null;
  let escalation: NodeJS.Timeout | null = null;
  let disposed = false;

  const send = (sig: NodeJS.Signals) => {
    if (target === null) return;
    try {
      kill(target, sig);
    } catch {
      // ESRCH: the group is already gone, which is what we want.
    }
  };

  const terminate = () => {
    if (disposed || target === null) return;
    send("SIGTERM");
    escalation = setTimeout(() => send("SIGKILL"), Math.max(0, graceSec) * 1000);
    escalation.unref();
  };

  signal?.addEventListener("abort", terminate, { once: true });

  return {
    onSpawn: async (meta) => {
      // A negative pid addresses the whole process group. The runner spawns
      // detached on POSIX, so the group id is the child's own pid.
      target = meta.processGroupId && meta.processGroupId > 0 ? -meta.processGroupId : meta.pid;
      if (signal?.aborted) terminate();
      await onSpawn?.(meta);
    },
    dispose: () => {
      disposed = true;
      signal?.removeEventListener("abort", terminate);
      if (escalation) clearTimeout(escalation);
    },
  };
}

/** The result the server needs to see after an operator Stop. */
export function cancelledResult(
  base: Partial<AdapterExecutionResult> = {},
): AdapterExecutionResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    ...base,
    errorCode: "cancelled",
    errorMessage: "agy execution was cancelled",
    resultJson: {
      ...(base.resultJson ?? {}),
      executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() },
    },
  };
}
