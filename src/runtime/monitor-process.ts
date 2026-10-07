import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { errorMessage, isRecord } from "#src/json.ts";
import type { MonitorLimits, MonitorOptions } from "#src/runtime/monitors.ts";
import type { PluginMonitor } from "#src/vendor/monitors.ts";

class MonitorProcess {
  private readonly child: ChildProcess;
  private readonly completion = Promise.withResolvers<undefined>();
  public readonly done = this.completion.promise;
  private bytes = 0;
  private stopping = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly runtimeTimer: ReturnType<typeof setTimeout>;

  private readonly sessionId: string;

  private readonly monitor: PluginMonitor;

  private readonly options: MonitorOptions;

  private readonly limits: MonitorLimits;

  public constructor(
    sessionId: string,
    monitor: PluginMonitor,
    options: MonitorOptions,
    limits: MonitorLimits,
    onClose: () => void,
  ) {
    this.sessionId = sessionId;
    this.monitor = monitor;
    this.options = options;
    this.limits = limits;
    // Never inherit configured plugin secrets or the server environment implicitly.
    const env = Object.fromEntries(
      Object.entries(options.env).filter(([key]) => !key.startsWith("CLAUDE_PLUGIN_OPTION_")),
    );
    this.child = spawn("/bin/sh", ["-c", monitor.command], {
      cwd: options.cwd,
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.runtimeTimer = setTimeout(() => {
      this.diagnostic("monitor runtime limit reached");
      this.stop();
    }, limits.runtime);
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.output(chunk);
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.output(chunk);
    });
    this.child.once("error", (error) => {
      this.diagnostic(errorMessage(error));
    });
    this.child.once("exit", () => {
      this.signalGroup("SIGKILL");
    });
    this.child.once("close", () => {
      clearTimeout(this.runtimeTimer);
      if (this.killTimer !== undefined) {
        clearTimeout(this.killTimer);
      }
      // A shell may exit while grandchildren still hold the process group.
      this.signalGroup("SIGKILL");
      onClose();
      this.completion.resolve(undefined);
    });
  }

  private diagnostic(message: string) {
    this.options.report({ message, severity: "warning", source: `monitor:${this.monitor.name}` });
  }

  private signalGroup(signal: NodeJS.Signals) {
    if (this.child.pid === undefined) {
      return;
    }
    try {
      process.kill(-this.child.pid, signal);
    } catch (error) {
      if (!isRecord(error) || error["code"] !== "ESRCH") {
        this.diagnostic(errorMessage(error));
      }
    }
  }

  public stop() {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.signalGroup("SIGTERM");
    this.killTimer = setTimeout(() => {
      this.signalGroup("SIGKILL");
    }, this.limits.grace);
  }

  private output(chunk: Buffer) {
    if (this.stopping) {
      return;
    }
    const remaining = Math.max(0, this.limits.output - this.bytes);
    this.bytes += chunk.length;
    if (remaining > 0) {
      try {
        this.options.notify(
          this.sessionId,
          this.monitor.name,
          chunk.subarray(0, remaining).toString("utf8"),
        );
      } catch (error) {
        this.diagnostic(`monitor notification failed: ${errorMessage(error)}`);
        this.stop();
      }
    }
    if (this.bytes >= this.limits.output) {
      this.diagnostic("monitor output limit reached");
      this.stop();
    }
  }
}

export { MonitorProcess };
