import path from "node:path";

import type { JsonRecord } from "#src/json.ts";
import type { AgentPlugin, Manifest, Report } from "#src/types.ts";
import { COMPONENTS } from "#src/types.ts";
import { loadAppMappings } from "#src/vendor/bridges.ts";
import { loadAgents, loadCommands, loadRules, loadSkills } from "#src/vendor/components.ts";
import { resolveConfiguration } from "#src/vendor/configuration.ts";
import { loadExtras } from "#src/vendor/extras.ts";
import { SPECS } from "#src/vendor/formats.ts";
import type { FormatSpec } from "#src/vendor/formats.ts";
import type { VendorLoadOptions, VendorLoad } from "#src/vendor/loader.ts";
import { discoverVendorServers } from "#src/vendor/mcp.ts";
import { assertModelSafety } from "#src/vendor/model-safety.ts";
import type { VendorFormat } from "#src/vendor/placeholders.ts";
import { placeholdersFor } from "#src/vendor/placeholders.ts";

const serverSources = (raw: JsonRecord, apps: JsonRecord, spec: FormatSpec) => ({
  declared:
    Object.keys(apps).length === 0
      ? raw["mcpServers"]
      : [raw["mcpServers"], apps].filter((entry) => entry !== undefined),
  declaredReplacesDefaults: spec.mcpDeclaredReplaces,
  defaults: spec.mcpDefaults,
});

const selectedServers = async (
  raw: JsonRecord,
  apps: JsonRecord,
  spec: FormatSpec,
  context: Parameters<typeof discoverVendorServers>[1],
  report: Report,
) => discoverVendorServers(serverSources(raw, apps, spec), context, report);

const appEndpointsFor = (options: VendorLoadOptions, name: string) =>
  options.pluginAppEndpoints?.[name] ?? options.appEndpoints ?? {};

const sanitisedReport =
  (report: Report, redact: (text: string) => string): Report =>
  (diagnostic) => {
    report({
      ...diagnostic,
      message: redact(diagnostic.message),
      source: redact(diagnostic.source),
    });
  };

const configurationFor = (
  format: VendorFormat,
  raw: JsonRecord,
  options: VendorLoadOptions,
  name: string,
) =>
  resolveConfiguration({
    env: options.env,
    format,
    manifest: raw,
    ...(options.configuration?.[name] === undefined
      ? {}
      : { options: options.configuration[name] }),
  });

interface PluginLoadContext {
  readonly root: string;
  readonly format: VendorFormat;
  readonly manifest: Manifest;
  readonly raw: JsonRecord;
  readonly options: VendorLoadOptions;
  readonly report: Report;
  readonly configuration: NonNullable<AgentPlugin["configuration"]>;
}

const loadingContext = async (context: PluginLoadContext) => {
  const { root, format, manifest, raw, options, report, configuration } = context;
  const spec = SPECS[format];
  const components =
    typeof options.components === "function"
      ? options.components(manifest.name)
      : (options.components ?? new Set(COMPONENTS));
  const dataDir = path.join(options.dataRoot, manifest.name);
  const settings = options.configuration?.[manifest.name];
  const placeholders = placeholdersFor(format, { configuration, dataDir, env: options.env, root });
  const endpoints = appEndpointsFor(options, manifest.name);
  const apps = components.has("mcp")
    ? await loadAppMappings(root, raw["apps"], endpoints, report)
    : {};
  const extras = loadExtras(
    root,
    format,
    raw,
    placeholders,
    options.trustedHooks?.includes(manifest.name) === true,
    report,
    components,
  );
  return { apps, components, configuration, dataDir, extras, placeholders, settings, spec };
};

const loadSelectedContents = async (context: PluginLoadContext): Promise<AgentPlugin> => {
  const { root, format, manifest, raw, report } = context;
  const {
    apps,
    components,
    configuration,
    dataDir,
    extras: pendingExtras,
    placeholders,
    settings,
    spec,
  } = await loadingContext(context);
  // Claude Code substitutes plugin paths in skill and command bodies; Codex and Cursor don't.
  const [skills, servers, commands, rules, agents, extras] = await Promise.all([
    components.has("skills") ? loadSkills(root, spec, raw, placeholders.expandContent, report) : [],
    components.has("mcp")
      ? selectedServers(raw, apps, spec, { dataDir, placeholders, root }, report)
      : {},
    components.has("commands")
      ? loadCommands(root, spec, raw, placeholders.expandContent, report)
      : [],
    components.has("rules") ? loadRules(root, spec, raw, report) : [],
    components.has("agents")
      ? loadAgents(
          root,
          spec,
          raw,
          placeholders.expandContent,
          report,
          settings?.modelAliases ?? {},
        )
      : [],
    pendingExtras,
  ]);
  return {
    agents,
    commands,
    configuration,
    dataDir,
    ...extras,
    format,
    manifest,
    root,
    rules,
    servers,
    skills,
  };
};

const loadVendorContents = async (
  root: string,
  format: VendorFormat,
  manifest: Manifest,
  raw: JsonRecord,
  options: VendorLoadOptions,
  unsafeReport: Report,
): Promise<VendorLoad> => {
  const configuration = configurationFor(format, raw, options, manifest.name);
  const report = sanitisedReport(unsafeReport, configuration.redact);
  const plugin = await loadSelectedContents({
    configuration,
    format,
    manifest,
    options,
    raw,
    report,
    root,
  });
  assertModelSafety(plugin);
  return { ok: true, plugin };
};

export { loadVendorContents };
