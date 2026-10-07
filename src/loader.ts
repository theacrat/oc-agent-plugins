import path from "node:path";

import { loadAgentPlugin } from "#src/agent-plugins-loader.ts";
import { listDir, realOrSelf, resolveWithin } from "#src/paths.ts";
import { FORMATS } from "#src/types.ts";
import type { AgentPlugin, Diagnostic, Format, LoadResult, Report } from "#src/types.ts";
import type { AppEndpoint } from "#src/vendor/bridges.ts";
import { codexCachePlugins } from "#src/vendor/codex-cache.ts";
import type { PluginConfigurationOptions } from "#src/vendor/configuration.ts";
import { hasVendorManifest, loadVendorPlugin } from "#src/vendor/loader.ts";
import {
  hasMarketplace as hasVendorMarketplace,
  readMarketplaces,
} from "#src/vendor/marketplace.ts";
import type { MarketplaceEntry } from "#src/vendor/marketplace.ts";
import type { VendorFormat } from "#src/vendor/placeholders.ts";

interface LoadOptions {
  readonly pluginAppEndpoints?: Readonly<Record<string, Readonly<Record<string, AppEndpoint>>>>;
  readonly configuration?: Readonly<Record<string, PluginConfigurationOptions>>;
  readonly trustedHooks?: readonly string[];
  readonly pluginSettings?: Readonly<Record<string, boolean>>;
  readonly appEndpoints?: Readonly<Record<string, AppEndpoint>>;
  readonly dataRoot: string;
  // Codex's versioned install cache; each newest version directory is loaded as a plugin root.
  readonly codexCache?: string;
  readonly platform?: NodeJS.Platform;
  readonly formats?: ReadonlySet<Format>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface PluginLoad {
  readonly plugin?: AgentPlugin;
  readonly diagnostics: readonly Diagnostic[];
}

// A directory to load, the format that claimed it, and any marketplace entry that pointed at it.
interface Candidate {
  readonly root: string;
  readonly format: Format;
  readonly entry?: MarketplaceEntry["entry"];
}

const ALL_FORMATS: ReadonlySet<Format> = new Set(FORMATS);

const safeVendorLoad = async (candidate: Candidate, options: LoadOptions, report: Report) => {
  if (candidate.format === "agent-plugins") {
    return;
  }
  try {
    return await loadVendorPlugin(
      candidate.root,
      candidate.format,
      {
        appEndpoints: options.appEndpoints ?? {},
        configuration: options.configuration ?? {},
        dataRoot: options.dataRoot,
        env: options.env ?? {},
        pluginAppEndpoints: options.pluginAppEndpoints ?? {},
        pluginSettings: options.pluginSettings ?? {},
        trustedHooks: options.trustedHooks ?? [],
        ...(candidate.entry === undefined ? {} : { entry: candidate.entry }),
      },
      report,
    );
  } catch {
    return;
  }
};

const loadCandidate = async (candidate: Candidate, options: LoadOptions): Promise<PluginLoad> => {
  if (candidate.format === "agent-plugins") {
    return loadAgentPlugin(candidate.root, options);
  }
  const diagnostics: { -readonly [Key in keyof Diagnostic]: Diagnostic[Key] }[] = [];
  const name = path.basename(candidate.root);
  const report: Report = (diagnostic) => {
    diagnostics.push({ ...diagnostic, source: `${name}/${diagnostic.source}` });
  };
  const loaded = await safeVendorLoad(candidate, options, report);
  if (loaded === undefined) {
    return {
      diagnostics: [
        ...diagnostics,
        {
          message:
            "plugin configuration or component validation failed; check declared values, required fields and secret body references",
          severity: "error",
          source: candidate.root,
        },
      ],
    };
  }
  if (!loaded.ok) {
    return {
      diagnostics: [
        {
          message: `${candidate.format} plugin rejected: ${loaded.error}`,
          severity: "error",
          source: candidate.root,
        },
      ],
    };
  }
  // Re-key diagnostics under the manifest name once it's known.
  const prefix = `${loaded.plugin.manifest.name}/`;
  for (const diagnostic of diagnostics) {
    diagnostic.source = diagnostic.source.replace(`${name}/`, prefix);
  }
  return { diagnostics, plugin: loaded.plugin };
};

const hasManifest = async (root: string, format: Format) => {
  if (format !== "agent-plugins") {
    return hasVendorManifest(root, format);
  }
  const resolved = await resolveWithin(root, path.join(root, "plugin.json"));
  return resolved.kind === "file";
};

// The first enabled format, in FORMATS order, with a manifest claims the directory.
const detectFormat = async (
  root: string,
  formats: ReadonlySet<Format>,
): Promise<Format | undefined> => {
  const enabled = FORMATS.filter((format) => formats.has(format));
  const found = await Promise.all(enabled.map(async (format) => hasManifest(root, format)));
  return enabled.find((_format, index) => found[index]);
};

const isDirectory = async (directory: string) => {
  const resolved = await resolveWithin(directory, directory);
  return resolved.kind === "directory";
};

const vendorFormats = (formats: ReadonlySet<Format>) =>
  new Set([...formats].filter((format): format is VendorFormat => format !== "agent-plugins"));

// A marketplace entry loads under the format of the marketplace that listed it, unless a
// higher-precedence manifest (for example root plugin.json) is present in the plugin itself.
const fromMarketplace = async (
  entry: MarketplaceEntry,
  formats: ReadonlySet<Format>,
): Promise<Candidate | undefined> => {
  if (!(await isDirectory(entry.root))) {
    return undefined;
  }
  const detected = await detectFormat(entry.root, formats);
  if (detected !== undefined && FORMATS.indexOf(detected) < FORMATS.indexOf(entry.format)) {
    return { format: detected, root: entry.root };
  }
  return { entry: entry.entry, format: detected ?? entry.format, root: entry.root };
};

// A search path is a plugin root, a marketplace, or a directory whose immediate children are either.
const expandSearchPath = async (
  searchPath: string,
  formats: ReadonlySet<Format>,
  report: Report,
): Promise<Candidate[]> => {
  if (!(await isDirectory(searchPath))) {
    return [];
  }
  const own = await detectFormat(searchPath, formats);
  // A plugin repo often ships a marketplace that only lists itself; reading it adds nothing but noise.
  const marketplace = await readMarketplaces(
    searchPath,
    vendorFormats(formats),
    report,
    own !== undefined,
  );
  const listed = await Promise.all(
    marketplace.map(async (entry) => fromMarketplace(entry, formats)),
  );
  const candidates = listed.filter((candidate) => candidate !== undefined);
  // A marketplace that lists itself (source "./") already produced the root candidate.
  if (own !== undefined && !candidates.some((candidate) => candidate.root === searchPath)) {
    candidates.unshift({ format: own, root: searchPath });
  }
  // A plugin root or a marketplace decides what the directory contains. Its children are only
  // scanned when it's neither, so entries a marketplace rejected can't come back as children.
  if (own !== undefined || (await hasVendorMarketplace(searchPath, vendorFormats(formats)))) {
    return candidates;
  }
  const listing = await listDir(searchPath);
  const names = listing.map((entry) => entry.name).toSorted();
  const children = await Promise.all(
    names.map(async (name) => {
      const child = path.join(searchPath, name);
      if (!(await isDirectory(child))) {
        return [];
      }
      const format = await detectFormat(child, formats);
      if (format !== undefined) {
        return [{ format, root: child }];
      }
      const entries = await readMarketplaces(child, vendorFormats(formats), report);
      const nested = await Promise.all(
        entries.map(async (entry) => fromMarketplace(entry, formats)),
      );
      return nested.filter((candidate) => candidate !== undefined);
    }),
  );
  return children.flat();
};

const loadPlugin = async (directory: string, options: LoadOptions): Promise<PluginLoad> => {
  const root = await realOrSelf(directory);
  const format = await detectFormat(root, options.formats ?? ALL_FORMATS);
  if (format === undefined) {
    return { diagnostics: [{ message: "plugin.json not found", severity: "error", source: root }] };
  }
  return loadCandidate({ format, root }, options);
};

// Every candidate directory from search paths and the Codex cache, deduplicated by real path.
const findCandidates = async (
  searchPaths: readonly string[],
  options: LoadOptions,
  report: Report,
): Promise<Candidate[]> => {
  const formats = options.formats ?? ALL_FORMATS;
  const cached =
    options.codexCache === undefined ? [] : await codexCachePlugins(options.codexCache);
  const expanded = await Promise.all([
    ...searchPaths.map(async (searchPath) =>
      expandSearchPath(path.resolve(searchPath), formats, report),
    ),
    ...cached.map(async (root): Promise<Candidate[]> => {
      const format = await detectFormat(root, formats);
      return format === undefined ? [] : [{ format, root }];
    }),
  ]);
  const all = expanded.flat();
  const reals = await Promise.all(all.map(async (candidate) => realOrSelf(candidate.root)));
  const unique = new Map<string, Candidate>();
  for (const [index, candidate] of all.entries()) {
    const real = reals[index] ?? candidate.root;
    if (!unique.has(real)) {
      unique.set(real, { ...candidate, root: real });
    }
  }
  return [...unique.values()];
};

const loadAll = async (
  searchPaths: readonly string[],
  options: LoadOptions,
): Promise<LoadResult> => {
  const diagnostics: Diagnostic[] = [];
  const report: Report = (diagnostic) => {
    diagnostics.push(diagnostic);
  };
  const candidates = await findCandidates(searchPaths, options, report);
  const loads = await Promise.all(
    candidates.map(async (candidate) => loadCandidate(candidate, options)),
  );
  // Plugin names must be unique; the first one found wins.
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
        message: `skipped ${candidates[index]?.root}; a plugin with this name was already loaded from ${existing.root}`,
        severity: "warning",
        source: plugin.manifest.name,
      });
    }
  }
  return { diagnostics, plugins: [...plugins.values()] };
};

export type { LoadOptions, PluginLoad };
export { loadAll, loadPlugin };
