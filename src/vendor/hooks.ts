import path from "node:path";

import { isRecord } from "#src/json.ts";
import { readText, resolveWithin } from "#src/paths.ts";
import type { Format, Report } from "#src/types.ts";
import { componentPaths } from "#src/vendor/paths.ts";

type HookPhase = "before" | "after" | "failure" | "compaction";
interface PluginHook {
  readonly root: string;
  readonly format: "claude" | "codex" | "cursor";
  readonly event: string;
  readonly phase: HookPhase;
  readonly source: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly matcher?: string;
  readonly timeout: number;
  readonly failClosed: boolean;
}
interface HookLoadOptions {
  readonly enabled?: boolean;
  readonly report: Report;
}

const phases: Record<string, HookPhase> = {
  PostToolUse: "after",
  PostToolUseFailure: "failure",
  PreCompact: "compaction",
  PreToolUse: "before",
  afterFileEdit: "after",
  afterShellExecution: "after",
  beforeShellExecution: "before",
  postToolUse: "after",
  postToolUseFailure: "failure",
  preCompact: "compaction",
  preToolUse: "before",
};
const blockers: Record<string, string> = {
  PermissionRequest: "permission.evaluate lacks the vendor tool input and pending-request boundary",
  SessionEnd:
    "public removal events do not cover client close, archive and idle termination boundaries",
  SessionStart: "public creation events do not cover resume, clear and compaction-start boundaries",
  Stop: "no public before-turn-completion interception or vendor continuation boundary",
  UserPromptSubmit:
    "prompt admission has no typed rejection API; throwing is not a supported vendor rejection contract",
  beforeMCPExecution:
    "tool hooks lack MCP connection URL/launch metadata required by this policy contract",
  beforeReadFile:
    "execute.before lacks full file content and prompt attachments required by Cursor file access policy",
  beforeSubmitPrompt: "prompt admission has no typed rejection API",
  sessionEnd: "public removal events do not cover the Cursor editor session boundary",
  sessionStart: "public creation events do not cover the Cursor editor session boundary",
  stop: "no public before-turn-completion interception or bounded vendor follow-up loop",
};

const hookMatcher = (hook: Pick<PluginHook, "format" | "matcher">, value: string): boolean => {
  const pattern = hook.matcher;
  if (!pattern || pattern === "*") {
    return true;
  }
  if (hook.format === "claude" && /^[\w\- ,|]+$/u.test(pattern)) {
    return pattern.split(/[|,]/u).some((entry) => entry.trim() === value);
  }
  return new RegExp(pattern, "u").test(value);
};

// oxlint-disable-next-line eslint/complexity -- Reject independent vendor security fields rather than silently drop them.
const parseHooks = (
  root: string,
  format: PluginHook["format"],
  raw: unknown,
  source: string,
  options: HookLoadOptions,
): PluginHook[] => {
  const { report } = options;
  const error = (message: string) => {
    report({ message, severity: "error", source });
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
  const result: PluginHook[] = [];
  for (const [event, entries] of Object.entries(raw["hooks"])) {
    const phase = phases[event];
    if (!phase) {
      error(
        `${event}: unsupported hook event: ${blockers[event] ?? "no equivalent public OpenCode 2.0.24 event contract"}`,
      );
      continue;
    }
    if (
      (format !== "cursor" && event.startsWith(event.charAt(0).toLowerCase())) ||
      (format === "cursor" && event.startsWith(event.charAt(0).toUpperCase()))
    ) {
      error(`${event}: event belongs to a different vendor contract`);
      continue;
    }
    if (!Array.isArray(entries)) {
      error(`${event}: expected an array`);
      continue;
    }
    for (const entry of entries) {
      if (!isRecord(entry)) {
        error(`${event}: expected a hook object`);
        continue;
      }
      if (
        format !== "cursor" &&
        Object.keys(entry).some((key) => key !== "hooks" && key !== "matcher")
      ) {
        error(`${event}: unsupported matcher-group fields; group rejected, not weakened`);
        continue;
      }
      const handlers = format === "cursor" ? [entry] : entry["hooks"];
      if (!Array.isArray(handlers)) {
        error(`${event}: matcher group requires a hooks array`);
        continue;
      }
      for (const handler of handlers) {
        if (!isRecord(handler)) {
          error(`${event}: invalid handler`);
          continue;
        }
        const type = handler["type"] ?? (format === "cursor" ? "command" : undefined);
        if (type !== "command") {
          error(
            `${event}: unsupported hook type ${typeof type === "string" ? type : "invalid"}; only command/exec handlers are translated`,
          );
          continue;
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
          continue;
        }
        if (format === "cursor" && handler["args"] !== undefined) {
          error(`${event}: Cursor does not declare exec args`);
          continue;
        }
        const { command } = handler;
        const { args } = handler;
        const { matcher } = entry;
        const timeout = handler["timeout"] ?? 600;
        if (
          typeof command !== "string" ||
          !command.trim() ||
          (args !== undefined &&
            (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")))
        ) {
          error(`${event}: command must be non-empty and args must be strings`);
          continue;
        }
        if (
          typeof timeout !== "number" ||
          !Number.isFinite(timeout) ||
          timeout <= 0 ||
          timeout > 600
        ) {
          error(`${event}: timeout must be between 0 and 600 seconds`);
          continue;
        }
        if (matcher !== undefined && typeof matcher !== "string") {
          error(`${event}: matcher must be a string`);
          continue;
        }
        try {
          // oxlint-disable-next-line eslint/max-depth -- Regex validation is nested in the vendor handler hierarchy.
          if (matcher && matcher !== "*") {
            void new RegExp(matcher, "u");
          }
        } catch {
          error(`${event}: invalid regex matcher`);
          continue;
        }
        if (phase === "compaction" && matcher && matcher !== "*") {
          error(
            `${event}: OpenCode compaction hooks do not expose manual/auto trigger; matcher cannot be preserved`,
          );
          continue;
        }
        if (handler["failClosed"] !== undefined && typeof handler["failClosed"] !== "boolean") {
          error(`${event}: failClosed must be boolean`);
          continue;
        }
        if (format === "codex" && args !== undefined) {
          error(`${event}: Codex command hooks do not declare exec args`);
          continue;
        }
        if (command.includes("${user_config.")) {
          error(
            `${event}: user_config requires explicit validated exec expansion before registration`,
          );
          continue;
        }
        result.push({
          command,
          event,
          format,
          phase,
          root,
          source,
          ...(args === undefined ? {} : { args }),
          ...(matcher === undefined ? {} : { matcher }),
          failClosed: handler["failClosed"] === true,
          timeout: timeout * 1000,
        });
      }
    }
  }
  if (result.length > 0 && options.enabled !== true) {
    report({
      message: `${result.length} hooks parsed but execution disabled; opt in explicitly for this plugin (installation does not confer trust)`,
      severity: "warning",
      source,
    });
  }
  if (result.length > 0) {
    report({
      message:
        "Hook bridge supplies translated tool inputs, null transcript_path and no vendor permission_mode/model metadata. Handlers run in declaration order, not vendor parallel groups. It is not a complete vendor enforcement boundary; runtime unsupported decisions fail closed. Review these contract differences before opting in.",
      severity: "warning",
      source,
    });
  }
  return result;
};

const loadHooks = async (
  root: string,
  format: Format,
  manifestRaw: Record<string, unknown>,
  options: HookLoadOptions,
): Promise<PluginHook[]> => {
  if (format === "agent-plugins") {
    if (manifestRaw["hooks"] !== undefined) {
      options.report({
        message: "agent-plugins does not define a vendor hooks contract",
        severity: "error",
        source: root,
      });
    }
    return [];
  }
  const declared = manifestRaw["hooks"];
  // Claude adds declared sources to the fixed file; Codex/Cursor declarations replace it.
  const sources: unknown[] = [
    ...(declared === undefined || format === "claude" ? ["./hooks/hooks.json"] : []),
    ...(declared === undefined ? [] : [declared].flat()),
  ];
  const result: PluginHook[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (isRecord(source)) {
      result.push(...parseHooks(root, format, source, `${root}/plugin.json#hooks`, options));
      continue;
    }
    for (const target of componentPaths(source, root, "hooks", options.report)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Resolve sources in vendor precedence order and deduplicate symlinks.
      const resolved = await resolveWithin(root, target);
      if (resolved.kind === "missing" && declared === undefined) {
        continue;
      }
      if (resolved.kind !== "file") {
        options.report({
          message: "hook file missing, not a file, or symlink escapes plugin root",
          severity: "error",
          source: target,
        });
        continue;
      }
      if (seen.has(resolved.path)) {
        continue;
      }
      seen.add(resolved.path);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read only after containment validation.
      const text = await readText(resolved.path);
      if (!text.ok) {
        options.report({ message: "cannot read hooks file", severity: "error", source: target });
        continue;
      }
      try {
        result.push(
          ...parseHooks(
            root,
            format,
            JSON.parse(text.text) as unknown,
            path.relative(root, target),
            options,
          ),
        );
      } catch {
        options.report({ message: "invalid hooks JSON", severity: "error", source: target });
      }
    }
  }
  return result;
};

export type { HookLoadOptions, HookPhase, PluginHook };
export { hookMatcher, loadHooks, parseHooks };
