import { isRecord, isStringArray } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import { COMPONENTS } from "#src/types.ts";
import type { Report } from "#src/types.ts";

const LEGACY = new Set([
  "paths",
  "vendorDirs",
  "dataDir",
  "shellInjection",
  "configuration",
  "pluginSettings",
  "trustedHooks",
  "trustedMonitors",
  "outputStyle",
  "allowSystemReplacement",
  "appEndpoints",
]);
const GROUPED = new Set(["discovery", "storage", "plugins"]);

const group = (value: unknown, source: string): JsonRecord => {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`${source} must be an object`);
  }
  return value;
};

const fields = (record: JsonRecord, allowed: readonly string[], source: string, report: Report) => {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      report({
        message: `unknown option "${source}.${key}"`,
        severity: "warning",
        source: "options",
      });
    }
  }
};

const bool = (record: JsonRecord, key: string, source: string): boolean | undefined => {
  const value = record[key];
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${source}.${key} must be true or false`);
  }
  return typeof value === "boolean" ? value : undefined;
};

const copy = (from: JsonRecord, key: string, to: Record<string, unknown>, target = key) => {
  if (from[key] !== undefined) {
    to[target] = from[key];
  }
};

const pluginConfiguration = (entry: JsonRecord, source: string, report: Report): JsonRecord => {
  const config = group(entry["configuration"], `${source}.configuration`);
  fields(config, ["userConfig", "variables", "publicVariables"], `${source}.configuration`, report);
  const agents = group(entry["agents"], `${source}.agents`);
  fields(agents, ["modelAliases"], `${source}.agents`, report);
  return {
    ...config,
    ...(agents["modelAliases"] === undefined ? {} : { modelAliases: agents["modelAliases"] }),
  };
};

const FEATURE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  commands: ["shellInjection"],
  styles: ["selected", "allowSystemReplacement"],
};

// The legacy runtime shape stays private to the normalisation boundary. Users configure features
// together and each plugin in one place, not independent name-keyed maps and trust lists.
const pluginSettings = (value: unknown, report: Report): JsonRecord => {
  const entries = group(value, "plugins");
  const activation: Record<string, boolean> = {};
  const configuration: Record<string, unknown> = {};
  const endpoints: Record<string, unknown> = {};
  const hooks: string[] = [];
  const monitors: string[] = [];
  for (const [name, raw] of Object.entries(entries)) {
    const source = `plugins.${name}`;
    const entry = group(raw, source);
    fields(
      entry,
      ["enabled", "hooks", "monitors", "configuration", "agents", "mcp"],
      source,
      report,
    );
    const enabled = bool(entry, "enabled", source);
    if (enabled !== undefined) {
      activation[name] = enabled;
    }
    for (const [feature, trusted] of [
      ["hooks", hooks],
      ["monitors", monitors],
    ] as const) {
      const settings = group(entry[feature], `${source}.${feature}`);
      fields(settings, ["trusted"], `${source}.${feature}`, report);
      if (bool(settings, "trusted", `${source}.${feature}`) === true) {
        trusted.push(name);
      }
    }
    configuration[name] = pluginConfiguration(entry, source, report);
    const mcp = group(entry["mcp"], `${source}.mcp`);
    fields(mcp, ["appEndpoints"], `${source}.mcp`, report);
    endpoints[name] = group(mcp["appEndpoints"], `${source}.mcp.appEndpoints`);
  }
  return {
    configuration,
    pluginAppEndpoints: endpoints,
    pluginSettings: activation,
    trustedHooks: hooks,
    trustedMonitors: monitors,
  };
};

const componentSettings = (value: unknown, output: Record<string, unknown>, report: Report) => {
  const components: Record<string, boolean> = {};
  const switches = group(value, "components");
  fields(switches, COMPONENTS, "components", report);
  for (const feature of COMPONENTS.filter((name) => !["commands", "styles"].includes(name))) {
    const enabled = bool(switches, feature, "components");
    if (enabled !== undefined) {
      components[feature] = enabled;
    }
  }
  for (const feature of ["commands", "styles"] as const) {
    const settings = group(switches[feature], `components.${feature}`);
    const special = FEATURE_FIELDS[feature] ?? [];
    fields(settings, ["enabled", ...special], `components.${feature}`, report);
    const enabled = bool(settings, "enabled", `components.${feature}`);
    if (enabled !== undefined) {
      components[feature] = enabled;
    }
    if (feature === "commands") {
      const injection = bool(settings, "shellInjection", `components.${feature}`);
      if (injection !== undefined) {
        output["shellInjection"] = injection;
      }
    }
    if (feature === "styles") {
      if (settings["selected"] !== undefined && typeof settings["selected"] !== "string") {
        throw new Error("components.styles.selected must be a plugin:name string");
      }
      copy(settings, "selected", output, "outputStyle");
      const replacement = bool(settings, "allowSystemReplacement", `components.${feature}`);
      if (replacement !== undefined) {
        output["allowSystemReplacement"] = replacement;
      }
    }
  }
  output["components"] = components;
};

const groupedSettings = (raw: JsonRecord, report: Report): JsonRecord => {
  fields(raw, ["discovery", "storage", "formats", "plugins", "components"], "options", report);
  for (const feature of COMPONENTS) {
    if (raw[feature] !== undefined) {
      throw new Error(`Move ${feature} settings into components.${feature}`);
    }
  }
  const output: Record<string, unknown> = { ...pluginSettings(raw["plugins"], report) };
  copy(raw, "formats", output);
  const discovery = group(raw["discovery"], "discovery");
  fields(discovery, ["paths", "vendorDirs"], "discovery", report);
  if (discovery["paths"] !== undefined && !isStringArray(discovery["paths"])) {
    throw new Error("discovery.paths must be an array of strings");
  }
  copy(discovery, "paths", output);
  const vendorDirs = bool(discovery, "vendorDirs", "discovery");
  if (vendorDirs !== undefined) {
    output["vendorDirs"] = vendorDirs;
  }
  const storage = group(raw["storage"], "storage");
  fields(storage, ["dataDir"], "storage", report);
  if (storage["dataDir"] !== undefined && typeof storage["dataDir"] !== "string") {
    throw new Error("storage.dataDir must be a string");
  }
  copy(storage, "dataDir", output);
  componentSettings(raw["components"], output, report);
  return output;
};

const normaliseSettings = (raw: JsonRecord, report: Report): JsonRecord => {
  const legacy = Object.keys(raw).some((key) => LEGACY.has(key));
  if (legacy) {
    if (Object.keys(raw).some((key) => GROUPED.has(key))) {
      throw new Error(
        "Do not mix legacy flat options with grouped options; migrate the whole options object",
      );
    }
    report({
      message:
        "legacy flat options are deprecated; group settings by feature and plugin (see README)",
      severity: "warning",
      source: "options",
    });
    return raw;
  }
  return groupedSettings(raw, report);
};

export { normaliseSettings };
