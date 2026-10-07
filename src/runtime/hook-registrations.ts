import { Error as ToolError } from "@opencode/plugin/promise/tool";
import type { Result, Error as NativeToolError } from "@opencode/plugin/promise/tool";

import type { ExecutorState } from "#src/runtime/hook-executor.ts";
import type { HookOutput } from "#src/runtime/hook-output.ts";
import {
  cursorEdits,
  nativeInput,
  toolMatches,
  vendorInput,
  vendorTool,
} from "#src/runtime/hook-tools.ts";
import type { PluginHook } from "#src/vendor/hooks.ts";

interface HookState extends ExecutorState {
  readonly getCurrentHooks: () => readonly PluginHook[];
  readonly execute: (
    hook: PluginHook,
    sessionID: string,
    fields: Record<string, unknown>,
  ) => Promise<HookOutput>;
}
type AfterEvent = { readonly input: unknown; readonly tool: string; readonly id: string } & (
  | { readonly status: "completed"; readonly result: Result }
  | { readonly status: "error"; readonly error: NativeToolError }
);
const afterFields = (
  hook: PluginHook,
  event: AfterEvent,
  name: string,
): Record<string, unknown> => {
  const input = vendorInput(event.input);
  let resultFields: Record<string, unknown>;
  if (event.status === "completed") {
    resultFields =
      hook.format === "cursor"
        ? { tool_output: JSON.stringify(event.result) }
        : { tool_response: event.result };
  } else {
    resultFields = { error: event.error.message, error_message: event.error.message };
  }
  return {
    tool_input: input,
    tool_name: name,
    tool_use_id: event.id,
    ...resultFields,
    ...(hook.event === "afterShellExecution"
      ? {
          command: input["command"],
          output: event.status === "completed" ? event.result.content : "",
        }
      : {}),
    ...(hook.event === "afterFileEdit"
      ? { edits: cursorEdits(input), file_path: input["file_path"] }
      : {}),
  };
};
const assertCodexInput = (state: HookState, hook: PluginHook, tool: string): void => {
  if (tool === "patch" && hook.format !== "codex") {
    state.options.report({
      message: "Native patch input is not a vendor Edit/Write input; matching policy fails closed",
      severity: "error",
      source: hook.source,
    });
    throw new ToolError({ message: "Patch hook input cannot be translated; failed closed" });
  }
  if (hook.format !== "codex" || !["edit", "write", "patch"].includes(tool)) {
    return;
  }
  state.options.report({
    message:
      "Codex file policy blocked: native file/patch inputs are not Codex apply_patch command inputs",
    severity: "error",
    source: hook.source,
  });
  throw new ToolError({ message: "Codex file hook cannot translate native input; failed closed" });
};
const registerBefore = async (state: HookState) =>
  state.ctx.tool.hook("execute.before", async (event) => {
    for (const hook of state.getCurrentHooks()) {
      if (hook.phase !== "before" || !state.options.enabled(hook)) {
        continue;
      }
      const input = vendorInput(event.input);
      const name =
        state.options.toolName?.(hook, event.tool) ?? vendorTool(hook.format, event.tool);
      if (!toolMatches(hook, event.tool, name, input)) {
        continue;
      }
      assertCodexInput(state, hook, event.tool);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Ordered rewrites depend on prior decisions.
      const output = await state.execute(hook, event.sessionID, {
        tool_input: input,
        tool_name: name,
        tool_use_id: event.id,
        ...(hook.event === "beforeShellExecution"
          ? { command: input["command"], sandbox: false }
          : {}),
        ...(hook.event === "beforeReadFile" ? { file_path: input["file_path"] } : {}),
      });
      if (output.deny) {
        throw new ToolError({ message: "Tool denied by vendor hook" });
      }
      if (output.updatedInput) {
        event.input = nativeInput(output.updatedInput);
      }
    }
  });
const registerAfter = async (state: HookState) =>
  state.ctx.tool.hook("execute.after", async (event) => {
    for (const hook of state.getCurrentHooks()) {
      if (
        hook.phase !== (event.status === "completed" ? "after" : "failure") ||
        !state.options.enabled(hook)
      ) {
        continue;
      }
      const input = vendorInput(event.input);
      const name =
        state.options.toolName?.(hook, event.tool) ?? vendorTool(hook.format, event.tool);
      if (!toolMatches(hook, event.tool, name, input)) {
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve deterministic context ordering and bounded processes.
      await state.execute(hook, event.sessionID, afterFields(hook, event, name));
    }
  });
export type { HookState };
export { registerBefore, registerAfter };
