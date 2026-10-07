import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { parseManifest } from "@/manifest.ts";
import { discoverServers } from "@/mcp.ts";
import { resolveWithin } from "@/paths.ts";
import { discoverSkills } from "@/skills.ts";
import type { AgentPlugin, Diagnostic, LoadResult } from "@/types.ts";

interface LoadOptions {
  readonly dataRoot: string;
  readonly platform?: NodeJS.Platform;
}

interface PluginLoad {
  readonly plugin?: AgentPlugin;
  readonly diagnostics: readonly Diagnostic[];
}

const loadPlugin = async (directory: string, options: LoadOptions): Promise<PluginLoad> => {
  const root = await realpath(directory);
  const manifestFile = await resolveWithin(root, path.join(root, "plugin.json"));
  if (manifestFile.kind !== "file") {
    const message =
      manifestFile.kind === "missing"
        ? "plugin.json not found"
        : "plugin.json does not resolve to a file inside the plugin root";
    return { diagnostics: [{ message, severity: "error", source: root }] };
  }
  const result = parseManifest(await readFile(manifestFile.path, "utf8"));
  if (!result.ok) {
    return {
      diagnostics: [
        { message: `plugin rejected: ${result.error}`, severity: "error", source: root },
      ],
    };
  }
  const { manifest } = result;
  const diagnostics: Diagnostic[] = result.warnings.map((message) => ({
    message,
    severity: "warning",
    source: manifest.name,
  }));
  const report = (diagnostic: Diagnostic) => {
    diagnostics.push({ ...diagnostic, source: `${manifest.name}/${diagnostic.source}` });
  };

  const dataDir = path.join(options.dataRoot, manifest.name);
  const ctx = { dataDir, platform: options.platform ?? process.platform, root };
  const [skills, servers] = await Promise.all([
    discoverSkills(root, report),
    discoverServers(ctx, report),
  ]);
  if (Object.values(servers).some((server) => server.type === "stdio")) {
    await mkdir(dataDir, { recursive: true });
  }
  return { diagnostics, plugin: { dataDir, manifest, root, servers, skills } };
};

const hasManifest = async (directory: string) => {
  try {
    const names = await readdir(directory);
    return names.includes("plugin.json");
  } catch {
    return false;
  }
};

// A search path is either a plugin root or a directory whose immediate children are plugin roots.
const expandSearchPath = async (searchPath: string): Promise<string[]> => {
  if (await hasManifest(searchPath)) {
    return [searchPath];
  }
  let names: string[];
  try {
    names = await readdir(searchPath);
  } catch {
    return [];
  }
  const children = names.toSorted().map((name) => path.join(searchPath, name));
  const flags = await Promise.all(children.map(async (child) => hasManifest(child)));
  return children.filter((_child, index) => flags[index]);
};

const loadAll = async (
  searchPaths: readonly string[],
  options: LoadOptions,
): Promise<LoadResult> => {
  const expanded = await Promise.all(
    searchPaths.map(async (searchPath) => expandSearchPath(path.resolve(searchPath))),
  );
  const roots = [
    ...new Set(await Promise.all(expanded.flat().map(async (root) => realpath(root)))),
  ];
  const loads = await Promise.all(roots.map(async (root) => loadPlugin(root, options)));

  const diagnostics: Diagnostic[] = [];
  const plugins = new Map<string, AgentPlugin>();
  for (const [index, loaded] of loads.entries()) {
    diagnostics.push(...loaded.diagnostics);
    const { plugin } = loaded;
    if (plugin === undefined) {
      continue;
    }
    const existing = plugins.get(plugin.manifest.name);
    if (existing === undefined) {
      plugins.set(plugin.manifest.name, plugin);
    } else {
      diagnostics.push({
        message: `skipped ${roots[index]}; a plugin with this name was already loaded from ${existing.root}`,
        severity: "warning",
        source: plugin.manifest.name,
      });
    }
  }
  return { diagnostics, plugins: [...plugins.values()] };
};

export type { LoadOptions };
export { loadAll, loadPlugin };
