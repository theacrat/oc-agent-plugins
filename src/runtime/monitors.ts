import { MonitorProcess } from "#src/runtime/monitor-process.ts";
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

interface MonitorLimits {
  readonly output: number;
  readonly processes: number;
  readonly runtime: number;
  readonly grace: number;
}

const positive = (value: number | undefined, fallback: number) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error("monitor limits must be positive integers");
  }
  return result;
};

class MonitorRegistry {
  private readonly running = new Map<string, Map<string, MonitorProcess>>();
  private readonly started = new Map<string, Set<string>>();
  private disposed = false;
  private readonly limits: MonitorLimits;
  private readonly abort = () => {
    void this.dispose();
  };

  private readonly monitors: readonly PluginMonitor[];
  private readonly options: MonitorOptions;

  public constructor(monitors: readonly PluginMonitor[], options: MonitorOptions) {
    this.monitors = monitors;
    this.options = options;
    this.limits = {
      grace: positive(options.stopGraceMs, 500),
      output: positive(options.maxOutputBytes, 64 * 1024),
      processes: positive(options.maxProcesses, 8),
      runtime: positive(options.maxRuntimeMs, 24 * 60 * 60 * 1000),
    };
    if (monitors.length > 0 && options.enabled !== false && options.trusted !== true) {
      options.report({
        message: "Monitor commands discovered but not started: explicit trust opt-in is required",
        severity: "warning",
        source: "monitors",
      });
    }
    options.signal?.addEventListener("abort", this.abort, { once: true });
  }

  public active() {
    return [...this.running.values()].reduce((total, entries) => total + entries.size, 0);
  }

  private canLaunch(monitor: PluginMonitor) {
    if (
      this.disposed ||
      this.options.signal?.aborted ||
      this.options.enabled === false ||
      this.options.trusted !== true ||
      !this.options.interactive
    ) {
      return false;
    }
    let message: string | undefined;
    if (process.platform === "win32") {
      message =
        "monitor execution unavailable on Windows: owned process-group termination is required";
    } else if (this.active() >= this.limits.processes) {
      message = "monitor process budget exhausted";
    }
    if (message === undefined) {
      return true;
    }
    this.options.report({ message, severity: "warning", source: `monitor:${monitor.name}` });
    return false;
  }

  private launch(sessionId: string, monitor: PluginMonitor) {
    const seen = this.started.get(sessionId) ?? new Set<string>();
    if (seen.has(monitor.name) || !this.canLaunch(monitor)) {
      return;
    }
    seen.add(monitor.name);
    this.started.set(sessionId, seen);
    const entries = this.running.get(sessionId) ?? new Map<string, MonitorProcess>();
    this.running.set(sessionId, entries);
    const child = new MonitorProcess(sessionId, monitor, this.options, this.limits, () => {
      entries.delete(monitor.name);
      if (entries.size === 0) {
        this.running.delete(sessionId);
      }
    });
    entries.set(monitor.name, child);
  }

  public startSession(sessionId: string) {
    this.startMatching(sessionId, "always");
  }

  public invokeSkill(sessionId: string, skill: string) {
    this.startMatching(sessionId, `on-skill-invoke:${skill}`);
  }

  private startMatching(sessionId: string, when: PluginMonitor["when"]) {
    for (const monitor of this.monitors) {
      if (monitor.when === when) {
        this.launch(sessionId, monitor);
      }
    }
  }

  public async stopSession(sessionId: string) {
    const entries = [...(this.running.get(sessionId)?.values() ?? [])];
    for (const entry of entries) {
      entry.stop();
    }
    await Promise.all(entries.map(async (entry) => entry.done));
    this.started.delete(sessionId);
  }

  public async dispose() {
    this.disposed = true;
    this.options.signal?.removeEventListener("abort", this.abort);
    await Promise.all(
      [...this.running.keys()].map(async (sessionId) => this.stopSession(sessionId)),
    );
  }
}

const registerMonitors = (monitors: readonly PluginMonitor[], options: MonitorOptions) => {
  const registry = new MonitorRegistry(monitors, options);
  return {
    active: () => registry.active(),
    dispose: async () => registry.dispose(),
    invokeSkill: (sessionId: string, skill: string) => {
      registry.invokeSkill(sessionId, skill);
    },
    startSession: (sessionId: string) => {
      registry.startSession(sessionId);
    },
    stopSession: async (sessionId: string) => registry.stopSession(sessionId),
  };
};

export type { MonitorLimits, MonitorOptions };
export { registerMonitors };
