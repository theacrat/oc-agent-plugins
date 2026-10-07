import path from "node:path";

import type { JsonRecord } from "#src/json.ts";
import type { Manifest, Report } from "#src/types.ts";
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

const loadVendorContents = async (
  root: string,
  format: VendorFormat,
  manifest: Manifest,
  raw: JsonRecord,
  options: VendorLoadOptions,
  unsafeReport: Report,
): Promise<VendorLoad> => {
  const spec = SPECS[format];
  const dataDir = path.join(options.dataRoot, manifest.name);
  const settings = options.configuration?.[manifest.name];
  const configuration = configurationFor(format, raw, options, manifest.name);
  const report = sanitisedReport(unsafeReport, configuration.redact);
  const placeholders = placeholdersFor(format, { configuration, dataDir, env: options.env, root });
  const endpoints = appEndpointsFor(options, manifest.name);
  const apps = await loadAppMappings(root, raw["apps"], endpoints, report);
  // Claude Code substitutes plugin paths in skill and command bodies; Codex and Cursor don't.
  const [skills, servers, commands, rules, agents, extras] = await Promise.all([
    loadSkills(root, spec, raw, placeholders.expandContent, report),
    discoverVendorServers(serverSources(raw, apps, spec), { dataDir, placeholders, root }, report),
    loadCommands(root, spec, raw, placeholders.expandContent, report),
    loadRules(root, spec, raw, report),
    loadAgents(root, spec, raw, placeholders.expandContent, report, settings?.modelAliases ?? {}),
    loadExtras(
      root,
      format,
      raw,
      placeholders,
      options.trustedHooks?.includes(manifest.name) === true,
      report,
    ),
  ]);
  const plugin = {
    agents,
    commands,
    configuration,
    dataDir,
    format,
    ...extras,
    manifest,
    root,
    rules,
    servers,
    skills,
  };
  assertModelSafety(plugin);
  return { ok: true, plugin };
};

export { loadVendorContents };
