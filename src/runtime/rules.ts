import path from "node:path";

import type { Plugin } from "@opencode/plugin";

import { isRecord } from "#src/json.ts";
import { isWithin } from "#src/paths.ts";
import type { PluginRule } from "#src/types.ts";

interface RuleRuntime {
  readonly clearSession: (sessionID: string) => void;
  readonly replace: (rules: readonly PluginRule[]) => void;
  readonly dispose: () => Promise<void>;
}

const ruleMatchesFile = (rule: PluginRule, file: string, directory: string): boolean => {
  const absolute = path.resolve(directory, file);
  if (!isWithin(directory, absolute)) {
    return false;
  }
  const relative = path.relative(directory, absolute).split(path.sep).join("/");
  return rule.globs.some((glob) => path.matchesGlob(relative, glob));
};

const filesForTool = (tool: string, input: unknown): string[] => {
  if (!isRecord(input)) {
    return [];
  }
  if ((tool === "apply_patch" || tool === "patch") && typeof input["patchText"] === "string") {
    return [
      ...input["patchText"].matchAll(
        /^\*\*\* (?:Add File|Update File|Delete File|Move to): (?<file>.+)$/gmu,
      ),
    ].flatMap((match) => (match.groups?.["file"] === undefined ? [] : [match.groups["file"]]));
  }
  const fields: Readonly<Record<string, readonly string[]>> = {
    edit: ["path", "filePath"],
    glob: ["path"],
    grep: ["path"],
    read: ["path", "filePath"],
    write: ["path", "filePath"],
  };
  return (fields[tool] ?? []).flatMap((field) =>
    typeof input[field] === "string" ? [input[field]] : [],
  );
};

const trackFiles = (
  files: Map<string, Set<string>>,
  sessionID: string,
  directory: string,
  paths: readonly string[],
): void => {
  if (paths.length === 0) {
    return;
  }
  const active = files.get(sessionID) ?? new Set<string>();
  for (const file of paths) {
    const absolute = path.resolve(directory, file);
    if (isWithin(directory, absolute)) {
      active.add(absolute);
    }
  }
  files.set(sessionID, active);
};

const activeRules = (
  rules: readonly PluginRule[],
  files: ReadonlySet<string> | undefined,
  directory: string,
): readonly PluginRule[] =>
  rules.filter(
    (rule) =>
      rule.alwaysApply || [...(files ?? [])].some((file) => ruleMatchesFile(rule, file, directory)),
  );

const registerScopedRules = async (
  ctx: Pick<Plugin.Context, "tool" | "session">,
  directory: string,
  initial: readonly PluginRule[],
): Promise<RuleRuntime> => {
  let rules = structuredClone(initial);
  let disposed = false;
  const files = new Map<string, Set<string>>();
  const tool = await ctx.tool.hook("execute.before", (event) => {
    if (disposed) {
      return;
    }
    trackFiles(files, event.sessionID, directory, filesForTool(event.tool, event.input));
  });
  let context;
  try {
    context = await ctx.session.hook("context", (event) => {
      if (disposed) {
        return;
      }
      for (const rule of activeRules(rules, files.get(event.sessionID), directory)) {
        event.system.push({ text: rule.content, type: "text" });
      }
    });
  } catch (error) {
    await tool.dispose();
    throw error;
  }
  return {
    clearSession: (sessionID) => {
      files.delete(sessionID);
    },
    dispose: async () => {
      if (disposed) {
        return;
      }
      disposed = true;
      files.clear();
      await Promise.all([tool.dispose(), context.dispose()]);
    },
    replace: (next) => {
      rules = structuredClone(next);
      files.clear();
    },
  };
};

export type { RuleRuntime };
export { filesForTool, registerScopedRules, ruleMatchesFile };
