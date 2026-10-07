import { Error as ToolError } from "@opencode/plugin/promise/tool";

import type { HookRegistrationOptions, HooksContext } from "#src/runtime/hook-contract.ts";
import { decodeHookOutput } from "#src/runtime/hook-output.ts";
import type { HookOutput } from "#src/runtime/hook-output.ts";
import { runHookProcess } from "#src/runtime/hook-process.ts";
import { redactHookContext } from "#src/runtime/hook-tools.ts";
import type { PluginHook } from "#src/vendor/hooks.ts";

interface ExecutorState {
  readonly ctx: HooksContext;
  readonly options: HookRegistrationOptions;
  readonly controller: AbortController;
  readonly contexts: Map<string, string[]>;
}
type HookState = ExecutorState;
const queueContext = (
  state: HookState,
  hook: PluginHook,
  sessionID: string,
  text: string,
): void => {
  // Environment values never enter the model, even if a hook echoes them.
  const secrets = [
    // oxlint-disable-next-line node/no-process-env -- Redact inherited process values before model text.
    ...Object.values(process.env),
    ...Object.values(state.options.env?.(hook) ?? {}),
    ...(state.options.secretValues?.() ?? []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const safe = redactHookContext(text, secrets);
  const existing = state.contexts.get(sessionID) ?? [];
  if (existing.length >= 32) {
    throw new Error("session hook context queue limit exceeded");
  }
  if (state.contexts.size >= 256 && !state.contexts.has(sessionID)) {
    throw new Error("hook context session limit exceeded");
  }
  state.contexts.set(sessionID, [...existing, safe]);
};
const makeExecutor =
  (state: HookState) =>
  async (
    hook: PluginHook,
    sessionID: string,
    fields: Record<string, unknown>,
  ): Promise<HookOutput> => {
    try {
      const input = {
        cwd: state.ctx.location.directory,
        hook_event_name: hook.event,
        // oxlint-disable-next-line unicorn/no-null -- Vendor protocol specifies null for unavailable transcripts.
        transcript_path: null,
        ...(hook.format === "cursor"
          ? { conversation_id: sessionID, workspace_roots: [state.ctx.location.directory] }
          : { session_id: sessionID }),
        ...fields,
      };
      const output = await runHookProcess(hook, input, {
        cwd: state.ctx.location.directory,
        env: state.options.env?.(hook),
        signal: state.controller.signal,
      });
      if (output.code !== 0 && output.code !== 2) {
        state.options.report({
          message: `${hook.event}: command exited ${output.code}; ${hook.failClosed ? "failClosed applies" : "vendor fail-open policy applies"}`,
          severity: "warning",
          source: hook.source,
        });
      }
      const decoded = decodeHookOutput(hook, output.stdout, output.code);
      if (decoded.context) {
        queueContext(state, hook, sessionID, decoded.context);
      }
      return decoded;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "hook failed";
      state.options.report({
        message: `${hook.event}: ${reason}; ${hook.phase === "before" ? "tool blocked" : "no blocking equivalent; operation cannot be undone"}`,
        severity: "error",
        source: hook.source,
      });
      // Keep raw command output, reasons and environment values out of model errors.
      if (hook.phase === "before") {
        throw new ToolError({ message: "Vendor hook failed closed; inspect adapter diagnostics" });
      }
      return { deny: false };
    }
  };
export type { ExecutorState };
export { makeExecutor };
