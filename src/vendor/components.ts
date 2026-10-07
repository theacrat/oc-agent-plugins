import path from "node:path";

import { isRecord } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import { discoverSingleSkill, discoverSkillsIn } from "#src/skills.ts";
import type { PluginCommand, PluginRule, PluginSkill, Report } from "#src/types.ts";
import type { FormatSpec } from "#src/vendor/formats.ts";
import { discoverCommands, discoverRules, inlineCommands } from "#src/vendor/markdown.ts";
import { componentPaths } from "#src/vendor/paths.ts";
import type { Placeholders } from "#src/vendor/placeholders.ts";

type ExpandBody = Placeholders["expandContent"] | undefined;

const expandSkill = (skill: PluginSkill, expand: ExpandBody): PluginSkill =>
  expand === undefined
    ? skill
    : Object.assign(skill, {
        content: expand(skill.content, { CLAUDE_SKILL_DIR: path.dirname(skill.path) }),
      });

const loadSkills = async (
  root: string,
  spec: FormatSpec,
  raw: JsonRecord,
  expand: ExpandBody,
  report: Report,
): Promise<PluginSkill[]> => {
  const declared =
    raw["skills"] === undefined ? [] : componentPaths(raw["skills"], root, "skills", report);
  const useDefault = !(spec.skillsDeclaredReplaces && declared.length > 0);
  const targets = [...new Set([...(useDefault ? [path.join(root, "skills")] : []), ...declared])];
  const found = await Promise.all(
    targets.map(async (target) => discoverSkillsIn(root, target, "lenient", report)),
  );
  // A root SKILL.md makes a single-skill plugin when nothing else declares skills (Claude and Cursor).
  if (found.flat().length === 0 && raw["skills"] === undefined) {
    const single = await discoverSingleSkill(root, report);
    return single.map((skill) => expandSkill(skill, expand));
  }
  // Later sources win on name, matching each host's precedence.
  const unique = new Map(found.flat().map((skill) => [skill.name, skill]));
  return [...unique.values()].map((skill) => expandSkill(skill, expand));
};

const discoverAllCommands = async (
  root: string,
  spec: FormatSpec,
  raw: JsonRecord,
  report: Report,
): Promise<PluginCommand[]> => {
  if (spec.commands === false) {
    return [];
  }
  const declared = raw["commands"];
  if (isRecord(declared)) {
    return inlineCommands(root, declared, report);
  }
  // Declared paths replace the default `commands/` directory for both Claude and Cursor.
  const targets =
    declared === undefined
      ? [path.join(root, "commands")]
      : componentPaths(declared, root, "commands", report);
  return discoverCommands(root, targets, spec.commands, report);
};

const loadCommands = async (
  root: string,
  spec: FormatSpec,
  raw: JsonRecord,
  expand: ExpandBody,
  report: Report,
): Promise<PluginCommand[]> => {
  const commands = await discoverAllCommands(root, spec, raw, report);
  return expand === undefined
    ? commands
    : commands.map((command) => Object.assign(command, { template: expand(command.template) }));
};

const loadRules = async (
  root: string,
  spec: FormatSpec,
  raw: JsonRecord,
  report: Report,
): Promise<PluginRule[]> => {
  if (!spec.rules) {
    return [];
  }
  const targets =
    raw["rules"] === undefined
      ? [path.join(root, "rules")]
      : componentPaths(raw["rules"], root, "rules", report);
  return discoverRules(root, targets, report);
};

export { loadCommands, loadRules, loadSkills };
