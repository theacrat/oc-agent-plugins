import path from "node:path";

import { isRecord, parseJson } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import { readText, resolveWithin } from "#src/paths.ts";
import type { Report } from "#src/types.ts";
import type { VendorFormat } from "#src/vendor/placeholders.ts";

interface MarketplaceEntry {
  readonly format: VendorFormat;
  readonly root: string;
  readonly entry: JsonRecord;
}

// Marketplace files list plugins by `source`. Only local sources are followed; installing is the host's job.
const MARKETPLACES: readonly { readonly format: VendorFormat; readonly file: string }[] = [
  { file: ".claude-plugin/marketplace.json", format: "claude" },
  { file: ".cursor-plugin/marketplace.json", format: "cursor" },
  { file: ".agents/plugins/marketplace.json", format: "codex" },
];

const localSource = (source: unknown): string | undefined => {
  if (typeof source === "string") {
    return source;
  }
  if (isRecord(source) && source["source"] === "local" && typeof source["path"] === "string") {
    return source["path"];
  }
  return undefined;
};

// Local entries become plugin roots; git, url and npm entries are only counted. A local source must
// resolve, after following symlinks, to a directory inside the marketplace.
const splitEntries = async (
  doc: JsonRecord,
  directory: string,
  format: VendorFormat,
  problem: (message: string) => void,
): Promise<{ entries: MarketplaceEntry[]; remote: number }> => {
  const metadata = isRecord(doc["metadata"]) ? doc["metadata"] : {};
  const pluginRoot = typeof metadata["pluginRoot"] === "string" ? metadata["pluginRoot"] : ".";
  const plugins = Array.isArray(doc["plugins"]) ? doc["plugins"].filter(isRecord) : [];
  const local = plugins.flatMap((entry) => {
    const source = localSource(entry["source"]);
    return source === undefined ? [] : [{ entry, source }];
  });
  const resolved = await Promise.all(
    local.map(async ({ source }) =>
      resolveWithin(directory, path.resolve(directory, pluginRoot, source)),
    ),
  );
  const entries: MarketplaceEntry[] = [];
  for (const [index, { entry, source }] of local.entries()) {
    const target = resolved[index];
    if (target?.kind === "directory") {
      entries.push({ entry, format, root: target.path });
    } else {
      problem(
        target?.kind === "outside"
          ? `plugin source "${source}" escapes the marketplace; skipped`
          : `plugin source "${source}" is not a directory; skipped`,
      );
    }
  }
  return { entries, remote: plugins.length - local.length };
};

const readMarketplace = async (
  directory: string,
  format: VendorFormat,
  file: string,
  report: Report,
  quiet: boolean,
): Promise<MarketplaceEntry[]> => {
  const resolved = await resolveWithin(directory, path.join(directory, file));
  if (resolved.kind !== "file") {
    return [];
  }
  const read = await readText(resolved.path);
  const parsed = read.ok ? parseJson(read.text) : read;
  const doc = parsed.ok ? parsed.value : undefined;
  if (!isRecord(doc) || !Array.isArray(doc["plugins"])) {
    report({
      message: "marketplace must have a plugins array; skipped",
      severity: "error",
      source: resolved.path,
    });
    return [];
  }
  const { entries, remote } = await splitEntries(doc, directory, format, (message) => {
    report({ message, severity: "error", source: resolved.path });
  });
  if (remote > 0 && !quiet) {
    report({
      message: `${remote} plugin(s) with git, url or npm sources aren't installed here; install them with ${format === "codex" ? "Codex" : "their host"} first`,
      severity: "warning",
      source: resolved.path,
    });
  }
  return entries;
};

// `quiet` drops the remote-source warning, for repos that are a plugin and also ship a catalog of themselves.
const readMarketplaces = async (
  directory: string,
  enabled: ReadonlySet<VendorFormat>,
  report: Report,
  quiet = false,
): Promise<MarketplaceEntry[]> => {
  const found = await Promise.all(
    MARKETPLACES.filter(({ format }) => enabled.has(format)).map(async ({ file, format }) =>
      readMarketplace(directory, format, file, report, quiet),
    ),
  );
  return found.flat();
};

const hasMarketplace = async (directory: string, enabled: ReadonlySet<VendorFormat>) => {
  const found = await Promise.all(
    MARKETPLACES.filter(({ format }) => enabled.has(format)).map(async ({ file }) => {
      const resolved = await resolveWithin(directory, path.join(directory, file));
      return resolved.kind === "file";
    }),
  );
  return found.includes(true);
};

export type { MarketplaceEntry };
export { hasMarketplace, readMarketplaces };
