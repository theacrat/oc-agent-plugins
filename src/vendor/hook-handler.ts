import { isRecord } from "#src/json.ts";
import type { HookPhase, PluginHook } from "#src/vendor/hook-contract.ts";

type Reject = (message: string) => void;
interface HandlerContext {
  readonly root: string;
  readonly format: PluginHook["format"];
  readonly source: string;
  readonly event: string;
  readonly phase: HookPhase;
  readonly error: Reject;
}
const validateShape = (
  handler: Record<string, unknown>,
  format: PluginHook["format"],
  event: string,
  error: Reject,
): boolean => {
  const type = handler["type"] ?? (format === "cursor" ? "command" : undefined);
  if (type !== "command") {
    error(
      `${event}: unsupported hook type ${typeof type === "string" ? type : "invalid"}; only command/exec handlers are translated`,
    );
    return false;
  }
  const allowed = new Set([
    "type",
    "command",
    "args",
    "timeout",
    "matcher",
    "failClosed",
    "statusMessage",
  ]);
  const unsupported = Object.keys(handler).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    error(
      `${event}: unsupported handler fields: ${unsupported.join(", ")}; handler rejected, not weakened`,
    );
    return false;
  }
  if (format === "cursor" && handler["args"] !== undefined) {
    error(`${event}: Cursor does not declare exec args`);
    return false;
  }
  return true;
};
const validateMatcher = (
  matcher: unknown,
  phase: HookPhase,
  event: string,
  error: Reject,
): boolean => {
  if (matcher !== undefined && typeof matcher !== "string") {
    error(`${event}: matcher must be a string`);
    return false;
  }
  try {
    if (matcher && matcher !== "*") {
      void new RegExp(matcher, "u");
    }
  } catch {
    error(`${event}: invalid regex matcher`);
    return false;
  }
  if (phase === "compaction" && matcher && matcher !== "*") {
    error(
      `${event}: OpenCode compaction hooks do not expose manual/auto trigger; matcher cannot be preserved`,
    );
    return false;
  }
  return true;
};
const validatePolicy = (
  handler: Record<string, unknown>,
  command: string,
  context: HandlerContext,
): boolean => {
  const { error, event, format } = context;
  const { args } = handler;
  if (handler["failClosed"] !== undefined && typeof handler["failClosed"] !== "boolean") {
    error(`${event}: failClosed must be boolean`);
    return false;
  }
  if (format === "codex" && args !== undefined) {
    error(`${event}: Codex command hooks do not declare exec args`);
    return false;
  }
  if (command.includes("${user_config.")) {
    error(`${event}: user_config requires explicit validated exec expansion before registration`);
    return false;
  }
  return true;
};
const parseHandler = (
  raw: unknown,
  matcher: unknown,
  context: HandlerContext,
): PluginHook | undefined => {
  const { root, format, source, event, phase, error } = context;
  if (!isRecord(raw)) {
    error(`${event}: invalid handler`);
    return undefined;
  }
  const handler = raw;
  if (
    !validateShape(handler, format, event, error) ||
    !validateMatcher(matcher, phase, event, error)
  ) {
    return undefined;
  }
  const { command } = handler;
  const { args } = handler;

  const timeout = handler["timeout"] ?? 600;
  if (
    typeof command !== "string" ||
    !command.trim() ||
    (args !== undefined && (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")))
  ) {
    error(`${event}: command must be non-empty and args must be strings`);
    return undefined;
  }
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 600) {
    error(`${event}: timeout must be between 0 and 600 seconds`);
    return undefined;
  }
  if (!validatePolicy(handler, command, context)) {
    return undefined;
  }
  return {
    command,
    event,
    format,
    phase,
    root,
    source,
    ...(args === undefined ? {} : { args }),
    ...(typeof matcher === "string" ? { matcher } : {}),
    failClosed: handler["failClosed"] === true,
    timeout: timeout * 1000,
  };
};
export type { HandlerContext };
export { parseHandler };
