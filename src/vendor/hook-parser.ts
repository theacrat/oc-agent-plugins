import { isRecord } from "#src/json.ts";
import { blockers, phases } from "#src/vendor/hook-contract.ts";
import type { HookLoadOptions, PluginHook } from "#src/vendor/hook-contract.ts";
import { parseHandler } from "#src/vendor/hook-handler.ts";
import type { HandlerContext } from "#src/vendor/hook-handler.ts";

const parseEntry = (entry: unknown, context: HandlerContext): PluginHook[] => {
  const { format, event, error } = context;
  if (!isRecord(entry)) {
    error(`${event}: expected a hook object`);
    return [];
  }
  if (
    format !== "cursor" &&
    Object.keys(entry).some((key) => key !== "hooks" && key !== "matcher")
  ) {
    error(`${event}: unsupported matcher-group fields; group rejected, not weakened`);
    return [];
  }
  const handlers = format === "cursor" ? [entry] : entry["hooks"];
  if (!Array.isArray(handlers)) {
    error(`${event}: matcher group requires a hooks array`);
    return [];
  }
  return handlers.flatMap((handler) => {
    const parsed = parseHandler(handler, entry["matcher"], context);
    return parsed ? [parsed] : [];
  });
};
const parseEvent = (
  event: string,
  entries: unknown,
  context: Omit<HandlerContext, "event" | "phase">,
): PluginHook[] => {
  const { error, format } = context;
  const phase = phases[event];
  if (!phase) {
    error(
      `${event}: unsupported hook event: ${blockers[event] ?? "no equivalent public OpenCode 2.0.24 event contract"}`,
    );
    return [];
  }
  if (
    (format !== "cursor" && event.startsWith(event.charAt(0).toLowerCase())) ||
    (format === "cursor" && event.startsWith(event.charAt(0).toUpperCase()))
  ) {
    error(`${event}: event belongs to a different vendor contract`);
    return [];
  }
  if (!Array.isArray(entries)) {
    error(`${event}: expected an array`);
    return [];
  }
  return entries.flatMap((entry) => parseEntry(entry, { ...context, event, phase }));
};
const reportContracts = (
  result: readonly PluginHook[],
  source: string,
  options: HookLoadOptions,
): void => {
  if (result.length === 0) {
    return;
  }
  if (options.enabled !== true) {
    options.report({
      message: `${result.length} hooks parsed but execution disabled; opt in explicitly for this plugin (installation does not confer trust)`,
      severity: "warning",
      source,
    });
  }
  options.report({
    message:
      "Hook bridge supplies translated tool inputs, null transcript_path and no vendor permission_mode/model metadata. Handlers run in declaration order, not vendor parallel groups. It is not a complete vendor enforcement boundary; runtime unsupported decisions fail closed. Review these contract differences before opting in.",
    severity: "warning",
    source,
  });
};
const parseHooks = (
  root: string,
  format: PluginHook["format"],
  raw: unknown,
  source: string,
  options: HookLoadOptions,
): PluginHook[] => {
  const error = (message: string) => {
    options.report({ message, severity: "error", source });
  };
  if (!isRecord(raw) || !isRecord(raw["hooks"])) {
    error("hooks configuration must contain a hooks object");
    return [];
  }
  if (format === "cursor" && raw["version"] !== undefined && raw["version"] !== 1) {
    error(
      "Cursor hooks support only version: 1 (the plugin reference also permits an omitted version)",
    );
    return [];
  }
  const result = Object.entries(raw["hooks"]).flatMap(([event, entries]) =>
    parseEvent(event, entries, { error, format, root, source }),
  );
  reportContracts(result, source, options);
  return result;
};
export { parseHooks };
