import type { JsonRecord } from "#src/json.ts";
import type { Report } from "#src/types.ts";
import { loadHooks } from "#src/vendor/hooks.ts";
import { expandLsp, loadLsp } from "#src/vendor/lsp.ts";
import { loadOutputStyles } from "#src/vendor/output-styles.ts";
import type { Placeholders, VendorFormat } from "#src/vendor/placeholders.ts";
import { loadRuntimeComponents } from "#src/vendor/runtimes.ts";

const loadExtras = async (
  root: string,
  format: VendorFormat,
  raw: JsonRecord,
  placeholders: Placeholders,
  trusted: boolean,
  report: Report,
) => {
  const [hooks, lsp, styles, runtimes] = await Promise.all([
    loadHooks(root, format, raw, { enabled: trusted, report }),
    format === "claude" ? loadLsp(root, raw["lspServers"], report) : Promise.resolve({}),
    format === "claude"
      ? loadOutputStyles(root, raw["outputStyles"], report, placeholders.expandContent)
      : Promise.resolve([]),
    loadRuntimeComponents(root, raw, report),
  ]);
  return { hooks, lsp: expandLsp(lsp, placeholders.expand), runtimes, styles };
};

export { loadExtras };
