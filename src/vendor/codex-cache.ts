import path from "node:path";

import { listDir } from "#src/paths.ts";

// Codex installs into cache/<marketplace>/<plugin>/<version>/. Use `latest` when Codex has
// pointed it somewhere, otherwise the highest semver-ish version directory. Directories that
// don't start with a number (for example `local`) sort below every version, and a release sorts
// above its own prereleases.
const VERSION = /^v?(?<core>\d+(?:\.\d+)*)(?<pre>-[^+]*)?/u;

const compareVersions = (left: string, right: string) => {
  const lhs = VERSION.exec(left)?.groups;
  const rhs = VERSION.exec(right)?.groups;
  if (lhs?.["core"] === undefined || rhs?.["core"] === undefined) {
    return Number(lhs?.["core"] !== undefined) - Number(rhs?.["core"] !== undefined);
  }
  const core = lhs["core"].localeCompare(rhs["core"], undefined, { numeric: true });
  if (core !== 0) {
    return core;
  }
  if (lhs["pre"] === undefined || rhs["pre"] === undefined) {
    return Number(lhs["pre"] === undefined) - Number(rhs["pre"] === undefined);
  }
  return lhs["pre"].localeCompare(rhs["pre"], undefined, { numeric: true });
};

const listDirectories = async (directory: string): Promise<string[]> => {
  const entries = await listDir(directory);
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name);
};

const newestVersion = async (pluginDir: string): Promise<string | undefined> => {
  const versions = await listDirectories(pluginDir);
  if (versions.includes("latest")) {
    return path.join(pluginDir, "latest");
  }
  const [newest] = versions.toSorted(compareVersions).toReversed();
  return newest === undefined ? undefined : path.join(pluginDir, newest);
};

const codexCachePlugins = async (cacheDir: string): Promise<string[]> => {
  const marketplaces = await listDirectories(cacheDir);
  const plugins = await Promise.all(
    marketplaces.toSorted().map(async (marketplace) => {
      const names = await listDirectories(path.join(cacheDir, marketplace));
      const roots = await Promise.all(
        names.toSorted().map(async (name) => newestVersion(path.join(cacheDir, marketplace, name))),
      );
      return roots.filter((root) => root !== undefined);
    }),
  );
  return plugins.flat();
};

export { codexCachePlugins, compareVersions };
