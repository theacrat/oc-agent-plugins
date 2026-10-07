import path from "node:path";

import { optionalString, parseFrontmatter } from "#src/frontmatter.ts";
import { isStringArray } from "#src/json.ts";
import { readText } from "#src/paths.ts";
import type { PermissionRule, PluginAgent, Report } from "#src/types.ts";
import { findAll } from "#src/vendor/markdown.ts";

// Claude Code tool names and the OpenCode permission actions that cover the same capability.
// Tools with no OpenCode counterpart (TodoWrite and task tools) are dropped silently;
// they never grant anything dangerous on their own.
const TOOL_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  Agent: ["subagent"],
  AskUserQuestion: ["question"],
  Bash: ["shell"],
  BashOutput: ["shell"],
  Edit: ["edit"],
  Glob: ["glob"],
  Grep: ["grep"],
  KillShell: ["shell"],
  LS: ["read", "glob"],
  MultiEdit: ["edit"],
  NotebookEdit: ["edit"],
  NotebookRead: ["read"],
  Read: ["read"],
  Task: ["subagent"],
  WebFetch: ["webfetch"],
  WebSearch: ["websearch"],
  Write: ["edit"],
};
const IGNORED_TOOLS = new Set([
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "Workflow",
]);

const COLORS: Readonly<Record<string, string>> = {
  blue: "#3b82f6",
  cyan: "#06b6d4",
  green: "#22c55e",
  orange: "#f97316",
  pink: "#ec4899",
  purple: "#a855f7",
  red: "#ef4444",
  yellow: "#eab308",
};

// Restricted tool entries are never widened into unrestricted grants.
const toolName = (entry: string) => /^(?<name>[A-Za-z]+)/u.exec(entry)?.groups?.["name"] ?? entry;

const toolList = (value: unknown): string[] | undefined => {
  if (typeof value === "string") {
    return value
      .split(/,(?![^(]*\))/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }
  return isStringArray(value) ? [...value] : undefined;
};

const restrictedPermissions = (entry: string, name: string): PermissionRule[] => {
  const argument = /^\w+\((?<argument>[^)]+)\)$/u.exec(entry)?.groups?.["argument"];
  if (argument === undefined || !["Agent", "Task", "Bash"].includes(name)) {
    return [];
  }
  return argument.split(",").map((value) => ({
    action: name === "Bash" ? "shell" : "subagent",
    effect: "allow",
    resource: name === "Bash" ? value.trim().replaceAll(":*", " *") : value.trim(),
  }));
};

// No `tools` means every tool, as in Claude Code, so the agent keeps OpenCode's defaults.
const toolPermissions = (tools: readonly string[] | undefined, warn: (message: string) => void) => {
  if (tools === undefined) {
    return [];
  }
  const actions = new Set<string>();
  const unmapped: string[] = [];
  const restricted: PermissionRule[] = [];
  for (const entry of tools) {
    const name = toolName(entry);
    const mapped = TOOL_ACTIONS[name];
    if (mapped !== undefined) {
      if (entry !== name) {
        const rules = restrictedPermissions(entry, name);
        if (rules.length > 0) {
          restricted.push(...rules);
        } else {
          unmapped.push(entry);
        }
        continue;
      }
      for (const action of mapped) {
        actions.add(action);
      }
    } else if (!IGNORED_TOOLS.has(name)) {
      unmapped.push(entry);
    }
  }
  if (unmapped.length > 0) {
    warn(`tools with no OpenCode equivalent were not granted: ${unmapped.join(", ")}`);
  }
  const rules: PermissionRule[] = [{ action: "*", effect: "deny", resource: "*" }];
  for (const action of [...actions].toSorted()) {
    rules.push({ action, effect: "allow", resource: "*" });
  }
  rules.push(...restricted);
  return rules;
};

const modelOf = (value: unknown) => {
  const model = optionalString(value);
  // `sonnet`, `opus`, `haiku` and `inherit` are Claude aliases; OpenCode needs provider/model.
  return model?.includes("/") === true ? model : undefined;
};

const colorOf = (value: unknown) => {
  const color = optionalString(value)?.toLowerCase();
  if (color === undefined) {
    return;
  }
  return /^#[0-9a-f]{6}$/u.test(color) ? color : COLORS[color];
};

const stepsOf = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const resolveAgentModel = (
  value: unknown,
  aliases: Readonly<Record<string, string>>,
  warn: (message: string) => void,
) => {
  const declared = optionalString(value);
  const model = modelOf(declared === undefined ? undefined : (aliases[declared] ?? declared));
  if (declared !== undefined && declared !== "inherit" && model === undefined) {
    warn(
      `model alias "${declared}" is not an OpenCode provider/model; inheriting the session model`,
    );
  }
  return model;
};

const loadAgent = async (
  file: { readonly path: string; readonly name: string },
  root: string,
  report: Report,
  aliases: Readonly<Record<string, string>> = {},
): Promise<PluginAgent | undefined> => {
  const source = path.relative(root, file.path);
  const warn = (message: string) => {
    report({ message, severity: "warning", source });
  };
  const read = await readText(file.path);
  const parsed = read.ok ? parseFrontmatter(read.text, false) : read;
  if (!parsed.ok) {
    report({ message: `${parsed.error}; skipped`, severity: "error", source });
    return undefined;
  }
  if (parsed.body === "") {
    report({ message: "agent has no prompt; skipped", severity: "error", source });
    return undefined;
  }
  const { data } = parsed;
  const description = optionalString(data["description"]);
  const model = resolveAgentModel(data["model"], aliases, warn);
  const color = colorOf(data["color"]);
  const steps = stepsOf(data["maxTurns"] ?? data["steps"]);
  // Claude's `tools` is an allowlist; `disallowedTools` removes from it.
  const disallowed = toolList(data["disallowedTools"]) ?? [];
  const tools = toolList(data["tools"])?.filter((tool) => !disallowed.includes(tool));
  const permissions = toolPermissions(tools, warn);
  for (const tool of disallowed) {
    for (const action of TOOL_ACTIONS[toolName(tool)] ?? []) {
      permissions.push({ action, effect: "deny", resource: "*" });
    }
  }
  return {
    mode: "subagent",
    // Claude names agents by frontmatter `name`, falling back to the file path.
    name: (optionalString(data["name"]) ?? file.name).replaceAll("/", ":"),
    permissions,
    system: parsed.body,
    ...(description === undefined ? {} : { description }),
    ...(model === undefined ? {} : { model }),
    ...(color === undefined ? {} : { color }),
    ...(steps === undefined ? {} : { steps }),
  };
};

const AGENT_EXTENSIONS = [".md", ".mdc", ".markdown"] as const;

const discoverAgents = async (
  root: string,
  targets: readonly string[],
  report: Report,
  aliases: Readonly<Record<string, string>> = {},
): Promise<PluginAgent[]> => {
  const files = await findAll(root, targets, AGENT_EXTENSIONS, report);
  const agents = await Promise.all(
    files.map(async (file) => loadAgent(file, root, report, aliases)),
  );
  return agents.filter((agent) => agent !== undefined);
};

export { discoverAgents, toolPermissions };
