import path from "node:path";

import { isRecord, isStringArray } from "#src/json.ts";
import { COMPONENTS, FORMATS } from "#src/types.ts";
import type { Component, Diagnostic, Format } from "#src/types.ts";

interface Options {
  readonly searchPaths: readonly string[];
  readonly codexCache?: string;
  readonly dataRoot: string;
  readonly formats: ReadonlySet<Format>;
  readonly components: ReadonlySet<Component>;
  // Run `!`cmd`` injections in Claude commands when the user invokes them.
  readonly shellInjection: boolean;
}

interface OptionsInput {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly project: string;
  readonly home: string;
  readonly dataHome: string;
}

interface ScalarRule {
  readonly valid: (value: unknown) => boolean;
  readonly message: string;
}

// Each scalar option's type check and the message reported when it fails.
const SCALARS: Readonly<Record<string, ScalarRule>> = {
  dataDir: {
    message: "dataDir must be a string; using the default",
    valid: (value) => typeof value === "string",
  },
  paths: { message: "paths must be an array of strings; ignored", valid: isStringArray },
  shellInjection: {
    message: "shellInjection must be true or false; using true",
    valid: (value) => typeof value === "boolean",
  },
  vendorDirs: {
    message: "vendorDirs must be true or false; ignored",
    valid: (value) => typeof value === "boolean",
  },
};
const KNOWN = new Set([...Object.keys(SCALARS), "formats", "components"]);

const expandHome = (value: string, home: string) => value.replace(/^~(?=\/|$)/u, home);

// `{ claude: false }` turns one entry off; everything defaults to on.
const toggles = <Key extends string>(
  value: unknown,
  keys: readonly Key[],
  option: string,
  report: (diagnostic: Diagnostic) => void,
): ReadonlySet<Key> => {
  if (value === undefined) {
    return new Set(keys);
  }
  if (!isRecord(value)) {
    report({
      message: `${option} must be an object of booleans; using defaults`,
      severity: "error",
      source: "options",
    });
    return new Set(keys);
  }
  for (const [key, enabled] of Object.entries(value)) {
    if (!(keys as readonly string[]).includes(key)) {
      report({
        message: `unknown ${option} entry "${key}"; expected one of ${keys.join(", ")}`,
        severity: "warning",
        source: "options",
      });
    } else if (typeof enabled !== "boolean") {
      report({
        message: `${option}.${key} must be true or false`,
        severity: "error",
        source: "options",
      });
    }
  }
  return new Set(keys.filter((key) => value[key] !== false));
};

// Install caches each vendor reads from, added only when `vendorDirs` is on. Each is a directory
// of marketplaces or plugins, except Codex's versioned cache, which the loader expands itself.
const vendorDirectories = (home: string, formats: ReadonlySet<Format>) => ({
  codexCache: formats.has("codex") ? path.join(home, ".codex", "plugins", "cache") : undefined,
  searchPaths: [
    ...(formats.has("claude") ? [path.join(home, ".claude", "plugins", "marketplaces")] : []),
    ...(formats.has("cursor") ? [path.join(home, ".cursor", "plugins", "local")] : []),
  ],
});

const parseOptions = (input: OptionsInput, report: (diagnostic: Diagnostic) => void): Options => {
  const { home, project, raw } = input;
  for (const key of Object.keys(raw)) {
    if (!KNOWN.has(key)) {
      report({ message: `unknown option "${key}"`, severity: "warning", source: "options" });
    }
  }
  const formats = toggles(raw["formats"], FORMATS, "formats", report);
  const components = toggles(raw["components"], COMPONENTS, "components", report);
  for (const [key, rule] of Object.entries(SCALARS)) {
    if (raw[key] !== undefined && !rule.valid(raw[key])) {
      report({ message: rule.message, severity: "error", source: "options" });
    }
  }
  const { dataDir, paths, shellInjection, vendorDirs } = raw;
  const vendor =
    vendorDirs === true
      ? vendorDirectories(home, formats)
      : { codexCache: undefined, searchPaths: [] };
  const searchPaths = [
    path.join(home, ".agents", "plugins"),
    path.join(project, ".agents", "plugins"),
    ...vendor.searchPaths,
    ...(isStringArray(paths)
      ? paths.map((entry) => path.resolve(project, expandHome(entry, home)))
      : []),
  ];
  return {
    ...(vendor.codexCache === undefined ? {} : { codexCache: vendor.codexCache }),
    components,
    dataRoot:
      typeof dataDir === "string"
        ? path.resolve(project, expandHome(dataDir, home))
        : path.join(input.dataHome, "opencode", "agent-plugins"),
    formats,
    searchPaths,
    shellInjection: shellInjection !== false,
  };
};

export type { Options, OptionsInput };
export { parseOptions };
