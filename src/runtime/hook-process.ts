import { spawn } from "node:child_process";

import type { PluginHook } from "#src/vendor/hooks.ts";

interface HookProcessOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly signal: AbortSignal;
}
const runHookProcess = async (
  hook: PluginHook,
  input: Record<string, unknown>,
  options: HookProcessOptions,
): Promise<{ code: number; stdout: string }> =>
  // oxlint-disable-next-line promise/avoid-new -- Child process stdio and close callbacks have no Promise API.
  new Promise((resolve, reject) => {
    const env = {
      // oxlint-disable-next-line node/no-process-env -- Vendor subprocess contract inherits the host environment, never model text.
      ...process.env,
      ...options.env,
      CLAUDE_PLUGIN_ROOT: hook.root,
      CLAUDE_PROJECT_DIR: options.cwd,
      CURSOR_PLUGIN_ROOT: hook.root,
      PLUGIN_ROOT: hook.root,
    };
    const expand = (text: string) =>
      text.replaceAll(
        /\$\{(?<key>[A-Z_]+)\}/gu,
        (match, key: string) => (env as Record<string, string | undefined>)[key] ?? match,
      );
    const child =
      hook.args === undefined
        ? spawn("sh", ["-c", hook.command], {
            cwd: options.cwd,
            detached: process.platform !== "win32",
            env,
          })
        : spawn(expand(hook.command), hook.args.map(expand), {
            cwd: options.cwd,
            detached: process.platform !== "win32",
            env,
          });
    let stdout = "";
    let size = 0;
    let failure: Error | undefined;
    const kill = () => {
      if (!child.pid) {
        return;
      }
      try {
        if (process.platform === "win32") {
          child.kill("SIGKILL");
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        /* Already exited. */
      }
    };
    const cancel = () => {
      failure = new Error("hook cancelled");
      kill();
    };
    const timer = setTimeout(() => {
      failure = new Error("hook timed out");
      kill();
    }, hook.timeout);
    options.signal.addEventListener("abort", cancel, { once: true });
    if (options.signal.aborted) {
      cancel();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        failure = new Error("hook output exceeds 1 MiB");
        kill();
      } else {
        stdout += chunk.toString("utf8");
      }
    });
    // Never surface stderr: scripts can print inherited credentials there.
    child.stderr.resume();
    child.stdin.on("error", () => {
      // Intentionally ignored; completion is handled separately.
    });
    child.stdin.end(JSON.stringify(input));
    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", cancel);
      kill();
    };
    child.on("error", () => {
      cleanup();
      reject(new Error("hook process could not start"));
    });
    child.on("close", (code) => {
      cleanup();
      if (failure) {
        reject(failure);
      } else {
        resolve({ code: code ?? 1, stdout });
      }
    });
  });

export type { HookProcessOptions };
export { runHookProcess };
