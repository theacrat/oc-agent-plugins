import path from "node:path";

import type { JsonRecord } from "#src/json.ts";
import { readText, resolveWithin } from "#src/paths.ts";
import type { AgentPlugin, Manifest, Report } from "#src/types.ts";
import { pluginActivation } from "#src/vendor/activation.ts";
import type { AppEndpoint } from "#src/vendor/bridges.ts";
import type { PluginConfigurationOptions } from "#src/vendor/configuration.ts";
import { loadVendorContents } from "#src/vendor/contents.ts";
import { SPECS } from "#src/vendor/formats.ts";
import type { FormatSpec } from "#src/vendor/formats.ts";
import { parseVendorManifest } from "#src/vendor/manifest.ts";
import type { VendorFormat } from "#src/vendor/placeholders.ts";

interface VendorLoadOptions {
  readonly pluginAppEndpoints?: Readonly<Record<string, Readonly<Record<string, AppEndpoint>>>>;
  readonly configuration?: Readonly<Record<string, PluginConfigurationOptions>>;
  readonly trustedHooks?: readonly string[];
  readonly pluginSettings?: Readonly<Record<string, boolean>>;
  readonly appEndpoints?: Readonly<Record<string, AppEndpoint>>;
  readonly dataRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  // A marketplace entry can stand in for (or add to) a missing manifest.
  readonly entry?: JsonRecord;
}

type VendorLoad =
  | { readonly ok: true; readonly plugin: AgentPlugin }
  | { readonly ok: false; readonly error: string };

const readManifest = async (
  root: string,
  spec: FormatSpec,
  entry: JsonRecord | undefined,
): Promise<{ manifest: Manifest; raw: JsonRecord } | string> => {
  const file = await resolveWithin(root, path.join(root, spec.manifest));
  if (file.kind === "file") {
    const read = await readText(file.path);
    if (!read.ok) {
      return read.error;
    }
    const parsed = parseVendorManifest(read.text, undefined);
    return parsed.ok
      ? { manifest: parsed.manifest, raw: { ...entry, ...parsed.raw } }
      : parsed.error;
  }
  if (file.kind === "outside") {
    return `${spec.manifest} resolves outside the plugin root`;
  }
  if (!spec.manifestOptional) {
    return `${spec.manifest} not found`;
  }
  // Claude Code loads a plugin without a manifest, named by its marketplace entry or directory.
  const parsed = parseVendorManifest(JSON.stringify(entry ?? {}), path.basename(root));
  return parsed.ok ? { manifest: parsed.manifest, raw: parsed.raw } : parsed.error;
};

const loadVendorPlugin = async (
  root: string,
  format: VendorFormat,
  options: VendorLoadOptions,
  report: Report,
): Promise<VendorLoad> => {
  const spec = SPECS[format];
  const read = await readManifest(root, spec, options.entry);
  if (typeof read === "string") {
    return { error: read, ok: false };
  }
  const { manifest, raw } = read;
  const activation = pluginActivation(manifest.name, raw, options.pluginSettings ?? {}, report);
  if (!activation.enabled) {
    report({
      message: activation.reason ?? "plugin disabled",
      severity: "warning",
      source: "activation",
    });
    return {
      ok: true,
      plugin: {
        agents: [],
        commands: [],
        dataDir: path.join(options.dataRoot, manifest.name),
        format,
        manifest,
        root,
        rules: [],
        servers: {},
        skills: [],
      },
    };
  }
  return loadVendorContents(root, format, manifest, raw, options, report);
};

const hasVendorManifest = async (root: string, format: VendorFormat) => {
  const resolved = await resolveWithin(root, path.join(root, SPECS[format].manifest));
  return resolved.kind === "file";
};

export type { VendorLoad, VendorLoadOptions };
export { hasVendorManifest, loadVendorPlugin };
