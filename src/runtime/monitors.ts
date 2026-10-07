import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { errorMessage, isRecord } from "#src/json.ts";
import type { Report } from "#src/types.ts";
import type { PluginMonitor } from "#src/vendor/monitors.ts";

interface MonitorOptions {
  readonly trusted?: boolean;
  readonly enabled?: boolean;
  readonly interactive: boolean;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
  readonly maxProcesses?: number;
  readonly maxRuntimeMs?: number;
  readonly stopGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly report: Report;
  readonly notify: (sessionId: string, monitor: string, output: string) => void;
}

interface RunningMonitor {
  readonly child: ChildProcess;
  readonly done: Promise<void>;
  stop: () => void;
}

const positive = (value: number | undefined, fallback: number) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error("monitor limits must be positive integers");
  }
  return result;
};

const registerMonitors = (monitors: readonly PluginMonitor[], options: MonitorOptions) => {
  const maxOutput = positive(options.maxOutputBytes, 64 * 1024);
  const maxProcesses = positive(options.maxProcesses, 8);
  const maxRuntime = positive(options.maxRuntimeMs, 24 * 60 * 60 * 1000);
  const grace = positive(options.stopGraceMs, 500);
  if (monitors.length > 0 && options.enabled !== false && options.trusted !== true) {
    options.report({
      message: "Monitor commands discovered but not started: explicit trust opt-in is required",
      severity: "warning",
      source: "monitors",
    });
  }
  const running = new Map<string, Map<string, RunningMonitor>>();
  const started = new Map<string, Set<string>>();
  let disposed = false;
  const diagnostic = (name: string, message: string) => {
    options.report({ message, severity: "warning", source: `monitor:${name}` });
  };
  const count = () => [...running.values()].reduce((total, entries) => total + entries.size, 0);
  const launch = (sessionId: string, monitor: PluginMonitor) => {
    if (
      disposed ||
      options.signal?.aborted ||
      options.enabled === false ||
      options.trusted !== true ||
      !options.interactive
    ) {
      return;
    }
    if (process.platform === "win32") {
      diagnostic(
        monitor.name,
        "monitor execution unavailable on Windows: owned process-group termination is required",
      );
      return;
    }
    const seen = started.get(sessionId) ?? new Set<string>();
    if (seen.has(monitor.name)) {
      return;
    }
    if (count() >= maxProcesses) {
      diagnostic(monitor.name, "monitor process budget exhausted");
      return;
    }
    seen.add(monitor.name);
    started.set(sessionId, seen);
    // Never inherit configured plugin secrets or the server environment implicitly.
    const env = Object.fromEntries(
      Object.entries(options.env).filter(([key]) => !key.startsWith("CLAUDE_PLUGIN_OPTION_")),
    );
    const child = spawn("/bin/sh", ["-c", monitor.command], {
      cwd: options.cwd,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const entries = running.get(sessionId) ?? new Map<string, RunningMonitor>();
    running.set(sessionId, entries);
    let bytes = 0;
    let stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const { promise: done, resolve: finish } = Promise.withResolvers<undefined>();
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!isRecord(error) || error["code"] !== "ESRCH") {
          diagnostic(monitor.name, errorMessage(error));
        }
      }
    };
    const stop = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
      }, grace);
    };
    const runtimeTimer = setTimeout(() => {
      diagnostic(monitor.name, "monitor runtime limit reached");
      stop();
    }, maxRuntime);
    const output = (chunk: Buffer) => {
      if (stopping) {
        return;
      }
      const remaining = Math.max(0, maxOutput - bytes);
      bytes += chunk.length;
      if (remaining > 0) {
        try {
          options.notify(sessionId, monitor.name, chunk.subarray(0, remaining).toString("utf8"));
        } catch (error) {
          diagnostic(monitor.name, `monitor notification failed: ${errorMessage(error)}`);
          stop();
        }
      }
      if (bytes >= maxOutput) {
        diagnostic(monitor.name, "monitor output limit reached");
        stop();
      }
    };
    child.stdout?.on("data", output);
    child.stderr?.on("data", output);
    child.once("error", (error) => {
      diagnostic(monitor.name, errorMessage(error));
    });
    child.once("exit", () => {
      signalGroup("SIGKILL");
    });
    child.once("close", () => {
      clearTimeout(runtimeTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      // A shell may exit while grandchildren still hold the process group.
      signalGroup("SIGKILL");
      entries.delete(monitor.name);
      if (entries.size === 0) {
        running.delete(sessionId);
      }
      finish(undefined);
    });
    entries.set(monitor.name, { child, done, stop });
  };
  const stopSession = async (sessionId: string) => {
    const entries = [...(running.get(sessionId)?.values() ?? [])];
    for (const entry of entries) {
      entry.stop();
    }
    await Promise.all(entries.map(async (entry) => entry.done));
    started.delete(sessionId);
  };
  const dispose = async () => {
    disposed = true;
    await Promise.all([...running.keys()].map(async (sessionId) => stopSession(sessionId)));
  };
  const abort = () => {
    void dispose();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  return {
    active: () => count(),
    dispose: async () => {
      options.signal?.removeEventListener("abort", abort);
      await dispose();
    },
    invokeSkill: (sessionId: string, skill: string) => {
      for (const monitor of monitors) {
        if (monitor.when === `on-skill-invoke:${skill}`) {
          launch(sessionId, monitor);
        }
      }
    },
    startSession: (sessionId: string) => {
      for (const monitor of monitors) {
        if (monitor.when === "always") {
          launch(sessionId, monitor);
        }
      }
    },
    stopSession,
  };
};

export type { MonitorOptions };
export { registerMonitors };
