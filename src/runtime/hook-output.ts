import { isRecord } from "#src/json.ts";
import type { PluginHook } from "#src/vendor/hooks.ts";

interface HookOutput {
  readonly context?: string;
  readonly updatedInput?: Record<string, unknown>;
  readonly deny: boolean;
}
const parseOutput = (stdout: string): Record<string, unknown> => {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("hook returned invalid JSON");
  }
  if (!isRecord(raw)) {
    throw new Error("hook output must be a JSON object");
  }
  if (raw["hookSpecificOutput"] !== undefined && !isRecord(raw["hookSpecificOutput"])) {
    throw new Error("hookSpecificOutput must be an object");
  }
  return raw;
};

const validateFields = (
  raw: Record<string, unknown>,
  specific: Record<string, unknown>,
  hook: PluginHook,
): void => {
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
  const foreignFields =
    hook.format === "cursor"
      ? ["hookSpecificOutput", "decision", "continue", "suppressOutput"]
      : ["permission", "updated_input", "additional_context"];
  if (foreignFields.some((key) => raw[key] !== undefined)) {
    throw new Error("output fields belong to a different vendor contract");
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
  if (specific["hookEventName"] !== undefined && specific["hookEventName"] !== hook.event) {
    throw new Error("hook output event mismatch");
  }
  for (const key of ["continue", "suppressOutput"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      throw new Error(`${key} must be boolean`);
    }
  }
};

const outputDenies = (
  hook: PluginHook,
  raw: Record<string, unknown>,
  specific: Record<string, unknown>,
): boolean => {
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
  return deny;
};

const decodeFields = (
  hook: PluginHook,
  raw: Record<string, unknown>,
  specific: Record<string, unknown>,
  deny: boolean,
): HookOutput => {
  const context =
    hook.format === "cursor" ? raw["additional_context"] : specific["additionalContext"];
  const updatedInput = hook.format === "cursor" ? raw["updated_input"] : specific["updatedInput"];
  if (context !== undefined && typeof context !== "string") {
    throw new Error("additional context must be a string");
  }
  if (updatedInput !== undefined && (!isRecord(updatedInput) || hook.phase !== "before")) {
    throw new Error("updated input must be an object on a pre-tool hook");
  }
  if (
    hook.format === "cursor" &&
    hook.phase === "before" &&
    (hook.format === "cursor" ? raw["permission"] : specific["permissionDecision"]) === undefined
  ) {
    throw new Error("Cursor permission hook requires a permission decision");
  }
  if (
    hook.format === "codex" &&
    updatedInput !== undefined &&
    specific["permissionDecision"] !== "allow"
  ) {
    throw new Error("Codex updatedInput requires explicit allow");
  }
  return {
    deny,
    ...(context === undefined ? {} : { context }),
    ...(isRecord(updatedInput) ? { updatedInput } : {}),
  };
};

const decodeExit = (hook: PluginHook, stdout: string, code: number): HookOutput | undefined => {
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
  return undefined;
};

const decodeHookOutput = (hook: PluginHook, stdout: string, code: number): HookOutput => {
  const exit = decodeExit(hook, stdout, code);
  if (exit) {
    return exit;
  }
  const raw = parseOutput(stdout);
  const specific = isRecord(raw["hookSpecificOutput"]) ? raw["hookSpecificOutput"] : {};
  validateFields(raw, specific, hook);
  return decodeFields(hook, raw, specific, outputDenies(hook, raw, specific));
};

export type { HookOutput };
export { decodeHookOutput };
