import path from "node:path";

import { optionalString, parseFrontmatter } from "#src/frontmatter.ts";
import { isRecord, isStringArray } from "#src/json.ts";
import { listDir, listTree, readText, resolveWithin } from "#src/paths.ts";
import type { CommandSyntax, PluginCommand, PluginRule, Report } from "#src/types.ts";

interface MarkdownFile {
  readonly path: string;
  // Name relative to the directory it was found in, without extension, using `/` separators.
  readonly name: string;
}

// Walks `directory` for files with one of `extensions`; a file target is returned as-is.
const findFiles = async (
  root: string,
  target: string,
  extensions: readonly string[],
  recursive: boolean,
  report: Report,
): Promise<MarkdownFile[]> => {
  const resolved = await resolveWithin(root, target);
  const source = path.relative(root, target) || ".";
  if (resolved.kind === "missing") {
    return [];
  }
  if (resolved.kind === "outside") {
    report({ message: "resolves outside the plugin root; skipped", severity: "error", source });
    return [];
  }
  if (resolved.kind === "file") {
    return [{ name: path.parse(resolved.path).name, path: resolved.path }];
  }
  if (resolved.kind !== "directory") {
    return [];
  }
  const entries = recursive ? await listTree(resolved.path) : await listDir(resolved.path);
  const files = entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => extensions.includes(path.extname(file).toLowerCase()));
  const contained = await Promise.all(files.map(async (file) => resolveWithin(root, file)));
  return files
    .flatMap((file, index) => {
      const check = contained[index];
      if (check?.kind !== "file") {
        return [];
      }
      const relative = path.relative(resolved.path, file);
      const parsed = path.parse(relative);
      return [
        { name: path.join(parsed.dir, parsed.name).split(path.sep).join("/"), path: check.path },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
};

const COMMAND_EXTENSIONS = [".md", ".mdc", ".markdown", ".txt"] as const;
const RULE_EXTENSIONS = [".md", ".mdc", ".markdown"] as const;

// `arguments` is a space-separated string or a YAML list (Claude Code).
const argumentNames = (value: unknown): string[] => {
  if (typeof value === "string") {
    return value.split(/\s+/u).filter((name) => name !== "");
  }
  return isStringArray(value) ? [...value] : [];
};

// Claude names nested command files `dir:file`; Cursor keeps the path.
const commandName = (name: string, syntax: CommandSyntax) =>
  syntax === "claude" ? name.replaceAll("/", ":") : name;

const loadCommand = async (
  file: MarkdownFile,
  root: string,
  syntax: CommandSyntax,
  report: Report,
): Promise<PluginCommand | undefined> => {
  const source = path.relative(root, file.path);
  const read = await readText(file.path);
  const parsed = read.ok ? parseFrontmatter(read.text, false) : read;
  if (!parsed.ok) {
    report({ message: `${parsed.error}; skipped`, severity: "error", source });
    return undefined;
  }
  if (parsed.body === "") {
    report({ message: "command has no body; skipped", severity: "error", source });
    return undefined;
  }
  const description = optionalString(parsed.data["description"]);
  // Claude ignores `name` in command files; Cursor reads it.
  const declared = syntax === "plain" ? optionalString(parsed.data["name"]) : undefined;
  return {
    arguments: argumentNames(parsed.data["arguments"]),
    name: declared ?? commandName(file.name, syntax),
    syntax,
    template: parsed.body,
    ...(description === undefined ? {} : { description }),
  };
};

const findAll = async (
  root: string,
  targets: readonly string[],
  extensions: readonly string[],
  report: Report,
): Promise<MarkdownFile[]> => {
  const found = await Promise.all(
    targets.map(async (target) => findFiles(root, target, extensions, true, report)),
  );
  return found.flat();
};

const discoverCommands = async (
  root: string,
  targets: readonly string[],
  syntax: CommandSyntax,
  report: Report,
): Promise<PluginCommand[]> => {
  const files = await findAll(root, targets, COMMAND_EXTENSIONS, report);
  const commands = await Promise.all(
    files.map(async (file) => loadCommand(file, root, syntax, report)),
  );
  return commands.filter((command) => command !== undefined);
};

const loadInlineCommand = async (
  root: string,
  name: string,
  value: unknown,
  report: Report,
): Promise<PluginCommand | undefined> => {
  const source = `plugin.json#commands.${name}`;
  if (!isRecord(value)) {
    report({ message: "command must be an object", severity: "error", source });
    return undefined;
  }
  const description = optionalString(value["description"]);
  const extra = description === undefined ? {} : { description };
  if (typeof value["content"] === "string") {
    return { arguments: [], name, syntax: "claude", template: value["content"].trim(), ...extra };
  }
  if (typeof value["source"] !== "string") {
    report({
      message: "command needs exactly one of source or content",
      severity: "error",
      source,
    });
    return undefined;
  }
  const target = path.resolve(root, value["source"]);
  const [file] = await findFiles(root, target, COMMAND_EXTENSIONS, false, report);
  const loaded =
    file === undefined ? undefined : await loadCommand({ ...file, name }, root, "claude", report);
  if (loaded === undefined) {
    report({ message: `command source "${value["source"]}" not found`, severity: "error", source });
    return undefined;
  }
  return { ...loaded, name, ...extra };
};

// Claude's object form: { name: { source | content, description } }.
const inlineCommands = async (
  root: string,
  map: Readonly<Record<string, unknown>>,
  report: Report,
): Promise<PluginCommand[]> => {
  const commands = await Promise.all(
    Object.entries(map).map(async ([name, value]) => loadInlineCommand(root, name, value, report)),
  );
  return commands.filter((command) => command !== undefined);
};

const globsOf = (value: unknown): string[] => {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((glob) => glob.trim())
      .filter((glob) => glob !== "");
  }
  return isStringArray(value) ? [...value] : [];
};

const loadRule = async (
  file: MarkdownFile,
  root: string,
  report: Report,
): Promise<PluginRule | undefined> => {
  const source = path.relative(root, file.path);
  const read = await readText(file.path);
  const parsed = read.ok ? parseFrontmatter(read.text, false) : read;
  if (!parsed.ok) {
    report({ message: `${parsed.error}; skipped`, severity: "error", source });
    return undefined;
  }
  if (parsed.body === "") {
    return undefined;
  }
  const description = optionalString(parsed.data["description"]);
  return {
    alwaysApply: parsed.data["alwaysApply"] === true,
    content: parsed.body,
    globs: globsOf(parsed.data["globs"]),
    name: file.name.replaceAll("/", "-"),
    path: file.path,
    ...(description === undefined ? {} : { description }),
  };
};

const discoverRules = async (
  root: string,
  targets: readonly string[],
  report: Report,
): Promise<PluginRule[]> => {
  const files = await findAll(root, targets, RULE_EXTENSIONS, report);
  const rules = await Promise.all(files.map(async (file) => loadRule(file, root, report)));
  return rules.filter((rule) => rule !== undefined);
};

export { discoverCommands, discoverRules, findFiles, inlineCommands };
