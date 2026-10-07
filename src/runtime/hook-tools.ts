import { isRecord } from "#src/json.ts";
import type { PluginHook } from "#src/vendor/hooks.ts";
import { hookMatcher } from "#src/vendor/hooks.ts";

const vendorTool = (format: PluginHook["format"], tool: string): string => {
  const names: Record<string, string> = {
    apply_patch: "apply_patch",
    bash: format === "cursor" ? "Shell" : "Bash",
    edit: format === "cursor" ? "Write" : "Edit",
    glob: "Glob",
    grep: "Grep",
    patch: format === "codex" ? "apply_patch" : "Edit",
    read: "Read",
    shell: format === "cursor" ? "Shell" : "Bash",
    subagent: format === "codex" ? "Agent" : "Task",
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

const toolMatches = (
  hook: PluginHook,
  tool: string,
  name: string,
  input: Record<string, unknown>,
): boolean => {
  if (["beforeShellExecution", "afterShellExecution"].includes(hook.event)) {
    return ["shell", "bash"].includes(tool) && hookMatcher(hook, commandText(input));
  }
  if (hook.event === "afterFileEdit" && !["edit", "write"].includes(tool)) {
    return false;
  }
  const aliases = [name];
  if (["subagent", "task"].includes(tool)) {
    aliases.push("Task", "Agent");
  }
  if (hook.format === "codex" && ["patch", "apply_patch", "edit", "write"].includes(tool)) {
    aliases.push("apply_patch", "Edit", "Write");
  }
  return aliases.some((alias) => hookMatcher(hook, alias));
};

export {
  commandText,
  cursorEdits,
  nativeInput,
  redactHookContext,
  toolMatches,
  vendorInput,
  vendorTool,
};
