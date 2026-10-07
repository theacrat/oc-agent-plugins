import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { errorMessage, isRecord, isStringRecord } from "@/json.ts";
import { resolveWithin } from "@/paths.ts";
import type { Diagnostic, PluginSkill } from "@/types.ts";

const FRONTMATTER = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const KNOWN_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

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

const checkOptional = (doc: Readonly<Record<string, unknown>>): string | undefined => {
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

const parseSkill = (text: string, directory: string, file: string): SkillResult => {
  const match = FRONTMATTER.exec(text);
  if (match?.groups?.["yaml"] === undefined) {
    return { error: "SKILL.md must start with YAML frontmatter", ok: false };
  }
  let doc: unknown;
  try {
    doc = parse(match.groups["yaml"]);
  } catch (error) {
    return {
      error: `invalid frontmatter YAML: ${errorMessage(error)}`,
      ok: false,
    };
  }
  if (!isRecord(doc)) {
    return { error: "frontmatter must be a YAML mapping", ok: false };
  }
  const { description, name } = doc;
  const error =
    checkName(name, directory) ??
    (typeof description !== "string" || description.trim() === "" || description.length > 1024
      ? "description must be a 1-1024 character string"
      : undefined) ??
    checkOptional(doc);
  if (error !== undefined || typeof name !== "string" || typeof description !== "string") {
    return { error: error ?? "invalid frontmatter", ok: false };
  }
  const warnings = Object.keys(doc)
    .filter((key) => !KNOWN_FIELDS.has(key))
    .map((key) => `unknown frontmatter field "${key}"`);
  return {
    ok: true,
    skill: {
      content: text.slice(match[0].length).trim(),
      description,
      name: name.normalize("NFKC"),
      path: file,
    },
    warnings,
  };
};

const loadSkill = async (
  root: string,
  skillsDir: string,
  entry: string,
  report: (diagnostic: Diagnostic) => void,
): Promise<PluginSkill | undefined> => {
  const source = `skills/${entry}`;
  const skillFile = await resolveWithin(root, path.join(skillsDir, entry, "SKILL.md"));
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
  const result = parseSkill(await readFile(skillFile.path, "utf8"), entry, skillFile.path);
  if (!result.ok) {
    report({ message: `${result.error}; skipped`, severity: "error", source });
    return undefined;
  }
  for (const message of result.warnings) {
    report({ message, severity: "warning", source });
  }
  return result.skill;
};

const discoverSkills = async (
  root: string,
  report: (diagnostic: Diagnostic) => void,
): Promise<PluginSkill[]> => {
  const location = await resolveWithin(root, path.join(root, "skills"));
  if (location.kind === "missing") {
    return [];
  }
  if (location.kind !== "directory") {
    report({
      message: "skills/ is not a directory inside the plugin root; skills disabled",
      severity: "error",
      source: "skills",
    });
    return [];
  }
  const names = await readdir(location.path);
  const entries = names.toSorted();
  // Parse concurrently but report in directory order so diagnostics are deterministic.
  const loaded = await Promise.all(
    entries.map(async (entry) => {
      const diagnostics: Diagnostic[] = [];
      const skill = await loadSkill(root, location.path, entry, (diagnostic) => {
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

export { discoverSkills, parseSkill };
