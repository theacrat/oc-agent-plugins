import path from "node:path";

import type { JsonRecord } from "#src/json.ts";
import { ensureDir, readText, resolveWithin } from "#src/paths.ts";
import type { AgentPlugin, Manifest, Report } from "#src/types.ts";
import { loadCommands, loadRules, loadSkills } from "#src/vendor/components.ts";
import { SPECS } from "#src/vendor/formats.ts";
import type { FormatSpec } from "#src/vendor/formats.ts";
import { parseVendorManifest } from "#src/vendor/manifest.ts";
import { discoverVendorServers } from "#src/vendor/mcp.ts";
import { placeholdersFor } from "#src/vendor/placeholders.ts";
import type { VendorFormat } from "#src/vendor/placeholders.ts";

interface VendorLoadOptions {
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

const reportUnsupported = async (
  root: string,
  spec: FormatSpec,
  raw: JsonRecord,
  report: Report,
) => {
  const fields = spec.unsupported.filter((field) => raw[field] !== undefined);
  const dirs = await Promise.all(
    spec.unsupportedDirs.map(async (dir) => {
      const resolved = await resolveWithin(root, path.join(root, dir));
      return resolved.kind === "missing" ? undefined : `${dir}/`;
    }),
  );
  const missing = [...new Set([...fields, ...dirs.filter((dir) => dir !== undefined)])];
  if (missing.length > 0) {
    report({
      message: `not supported in OpenCode and ignored: ${missing.join(", ")}`,
      severity: "warning",
      source: spec.manifest,
    });
  }
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
  const dataDir = path.join(options.dataRoot, manifest.name);
  const placeholders = placeholdersFor(format, { dataDir, env: options.env, root });
  // Claude Code substitutes plugin paths in skill and command bodies; Codex and Cursor don't.
  const expandBody = format === "claude" ? placeholders.expandContent : undefined;
  const [skills, servers, commands, rules] = await Promise.all([
    loadSkills(root, spec, raw, expandBody, report),
    discoverVendorServers(
      {
        declared: raw["mcpServers"],
        declaredReplacesDefaults: spec.mcpDeclaredReplaces,
        defaults: spec.mcpDefaults,
      },
      { dataDir, placeholders, root },
      report,
    ),
    loadCommands(root, spec, raw, expandBody, report),
    loadRules(root, spec, raw, report),
    reportUnsupported(root, spec, raw, report),
  ]);
  if (Object.values(servers).some((server) => server.type === "stdio")) {
    const error = await ensureDir(dataDir);
    if (error !== undefined) {
      report({ message: error, severity: "error", source: spec.manifest });
    }
  }
  return {
    ok: true,
    plugin: { commands, dataDir, format, manifest, root, rules, servers, skills },
  };
};

const hasVendorManifest = async (root: string, format: VendorFormat) => {
  const resolved = await resolveWithin(root, path.join(root, SPECS[format].manifest));
  return resolved.kind === "file";
};

export type { VendorLoad, VendorLoadOptions };
export { hasVendorManifest, loadVendorPlugin };
