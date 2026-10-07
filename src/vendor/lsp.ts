import path from "node:path";

import { isRecord, isStringArray, isStringRecord, parseJson } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import { readText, resolveWithin } from "#src/paths.ts";
import type { Report } from "#src/types.ts";
import { componentPaths } from "#src/vendor/paths.ts";

interface LspDefinition {
  readonly command: readonly string[];
  readonly extensions: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly initialization?: JsonRecord;
}

const parseLsp = (entry: unknown): LspDefinition | string => {
  if (!isRecord(entry) || typeof entry["command"] !== "string" || entry["command"].trim() === "") {
    return "LSP server must have a non-empty command";
  }
  const args = entry["args"] ?? [];
  if (!isStringArray(args)) {
    return "LSP args must be strings";
  }
  const extensions = entry["extensionToLanguage"];
  if (
    !isStringRecord(extensions) ||
    Object.keys(extensions).length === 0 ||
    Object.keys(extensions).some((extension) => !extension.startsWith("."))
  ) {
    return "LSP extensionToLanguage must map dot-prefixed extensions to language IDs";
  }
  if (entry["transport"] !== undefined && entry["transport"] !== "stdio") {
    return "OpenCode LSP export supports stdio only; socket transport cannot be preserved";
  }
  if (entry["env"] !== undefined && !isStringRecord(entry["env"])) {
    return "LSP env must contain string values";
  }
  if (entry["initializationOptions"] !== undefined && !isRecord(entry["initializationOptions"])) {
    return "LSP initializationOptions must be an object";
  }
  // Native V2 has no equivalents for these operational settings. Do not export a different server.
  const unsupported = [
    "settings",
    "workspaceFolder",
    "startupTimeout",
    "shutdownTimeout",
    "requestTimeout",
    "restartOnCrash",
    "maxRestarts",
    "diagnostics",
  ].filter((key) => entry[key] !== undefined);
  if (unsupported.length > 0) {
    return `LSP fields cannot be preserved by native V2 config: ${unsupported.join(", ")}`;
  }
  return {
    command: [entry["command"], ...args],
    extensions: Object.keys(extensions),
    ...(isStringRecord(entry["env"]) ? { env: entry["env"] } : {}),
    ...(isRecord(entry["initializationOptions"])
      ? { initialization: entry["initializationOptions"] }
      : {}),
  };
};

const readMap = async (
  root: string,
  file: string,
  required: boolean,
  report: Report,
): Promise<JsonRecord> => {
  const source = path.relative(root, file);
  const resolved = await resolveWithin(root, file);
  if (resolved.kind !== "file") {
    if (required || resolved.kind !== "missing") {
      report({
        message: "LSP config is missing or outside the plugin root",
        severity: "error",
        source,
      });
    }
    return {};
  }
  const text = await readText(resolved.path);
  const parsed = text.ok ? parseJson(text.text) : text;
  if (!parsed.ok || !isRecord(parsed.value)) {
    report({ message: "LSP config must be a readable JSON object", severity: "error", source });
    return {};
  }
  const map = parsed.value["lspServers"] ?? parsed.value;
  return isRecord(map) ? map : {};
};

// Produces a native config fragment, never writes or changes global configuration.
const loadLsp = async (
  root: string,
  declared: unknown,
  report: Report,
): Promise<Record<string, LspDefinition>> => {
  const defaults = await readMap(root, path.join(root, ".lsp.json"), false, report);
  const values = declared === undefined ? [] : [declared].flat();
  const maps = await Promise.all(
    values.map(async (value) => {
      if (isRecord(value)) {
        return value;
      }
      const [file] = componentPaths(value, root, "lspServers", report);
      return file === undefined ? {} : readMap(root, file, true, report);
    }),
  );
  const entries: Record<string, unknown> = {};
  for (const map of [defaults, ...maps]) {
    for (const [name, entry] of Object.entries(map)) {
      entries[name] = entry;
    }
  }
  const output: Record<string, LspDefinition> = {};
  for (const [name, entry] of Object.entries(entries)) {
    const parsed = parseLsp(entry);
    if (typeof parsed === "string") {
      report({ message: parsed, severity: "error", source: `lspServers#${name}` });
    } else {
      output[name] = parsed;
    }
  }
  return output;
};

const expandLsp = (
  definitions: Readonly<Record<string, LspDefinition>>,
  expand: (value: string) => string,
): Record<string, LspDefinition> =>
  Object.fromEntries(
    Object.entries(definitions).map(([name, entry]) => [
      name,
      {
        ...entry,
        command: entry.command.map((value) => expand(value)),
        ...(entry.env === undefined
          ? {}
          : {
              env: Object.fromEntries(
                Object.entries(entry.env).map(([key, value]) => [key, expand(value)]),
              ),
            }),
      },
    ]),
  );

export type { LspDefinition };
export { expandLsp, loadLsp, parseLsp };
