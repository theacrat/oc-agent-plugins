import path from "node:path";

import { isWithin } from "#src/paths.ts";
import type { Report } from "#src/types.ts";

// Manifest component paths: a string or array of strings, `./`-relative and contained in the root.
// Cursor documents bare relative paths too, so those are accepted; `.` names the root (Claude skills).
const componentPaths = (value: unknown, root: string, field: string, report: Report): string[] => {
  const values = [value].flat();
  const resolved: string[] = [];
  for (const entry of values) {
    if (typeof entry !== "string" || entry.trim() === "") {
      report({
        message: `${field} entries must be non-empty strings`,
        severity: "error",
        source: `plugin.json#${field}`,
      });
      continue;
    }
    if (path.isAbsolute(entry) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(entry)) {
      report({
        message: `${field} path "${entry}" must be relative to the plugin root`,
        severity: "error",
        source: `plugin.json#${field}`,
      });
      continue;
    }
    const target = path.resolve(root, entry);
    if (!isWithin(root, target)) {
      report({
        message: `${field} path "${entry}" escapes the plugin root`,
        severity: "error",
        source: `plugin.json#${field}`,
      });
      continue;
    }
    resolved.push(target);
  }
  return resolved;
};

export { componentPaths };
