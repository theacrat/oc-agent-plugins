import { parseConfigurationOptions } from "#src/config-options.ts";
import { isRecord, isStringArray, isStringRecord } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import { checkHeaders, checkUrl } from "#src/mcp.ts";
import type { ComponentOverride } from "#src/options.ts";
import { COMPONENTS, FORMATS } from "#src/types.ts";
import type { Component, Format, Report } from "#src/types.ts";
import type { AppEndpoint } from "#src/vendor/bridges.ts";
import type { PluginConfigurationOptions } from "#src/vendor/configuration.ts";

interface NormalisedSettings {
  readonly componentOverrides: Record<string, ComponentOverride>;
  readonly configuration: Record<string, PluginConfigurationOptions>;
  readonly pluginAppEndpoints: Record<string, Record<string, AppEndpoint>>;
  readonly pluginSettings: Record<string, boolean>;
  readonly trustedHooks: string[];
  readonly trustedMonitors: string[];
  readonly formats: Partial<Record<Format, boolean>>;
  readonly components: Readonly<Partial<Record<Component, boolean>>>;
  readonly paths?: readonly string[];
  readonly dataDir?: string;
  readonly shellInjection?: boolean;
  readonly outputStyle?: string;
  readonly allowSystemReplacement?: boolean;
}

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

const pluginConfiguration = (entry: JsonRecord, source: string, report: Report): JsonRecord => {
  const config = group(entry["configuration"], `${source}.configuration`);
  fields(config, ["userConfig", "variables", "publicVariables"], `${source}.configuration`, report);
  const agents = group(entry["agents"], `${source}.agents`);
  fields(agents, ["modelAliases"], `${source}.agents`, report);
  return {
    publicVariables: config["publicVariables"],
    userConfig: config["userConfig"],
    variables: config["variables"],
    ...(agents["modelAliases"] === undefined ? {} : { modelAliases: agents["modelAliases"] }),
  };
};

const FEATURE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  commands: ["shellInjection"],
  styles: ["selected", "allowSystemReplacement"],
};

const configurationForPlugin = (entry: JsonRecord, name: string, source: string, report: Report) =>
  parseConfigurationOptions(
    { [name]: pluginConfiguration(entry, source, report) },
    report,
    () => `${source}.configuration`,
    () => `${source}.agents.modelAliases`,
  );

// Convert the grouped public settings into the runtime's indexed settings.
function componentSettings(
  value: unknown,
  report: Report,
  source = "components",
): ComponentOverride {
  const components: Partial<Record<Component, boolean>> = {};
  let shellInjection: boolean | undefined;
  let outputStyle: string | undefined;
  let allowSystemReplacement: boolean | undefined;
  const switches = group(value, source);
  fields(switches, COMPONENTS, source, report);
  for (const feature of COMPONENTS.filter((name) => !["commands", "styles"].includes(name))) {
    const enabled = bool(switches, feature, source);
    if (enabled !== undefined) {
      components[feature] = enabled;
    }
  }
  for (const feature of ["commands", "styles"] as const) {
    const settings = group(switches[feature], `${source}.${feature}`);
    const special = FEATURE_FIELDS[feature] ?? [];
    fields(settings, ["enabled", ...special], `${source}.${feature}`, report);
    const enabled = bool(settings, "enabled", `${source}.${feature}`);
    if (enabled !== undefined) {
      components[feature] = enabled;
    }
    if (feature === "commands") {
      shellInjection = bool(settings, "shellInjection", `${source}.${feature}`);
    }
    if (feature === "styles") {
      if (settings["selected"] !== undefined && typeof settings["selected"] !== "string") {
        throw new Error(`${source}.styles.selected must be a plugin:name string`);
      }
      if (typeof settings["selected"] === "string") {
        outputStyle = settings["selected"];
      }
      allowSystemReplacement = bool(settings, "allowSystemReplacement", `${source}.${feature}`);
    }
  }
  return {
    enabled: components,
    ...(shellInjection === undefined ? {} : { shellInjection }),
    ...(outputStyle === undefined ? {} : { outputStyle }),
    ...(allowSystemReplacement === undefined ? {} : { allowSystemReplacement }),
  };
}

const appEndpoints = (
  value: unknown,
  source: string,
  report: Report,
): Record<string, AppEndpoint> => {
  const endpoints = group(value, source);
  const output: Record<string, AppEndpoint> = {};
  for (const [id, raw] of Object.entries(endpoints)) {
    const owner = `${source}.${id}`;
    const endpoint = group(raw, owner);
    fields(endpoint, ["url", "headers"], owner, report);
    const error =
      checkUrl(endpoint["url"]) ??
      (endpoint["headers"] === undefined ? undefined : checkHeaders(endpoint["headers"]));
    if (error !== undefined) {
      throw new Error(`${owner}: ${error}`);
    }
    output[id] = {
      url: String(endpoint["url"]),
      ...(isStringRecord(endpoint["headers"]) ? { headers: endpoint["headers"] } : {}),
    };
  }
  return output;
};

const pluginSettings = (value: unknown, report: Report) => {
  const entries = group(value, "plugins");
  const activation: Record<string, boolean> = {};
  const configuration: Record<string, PluginConfigurationOptions> = {};
  const endpoints: Record<string, Record<string, AppEndpoint>> = {};
  const overrides: Record<string, ComponentOverride> = {};
  const hooks: string[] = [];
  const monitors: string[] = [];
  for (const [name, raw] of Object.entries(entries)) {
    const source = `plugins.${name}`;
    const entry = group(raw, source);
    fields(
      entry,
      ["enabled", "hooks", "monitors", "configuration", "agents", "mcp", "components"],
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
    Object.assign(configuration, configurationForPlugin(entry, name, source, report));
    const mcp = group(entry["mcp"], `${source}.mcp`);
    fields(mcp, ["appEndpoints"], `${source}.mcp`, report);
    endpoints[name] = appEndpoints(mcp["appEndpoints"], `${source}.mcp.appEndpoints`, report);
    overrides[name] = componentSettings(entry["components"], report, `${source}.components`);
  }
  return {
    componentOverrides: overrides,
    configuration,
    pluginAppEndpoints: endpoints,
    pluginSettings: activation,
    trustedHooks: hooks,
    trustedMonitors: monitors,
  };
};

const groupedSettings = (raw: JsonRecord, report: Report): NormalisedSettings => {
  fields(raw, ["discovery", "storage", "formats", "plugins", "components"], "options", report);
  for (const feature of COMPONENTS) {
    if (raw[feature] !== undefined) {
      throw new Error(`Move ${feature} settings into components.${feature}`);
    }
  }
  const plugins = pluginSettings(raw["plugins"], report);
  const formats: Partial<Record<Format, boolean>> = {};
  const formatSettings = group(raw["formats"], "formats");
  fields(formatSettings, FORMATS, "formats", report);
  for (const format of FORMATS) {
    const enabled = bool(formatSettings, format, "formats");
    if (enabled !== undefined) {
      formats[format] = enabled;
    }
  }
  const discovery = group(raw["discovery"], "discovery");
  fields(discovery, ["paths"], "discovery", report);
  if (discovery["paths"] !== undefined && !isStringArray(discovery["paths"])) {
    throw new Error("discovery.paths must be an array of strings");
  }
  const storage = group(raw["storage"], "storage");
  fields(storage, ["dataDir"], "storage", report);
  if (storage["dataDir"] !== undefined && typeof storage["dataDir"] !== "string") {
    throw new Error("storage.dataDir must be a string");
  }
  const components = componentSettings(raw["components"], report);
  return {
    ...plugins,
    ...(components.shellInjection === undefined
      ? {}
      : { shellInjection: components.shellInjection }),
    ...(components.outputStyle === undefined ? {} : { outputStyle: components.outputStyle }),
    ...(components.allowSystemReplacement === undefined
      ? {}
      : { allowSystemReplacement: components.allowSystemReplacement }),
    components: components.enabled,
    formats,
    ...(isStringArray(discovery["paths"]) ? { paths: discovery["paths"] } : {}),
    ...(typeof storage["dataDir"] === "string" ? { dataDir: storage["dataDir"] } : {}),
  };
};

export { groupedSettings as normaliseSettings };
