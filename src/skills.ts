import path from "node:path";

import { optionalString, parseFrontmatter } from "#src/frontmatter.ts";
import { isStringRecord } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import { listDir, readText, resolveWithin } from "#src/paths.ts";
import type { Diagnostic, PluginSkill, Report } from "#src/types.ts";

const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

// Agent Plugins requires Agent Skills conformance; vendor hosts accept looser skills.
type SkillMode = "strict" | "lenient";

type SkillResult =
  | { ok: true; skill: PluginSkill; warnings: string[] }
  | { ok: false; error: string };

const checkName = (name: unknown, directory: string): string | undefined => {
  if (typeof name !== "string" || name.trim() === "") {
    return "name must be a non-empty string";
  }
  const normalised = name.normalize("NFKC");
  if (normalised.length > 64) {
    return "name exceeds 64 characters";
  }
  if (normalised !== normalised.toLowerCase() || !/^[\p{L}\p{N}-]+$/u.test(normalised)) {
    return "name may only contain lowercase letters, digits and hyphens";
  }
  if (normalised.startsWith("-") || normalised.endsWith("-") || normalised.includes("--")) {
    return "name cannot start or end with a hyphen or contain '--'";
  }
  if (normalised !== directory.normalize("NFKC")) {
    return `name "${name}" must match its directory "${directory}"`;
  }
  return undefined;
};

const checkOptional = (doc: JsonRecord): string | undefined => {
  const { compatibility, license, metadata } = doc;
  if (
    compatibility !== undefined &&
    (typeof compatibility !== "string" || compatibility.length === 0 || compatibility.length > 500)
  ) {
    return "compatibility must be a 1-500 character string";
  }
  if (license !== undefined && typeof license !== "string") {
    return "license must be a string";
  }
  if (metadata !== undefined && !isStringRecord(metadata)) {
    return "metadata must map string keys to string values";
  }
  if (doc["allowed-tools"] !== undefined && typeof doc["allowed-tools"] !== "string") {
    return "allowed-tools must be a space-separated string";
  }
  return undefined;
};

// Claude Code reads yes/no/on/off/1/0 in any case as booleans too.
const isTruthy = (value: unknown) =>
  value === true ||
  (typeof value === "string" && ["true", "yes", "on", "1"].includes(value.toLowerCase()));

const parseStrict = (doc: JsonRecord, directory: string): string | undefined => {
  const { description } = doc;
  return (
    checkName(doc["name"], directory) ??
    (typeof description !== "string" || description.trim() === "" || description.length > 1024
      ? "description must be a 1-1024 character string"
      : undefined) ??
    checkOptional(doc)
  );
};

const parseSkill = (
  text: string,
  directory: string,
  file: string,
  mode: SkillMode = "strict",
): SkillResult => {
  const parsed = parseFrontmatter(text, mode === "strict");
  if (!parsed.ok) {
    return { error: `SKILL.md ${parsed.error}`, ok: false };
  }
  const { body, data } = parsed;
  if (mode === "strict") {
    const error = parseStrict(data, directory);
    if (error !== undefined) {
      return { error, ok: false };
    }
  }
  // Vendor hosts key skills by directory and fall back to it when frontmatter omits a name.
  const name = mode === "strict" ? String(data["name"]).normalize("NFKC") : directory;
  const description = optionalString(data["description"]);
  if (description === undefined) {
    return { error: "description is required so the model can discover the skill", ok: false };
  }
  const warnings =
    mode === "strict"
      ? Object.keys(data)
          .filter((key) => !KNOWN_FIELDS.has(key))
          .map((key) => `unknown frontmatter field "${key}"`)
      : [];
  // Claude Code: `disable-model-invocation: true` keeps the skill but hides it from the model.
  const hidden = mode === "lenient" && isTruthy(data["disable-model-invocation"]);
  return {
    ok: true,
    skill: { content: body, description, name, path: file, ...(hidden && { autoinvoke: false }) },
    warnings,
  };
};

const loadSkill = async (
  root: string,
  skillDir: string,
  mode: SkillMode,
  report: Report,
): Promise<PluginSkill | undefined> => {
  const directory = path.basename(skillDir);
  const source = path.relative(root, skillDir) || ".";
  const skillFile = await resolveWithin(root, path.join(skillDir, "SKILL.md"));
  if (skillFile.kind === "missing") {
    return undefined;
  }
  if (skillFile.kind !== "file") {
    report({
      message: "SKILL.md is not a regular file inside the plugin root; skipped",
      severity: "error",
      source,
    });
    return undefined;
  }
  const read = await readText(skillFile.path);
  const result = read.ok ? parseSkill(read.text, directory, skillFile.path, mode) : read;
  if (!result.ok) {
    report({ message: `${result.error}; skipped`, severity: "error", source });
    return undefined;
  }
  for (const message of result.warnings) {
    report({ message, severity: "warning", source });
  }
  return result.skill;
};

// Parse concurrently but report in directory order so diagnostics are deterministic.
const loadInOrder = async (
  skillDirs: readonly string[],
  load: (skillDir: string, report: Report) => Promise<PluginSkill | undefined>,
  report: Report,
): Promise<PluginSkill[]> => {
  const loaded = await Promise.all(
    skillDirs.map(async (skillDir) => {
      const diagnostics: Diagnostic[] = [];
      const skill = await load(skillDir, (diagnostic) => {
        diagnostics.push(diagnostic);
      });
      return { diagnostics, skill };
    }),
  );
  for (const { diagnostics } of loaded) {
    for (const diagnostic of diagnostics) {
      report(diagnostic);
    }
  }
  return loaded.flatMap(({ skill }) => (skill === undefined ? [] : [skill]));
};

// A skills directory holds <name>/SKILL.md children; vendor formats also allow SKILL.md directly in it.
const discoverSkillsIn = async (
  root: string,
  directory: string,
  mode: SkillMode,
  report: Report,
): Promise<PluginSkill[]> => {
  const location = await resolveWithin(root, directory);
  const source = path.relative(root, directory) || ".";
  if (location.kind === "missing") {
    return [];
  }
  if (location.kind !== "directory") {
    report({
      message: `${source} is not a directory inside the plugin root; skills disabled`,
      severity: "error",
      source,
    });
    return [];
  }
  if (mode === "lenient" && location.path !== root) {
    const direct = await resolveWithin(root, path.join(location.path, "SKILL.md"));
    if (direct.kind === "file") {
      return loadInOrder(
        [location.path],
        async (dir, sink) => loadSkill(root, dir, mode, sink),
        report,
      );
    }
  }
  const listing = await listDir(location.path);
  const children = listing
    .map((entry) => entry.name)
    .toSorted()
    .map((name) => path.join(location.path, name));
  return loadInOrder(children, async (dir, sink) => loadSkill(root, dir, mode, sink), report);
};

const discoverSingleSkill = async (root: string, report: Report): Promise<PluginSkill[]> => {
  const skill = await loadSkill(root, root, "lenient", report);
  return skill === undefined ? [] : [skill];
};

const discoverSkills = async (root: string, report: Report): Promise<PluginSkill[]> =>
  discoverSkillsIn(root, path.join(root, "skills"), "strict", report);

export type { SkillMode };
export { discoverSingleSkill, discoverSkills, discoverSkillsIn, parseSkill };
