import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { readRegularFile } from "#src/manager/snapshot.ts";
import type { PluginMetadata } from "#src/manager/types.ts";
import { parseManifest } from "#src/manifest.ts";
import { FORMATS } from "#src/types.ts";
import { parseVendorManifest } from "#src/vendor/manifest.ts";

const readMetadata = async (directory: string): Promise<PluginMetadata> => {
  const root = await realpath(directory);
  const detect = async (index: number): Promise<PluginMetadata> => {
    const format = FORMATS[index];
    if (format === undefined) {
      throw new Error(`No supported root plugin manifest found in ${directory}`);
    }
    const parent = format === "agent-plugins" ? root : path.join(root, `.${format}-plugin`);
    try {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || (await realpath(parent)) !== parent) {
        throw new Error(`Unsafe manifest directory: ${parent}`);
      }
      const content = await readRegularFile(path.join(parent, "plugin.json"));
      const text = content.toString("utf8");
      const parsed =
        format === "agent-plugins" ? parseManifest(text) : parseVendorManifest(text, undefined);
      if (!parsed.ok) {
        throw new Error(`Invalid ${format} manifest: ${parsed.error}`);
      }
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u.test(parsed.manifest.name)) {
        throw new Error(
          "Plugin name must be a safe 1-64 character disk segment, ending alphanumeric",
        );
      }
      return { format, manifest: parsed.manifest };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    return detect(index + 1);
  };
  return detect(0);
};

export { readMetadata };
