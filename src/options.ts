import path from "node:path";

import { parseConfigurationOptions } from "#src/config-options.ts";
import { isRecord, isStringArray, isStringRecord } from "#src/json.ts";
import { checkHeaders, checkUrl } from "#src/mcp.ts";
import { normaliseSettings } from "#src/settings-layout.ts";
import { COMPONENTS, FORMATS } from "#src/types.ts";
import type { Component, Diagnostic, Format, Report } from "#src/types.ts";
import type { AppEndpoint } from "#src/vendor/bridges.ts";
import type { PluginConfigurationOptions } from "#src/vendor/configuration.ts";

interface Options {
  readonly componentOverrides: Readonly<Record<string, ComponentOverride>>;
  readonly pluginAppEndpoints: Readonly<Record<string, Readonly<Record<string, AppEndpoint>>>>;
  readonly configuration: Readonly<Record<string, PluginConfigurationOptions>>;
  readonly trustedHooks: readonly string[];
  readonly trustedMonitors: readonly string[];
  readonly outputStyle?: string;
  readonly allowSystemReplacement: boolean;
  readonly pluginSettings: Readonly<Record<string, boolean>>;
  readonly appEndpoints: Readonly<Record<string, AppEndpoint>>;
  readonly searchPaths: readonly string[];
  readonly dataRoot: string;
  readonly formats: ReadonlySet<Format>;
  readonly components: ReadonlySet<Component>;
  // Run `!`cmd`` injections in Claude commands when the user invokes them.
  readonly shellInjection: boolean;
}

interface ComponentOverride {
  readonly enabled: Readonly<Partial<Record<Component, boolean>>>;
  readonly shellInjection?: boolean;
  readonly outputStyle?: string;
  readonly allowSystemReplacement?: boolean;
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
};
const KNOWN = new Set([
  ...Object.keys(SCALARS),
  "formats",
  "components",
  "appEndpoints",
  "pluginAppEndpoints",
  "componentOverrides",
  "pluginSettings",
  "configuration",
  "trustedHooks",
  "trustedMonitors",
  "outputStyle",
  "allowSystemReplacement",
]);

const parsePluginSettings = (
  value: unknown,
  report: (diagnostic: Diagnostic) => void,
): Record<string, boolean> => {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    report({
      message: "pluginSettings must map plugin names to booleans",
      severity: "error",
      source: "options",
    });
    return {};
  }
  const settings: Record<string, boolean> = {};
  for (const [name, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") {
      settings[name] = enabled;
    } else {
      report({
        message: `pluginSettings.${name} must be true or false`,
        severity: "error",
        source: "options",
      });
    }
  }
  return settings;
};

const parseAppEndpoints = (
  raw: unknown,
  report: (diagnostic: Diagnostic) => void,
): Record<string, AppEndpoint> => {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    report({
      message: "appEndpoints must be an object of explicit MCP endpoint mappings",
      severity: "error",
      source: "options",
    });
    return {};
  }
  const result: Record<string, AppEndpoint> = {};
  for (const [id, value] of Object.entries(raw)) {
    const error = isRecord(value)
      ? (checkUrl(value["url"]) ??
        (value["headers"] === undefined ? undefined : checkHeaders(value["headers"])))
      : "endpoint must be an object";
    if (error !== undefined || !isRecord(value)) {
      report({
        message: `invalid appEndpoints mapping for ${id}: ${error}`,
        severity: "error",
        source: "options",
      });
    } else {
      result[id] = {
        url: String(value["url"]),
        ...(isStringRecord(value["headers"]) ? { headers: value["headers"] } : {}),
      };
    }
  }
  return result;
};

const expandHome = (value: string, home: string) => value.replace(/^~(?=\/|$)/u, home);

const parsePluginAppEndpoints = (
  raw: unknown,
  report: Report,
): Record<string, Record<string, AppEndpoint>> =>
  isRecord(raw)
    ? Object.fromEntries(
        Object.entries(raw).map(([name, value]) => [name, parseAppEndpoints(value, report)]),
      )
    : {};

const parseComponentOverrides = (value: unknown): Record<string, ComponentOverride> => {
  if (!isRecord(value)) {
    return {};
  }
  const output: Record<string, ComponentOverride> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      throw new Error("component overrides must be objects");
    }
    const enabled: Partial<Record<Component, boolean>> = {};
    const { components } = entry;
    if (isRecord(components)) {
      for (const component of COMPONENTS) {
        const flag = components[component];
        if (typeof flag === "boolean") {
          enabled[component] = flag;
        }
      }
    }
    output[name] = {
      enabled,
      ...(typeof entry["shellInjection"] === "boolean"
        ? { shellInjection: entry["shellInjection"] }
        : {}),
      ...(typeof entry["outputStyle"] === "string" ? { outputStyle: entry["outputStyle"] } : {}),
      ...(typeof entry["allowSystemReplacement"] === "boolean"
        ? { allowSystemReplacement: entry["allowSystemReplacement"] }
        : {}),
    };
  }
  return output;
};

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

const parseOptions = (input: OptionsInput, report: (diagnostic: Diagnostic) => void): Options => {
  const { home, project } = input;
  const raw = normaliseSettings(input.raw, report);
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
  const { dataDir, paths, shellInjection } = raw;
  const searchPaths = [
    path.join(home, ".agents", "plugins"),
    path.join(project, ".agents", "plugins"),
    ...(isStringArray(paths)
      ? paths.map((entry) => path.resolve(project, expandHome(entry, home)))
      : []),
  ];
  return {
    allowSystemReplacement: raw["allowSystemReplacement"] === true,
    appEndpoints: parseAppEndpoints(raw["appEndpoints"], report),
    componentOverrides: parseComponentOverrides(raw["componentOverrides"]),
    configuration: parseConfigurationOptions(raw["configuration"], report),
    pluginAppEndpoints: parsePluginAppEndpoints(raw["pluginAppEndpoints"], report),
    pluginSettings: parsePluginSettings(raw["pluginSettings"], report),
    trustedHooks: isStringArray(raw["trustedHooks"]) ? raw["trustedHooks"] : [],
    trustedMonitors: isStringArray(raw["trustedMonitors"]) ? raw["trustedMonitors"] : [],
    ...(typeof raw["outputStyle"] === "string" ? { outputStyle: raw["outputStyle"] } : {}),
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

const componentsForPlugin = (options: Options, name: string): ReadonlySet<Component> => {
  const overrides = options.componentOverrides[name]?.enabled;
  return new Set(
    COMPONENTS.filter((component) => overrides?.[component] ?? options.components.has(component)),
  );
};

const commandInjectionForPlugin = (options: Options, name: string) =>
  options.componentOverrides[name]?.shellInjection ?? options.shellInjection;

export type { ComponentOverride, Options, OptionsInput };
export { commandInjectionForPlugin, componentsForPlugin, parseOptions };
