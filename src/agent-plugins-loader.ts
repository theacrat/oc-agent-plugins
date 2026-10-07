import path from "node:path";

import type { LoadOptions, PluginLoad } from "#src/loader.ts";
import { parseManifest } from "#src/manifest.ts";
import { discoverServers } from "#src/mcp.ts";
import { ensureDir, readText, resolveWithin } from "#src/paths.ts";
import { discoverSkills } from "#src/skills.ts";
import type { AgentPlugin, Diagnostic, PluginServer, Report } from "#src/types.ts";
import { COMPONENTS } from "#src/types.ts";

const manifestWarnings = (warnings: readonly string[], source: string): Diagnostic[] =>
  warnings.map((message) => ({ message, severity: "warning", source }));

const disabledPlugin = (name: string): PluginLoad => ({
  diagnostics: [{ message: "disabled by pluginSettings", severity: "warning", source: name }],
});

const discoverComponents = async (
  root: string,
  name: string,
  options: LoadOptions,
  report: Report,
) => {
  const dataDir = path.join(options.dataRoot, name);
  const ctx = { dataDir, platform: options.platform ?? process.platform, root };
  const components =
    typeof options.components === "function"
      ? options.components(name)
      : (options.components ?? new Set(COMPONENTS));
  const emptyServers: Record<string, PluginServer> = {};
  const [skills, servers] = await Promise.all([
    components.has("skills") ? discoverSkills(root, report) : [],
    components.has("mcp") ? discoverServers(ctx, report) : emptyServers,
  ]);
  if (Object.values(servers).some((server) => server.type === "stdio")) {
    const error = await ensureDir(dataDir);
    if (error !== undefined) {
      report({ message: error, severity: "error", source: "mcp.json" });
    }
  }
  return { dataDir, servers, skills };
};

const loadAgentPlugin = async (root: string, options: LoadOptions): Promise<PluginLoad> => {
  const manifestFile = await resolveWithin(root, path.join(root, "plugin.json"));
  const reject = (message: string): PluginLoad => ({
    diagnostics: [{ message, severity: "error", source: root }],
  });
  if (manifestFile.kind !== "file") {
    return reject(
      manifestFile.kind === "missing"
        ? "plugin.json not found"
        : "plugin.json does not resolve to a file inside the plugin root",
    );
  }
  const read = await readText(manifestFile.path);
  const result = read.ok ? parseManifest(read.text) : read;
  if (!result.ok) {
    return reject(`plugin rejected: ${result.error}`);
  }
  const { manifest } = result;
  if (options.pluginSettings?.[manifest.name] === false) {
    return disabledPlugin(manifest.name);
  }
  const diagnostics: Diagnostic[] = manifestWarnings(result.warnings, manifest.name);
  const report: Report = (diagnostic) => {
    diagnostics.push({ ...diagnostic, source: `${manifest.name}/${diagnostic.source}` });
  };

  const { dataDir, servers, skills } = await discoverComponents(
    root,
    manifest.name,
    options,
    report,
  );
  const plugin: AgentPlugin = {
    agents: [],
    commands: [],
    dataDir,
    format: "agent-plugins",
    manifest,
    root,
    rules: [],
    servers,
    skills,
  };
  return { diagnostics, plugin };
};

export { loadAgentPlugin };
