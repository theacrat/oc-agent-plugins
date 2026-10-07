import type { Plugin } from "@opencode/plugin";
import { Error as ToolError } from "@opencode/plugin/promise/tool";

import { isRecord } from "#src/json.ts";
import { runHookProcess } from "#src/runtime/hook-process.ts";
import type { Report } from "#src/types.ts";
import { hookMatcher } from "#src/vendor/hooks.ts";
import type { PluginHook } from "#src/vendor/hooks.ts";

interface HookRegistrationOptions {
  // Must be a per-plugin trust decision, rechecked on every invocation and reload.
  readonly enabled: (hook: PluginHook) => boolean;
  readonly report: Report;
  readonly env?: (hook: PluginHook) => Readonly<Record<string, string>>;
  readonly secretValues?: () => readonly string[];
  // Parent supplies scoped MCP/vendor aliases where registry IDs differ.
  readonly toolName?: (hook: PluginHook, nativeName: string) => string | undefined;
}
const vendorTool = (format: PluginHook["format"], tool: string): string => {
  const names: Record<string, string> = {
    apply_patch: "apply_patch",
    bash: format === "cursor" ? "Shell" : "Bash",
    edit: format === "cursor" ? "Write" : "Edit",
    glob: "Glob",
    grep: "Grep",
    read: "Read",
    task: "Task",
    write: "Write",
  };
  return names[tool] ?? tool;
};
const vendorInput = (input: unknown): Record<string, unknown> => {
  if (!isRecord(input)) {
    return {};
  }
  const translated = { ...input };
  if ("filePath" in translated) {
    translated["file_path"] = translated["filePath"];
    delete translated["filePath"];
  }
  if ("oldString" in translated) {
    translated["old_string"] = translated["oldString"];
    delete translated["oldString"];
  }
  if ("newString" in translated) {
    translated["new_string"] = translated["newString"];
    delete translated["newString"];
  }
  if ("replaceAll" in translated) {
    translated["replace_all"] = translated["replaceAll"];
    delete translated["replaceAll"];
  }
  return translated;
};
const nativeInput = (input: Record<string, unknown>): Record<string, unknown> => {
  const translated = { ...input };
  for (const [vendor, native] of [
    ["file_path", "filePath"],
    ["old_string", "oldString"],
    ["new_string", "newString"],
    ["replace_all", "replaceAll"],
  ]) {
    if (vendor && native && vendor in translated) {
      translated[native] = translated[vendor];
      // oxlint-disable-next-line typescript/no-dynamic-delete -- Remove the alias from an owned JSON draft.
      delete translated[vendor];
    }
  }
  return translated;
};

const commandText = (input: Record<string, unknown>): string =>
  typeof input["command"] === "string" ? input["command"] : "";

const cursorEdits = (input: Record<string, unknown>) => [
  {
    new_string: input["new_string"] ?? input["content"] ?? "",
    old_string: input["old_string"] ?? "",
  },
];

const redactHookContext = (text: string, values: readonly string[]): string => {
  let safe = text;
  for (const value of [...values].toSorted((left, right) => right.length - left.length)) {
    if (value.length > 0) {
      safe = safe.replaceAll(value, "[redacted]");
    }
  }
  return safe.slice(0, 32_000);
};

interface HookOutput {
  readonly context?: string;
  readonly updatedInput?: Record<string, unknown>;
  readonly deny: boolean;
}
// oxlint-disable-next-line eslint/complexity -- Validate each independent security decision in the wire contract.
const decodeHookOutput = (hook: PluginHook, stdout: string, code: number): HookOutput => {
  if (code === 2) {
    if (hook.phase !== "before") {
      throw new Error("exit 2 blocking semantics unavailable after execution or during compaction");
    }
    return { deny: true };
  }
  if (code !== 0) {
    if (hook.failClosed) {
      throw new Error("failClosed hook failed");
    }
    return { deny: false };
  }
  if (!stdout.trim()) {
    if (hook.format === "cursor" && hook.phase === "before") {
      throw new Error("Cursor permission hook returned no JSON decision");
    }
    return { deny: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("hook returned invalid JSON");
  }
  if (!isRecord(raw)) {
    throw new Error("hook output must be a JSON object");
  }
  const specific = isRecord(raw["hookSpecificOutput"]) ? raw["hookSpecificOutput"] : {};
  if (specific["hookEventName"] !== undefined && specific["hookEventName"] !== hook.event) {
    throw new Error("hook output event mismatch");
  }
  const known = new Set([
    "hookSpecificOutput",
    "decision",
    "reason",
    "continue",
    "stopReason",
    "systemMessage",
    "suppressOutput",
    "permission",
    "user_message",
    "agent_message",
    "additional_context",
    "updated_input",
  ]);
  if (Object.keys(raw).some((key) => !known.has(key))) {
    throw new Error("unsupported hook output field");
  }
  const knownSpecific = new Set([
    "hookEventName",
    "additionalContext",
    "permissionDecision",
    "permissionDecisionReason",
    "updatedInput",
  ]);
  if (Object.keys(specific).some((key) => !knownSpecific.has(key))) {
    throw new Error("unsupported hook-specific output field");
  }
  const decision = hook.format === "cursor" ? raw["permission"] : specific["permissionDecision"];
  if (decision === "ask") {
    throw new Error(
      "ask cannot be translated at execute.before; permission.evaluate lacks this tool input",
    );
  }
  if (decision !== undefined && decision !== "allow" && decision !== "deny") {
    throw new Error("unsupported permission decision");
  }
  if (raw["decision"] !== undefined && raw["decision"] !== "block") {
    throw new Error("unsupported legacy decision");
  }
  if (raw["suppressOutput"] === true) {
    throw new Error("suppressOutput cannot be translated");
  }
  const deny = decision === "deny" || raw["decision"] === "block" || raw["continue"] === false;
  if (deny && hook.phase !== "before") {
    throw new Error(
      "blocking/stop semantics unavailable after tool execution or during compaction",
    );
  }
  const context =
    hook.format === "cursor" ? raw["additional_context"] : specific["additionalContext"];
  const updatedInput = hook.format === "cursor" ? raw["updated_input"] : specific["updatedInput"];
  if (context !== undefined && typeof context !== "string") {
    throw new Error("additional context must be a string");
  }
  if (updatedInput !== undefined && (!isRecord(updatedInput) || hook.phase !== "before")) {
    throw new Error("updated input must be an object on a pre-tool hook");
  }
  if (hook.format === "cursor" && hook.phase === "before" && decision === undefined) {
    throw new Error("Cursor permission hook requires a permission decision");
  }
  if (hook.format === "codex" && updatedInput !== undefined && decision !== "allow") {
    throw new Error("Codex updatedInput requires explicit allow");
  }
  return {
    deny,
    ...(context === undefined ? {} : { context }),
    ...(isRecord(updatedInput) ? { updatedInput } : {}),
  };
};

interface HooksContext {
  readonly tool: Pick<Plugin.Context["tool"], "hook">;
  readonly session: Pick<Plugin.Context["session"], "hook">;
  readonly location: { readonly directory: string };
}
const registerHooks = async (
  ctx: HooksContext,
  getCurrentHooks: () => readonly PluginHook[],
  options: HookRegistrationOptions,
): Promise<() => Promise<void>> => {
  const controller = new AbortController();
  const contexts = new Map<string, string[]>();
  const registrations: { readonly dispose: () => Promise<void> }[] = [];
  const execute = async (
    hook: PluginHook,
    sessionID: string,
    fields: Record<string, unknown>,
  ): Promise<HookOutput> => {
    try {
      const input = {
        cwd: ctx.location.directory,
        hook_event_name: hook.event,
        // oxlint-disable-next-line unicorn/no-null -- Vendor protocol specifies null for unavailable transcripts.
        transcript_path: null,
        ...(hook.format === "cursor"
          ? { conversation_id: sessionID, workspace_roots: [ctx.location.directory] }
          : { session_id: sessionID }),
        ...fields,
      };
      const output = await runHookProcess(hook, input, {
        cwd: ctx.location.directory,
        env: options.env?.(hook),
        signal: controller.signal,
      });
      if (output.code !== 0 && output.code !== 2) {
        options.report({
          message: `${hook.event}: command exited ${output.code}; ${hook.failClosed ? "failClosed applies" : "vendor fail-open policy applies"}`,
          severity: "warning",
          source: hook.source,
        });
      }
      const decoded = decodeHookOutput(hook, output.stdout, output.code);
      if (decoded.context) {
        // Environment values never enter the model, even if a hook echoes them.
        const secrets = [
          // oxlint-disable-next-line node/no-process-env -- Redact inherited process values before model text.
          ...Object.values(process.env),
          ...Object.values(options.env?.(hook) ?? {}),
          ...(options.secretValues?.() ?? []),
        ].filter((value): value is string => typeof value === "string" && value.length > 0);
        const safe = redactHookContext(decoded.context, secrets);
        const existing = contexts.get(sessionID) ?? [];
        if (existing.length >= 32) {
          throw new Error("session hook context queue limit exceeded");
        }
        if (contexts.size >= 256 && !contexts.has(sessionID)) {
          throw new Error("hook context session limit exceeded");
        }
        contexts.set(sessionID, [...existing, safe]);
      }
      return decoded;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "hook failed";
      options.report({
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
  try {
    registrations.push(
      await ctx.tool.hook("execute.before", async (event) => {
        for (const hook of getCurrentHooks()) {
          if (hook.phase !== "before" || !options.enabled(hook)) {
            continue;
          }
          if (
            (hook.event === "beforeShellExecution" && event.tool !== "bash") ||
            (hook.event === "beforeReadFile" && event.tool !== "read")
          ) {
            continue;
          }
          const input = vendorInput(event.input);
          const name = options.toolName?.(hook, event.tool) ?? vendorTool(hook.format, event.tool);
          const codexFile = hook.format === "codex" && ["edit", "write"].includes(event.tool);
          const match = hook.event === "beforeShellExecution" ? commandText(input) : name;
          const matches = codexFile
            ? ["apply_patch", "Edit", "Write"].some((alias) => hookMatcher(hook, alias))
            : hookMatcher(hook, match);
          if (!matches) {
            continue;
          }
          if (codexFile) {
            options.report({
              message:
                "Codex file policy blocked: native edit/write inputs are not Codex apply_patch command inputs; use Claude/Cursor file hooks or a dedicated patch tool",
              severity: "error",
              source: hook.source,
            });
            throw new ToolError({
              message: "Codex file hook cannot translate native input; failed closed",
            });
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- Ordered rewrites depend on prior decisions.
          const output = await execute(hook, event.sessionID, {
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
      }),
    );
    // oxlint-disable-next-line unicorn/prefer-single-call -- Record each registration immediately so partial setup failures can dispose it.
    registrations.push(
      await ctx.tool.hook("execute.after", async (event) => {
        for (const hook of getCurrentHooks()) {
          if (
            hook.phase !== (event.status === "completed" ? "after" : "failure") ||
            !options.enabled(hook)
          ) {
            continue;
          }
          if (
            (hook.event === "afterShellExecution" && event.tool !== "bash") ||
            (hook.event === "afterFileEdit" && !["write", "edit"].includes(event.tool))
          ) {
            continue;
          }
          const input = vendorInput(event.input);
          const name = options.toolName?.(hook, event.tool) ?? vendorTool(hook.format, event.tool);
          if (
            !hookMatcher(hook, hook.event === "afterShellExecution" ? commandText(input) : name)
          ) {
            continue;
          }
          let resultFields: Record<string, unknown>;
          if (event.status === "completed") {
            resultFields =
              hook.format === "cursor"
                ? { tool_output: JSON.stringify(event.result) }
                : { tool_response: event.result };
          } else {
            resultFields = { error: event.error.message, error_message: event.error.message };
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve deterministic context ordering and bounded processes.
          await execute(hook, event.sessionID, {
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
              ? {
                  edits: cursorEdits(input),
                  file_path: input["file_path"],
                }
              : {}),
          });
        }
      }),
    );
    // oxlint-disable-next-line unicorn/prefer-single-call -- Record each registration immediately so partial setup failures can dispose it.
    registrations.push(
      await ctx.session.hook("compaction", async (event) => {
        await Promise.all(
          getCurrentHooks()
            .filter((hook) => hook.phase === "compaction" && options.enabled(hook))
            .map(async (hook) => execute(hook, event.sessionID, {})),
        );
      }),
    );
    // oxlint-disable-next-line unicorn/prefer-single-call -- Record each registration immediately so partial setup failures can dispose it.
    registrations.push(
      await ctx.session.hook("context", (event) => {
        const pending = contexts.get(event.sessionID) ?? [];
        contexts.delete(event.sessionID);
        for (const text of pending) {
          event.system.push({ text, type: "text" });
        }
      }),
    );
  } catch (error) {
    controller.abort();
    await Promise.all(registrations.map(async (registration) => registration.dispose()));
    throw error;
  }
  return async () => {
    controller.abort();
    contexts.clear();
    await Promise.all(registrations.map(async (registration) => registration.dispose()));
  };
};

export type { HookOutput, HookRegistrationOptions, HooksContext };
export { decodeHookOutput, nativeInput, redactHookContext, registerHooks, vendorInput, vendorTool };
