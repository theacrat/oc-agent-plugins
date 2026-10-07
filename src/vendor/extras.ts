import type { JsonRecord } from "#src/json.ts";
import { COMPONENTS } from "#src/types.ts";
import type { Component, Report } from "#src/types.ts";
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
  components: ReadonlySet<Component> = new Set(COMPONENTS),
) => {
  const [hooks, lsp, styles, runtimes] = await Promise.all([
    components.has("hooks") ? loadHooks(root, format, raw, { enabled: trusted, report }) : [],
    format === "claude" && components.has("lsp") ? loadLsp(root, raw["lspServers"], report) : {},
    format === "claude" && components.has("styles")
      ? loadOutputStyles(root, raw["outputStyles"], report, placeholders.expandContent)
      : Promise.resolve([]),
    loadRuntimeComponents(root, raw, report, components),
  ]);
  return { hooks, lsp: expandLsp(lsp, placeholders.expand), runtimes, styles };
};

export { loadExtras };
