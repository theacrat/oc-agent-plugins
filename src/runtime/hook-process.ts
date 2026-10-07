import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { PluginHook } from "#src/vendor/hooks.ts";

interface HookProcessOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly signal: AbortSignal;
}
const spawnHook = (
  hook: PluginHook,
  options: HookProcessOptions,
): ChildProcessWithoutNullStreams => {
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
  return hook.args === undefined
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
};
const killHook = (child: ChildProcessWithoutNullStreams): void => {
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
const readOutput = (
  child: ChildProcessWithoutNullStreams,
  state: { size: number; stdout: string },
  fail: (error: Error) => void,
): void => {
  child.stdout.on("data", (chunk: Buffer) => {
    state.size += chunk.length;
    if (state.size > 1024 * 1024) {
      fail(new Error("hook output exceeds 1 MiB"));
    } else {
      state.stdout += chunk.toString("utf8");
    }
  });
  // Never surface stderr: scripts can print inherited credentials there.
  child.stderr.resume();
  child.stdin.on("error", () => {
    // Intentionally ignored; completion is handled separately.
  });
};
const watchHook = async (
  child: ChildProcessWithoutNullStreams,
  hook: PluginHook,
  options: HookProcessOptions,
): Promise<{ code: number; stdout: string }> =>
  // oxlint-disable-next-line promise/avoid-new -- Child process callbacks have no Promise API.
  new Promise((resolve, reject) => {
    const state = { size: 0, stdout: "" };
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure = error;
      killHook(child);
    };
    const cancel = () => {
      fail(new Error("hook cancelled"));
    };
    const timer = setTimeout(() => {
      fail(new Error("hook timed out"));
    }, hook.timeout);
    options.signal.addEventListener("abort", cancel, { once: true });
    if (options.signal.aborted) {
      cancel();
    }
    readOutput(child, state, fail);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", cancel);
      killHook(child);
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
        resolve({ code: code ?? 1, stdout: state.stdout });
      }
    });
  });
const runHookProcess = async (
  hook: PluginHook,
  input: Record<string, unknown>,
  options: HookProcessOptions,
): Promise<{ code: number; stdout: string }> => {
  const child = spawnHook(hook, options);
  const result = watchHook(child, hook, options);
  child.stdin.end(JSON.stringify(input));
  return result;
};
export type { HookProcessOptions };
export { runHookProcess };
