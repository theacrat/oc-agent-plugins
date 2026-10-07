import path from "node:path";

import { isRecord } from "#src/json.ts";
import { readText, resolveWithin } from "#src/paths.ts";
import type { Format } from "#src/types.ts";
import type { HookLoadOptions, PluginHook } from "#src/vendor/hook-contract.ts";
import { parseHooks } from "#src/vendor/hook-parser.ts";
import { componentPaths } from "#src/vendor/paths.ts";

const loadHookFile = async (
  root: string,
  format: PluginHook["format"],
  target: string,
  optional: boolean,
  seen: Set<string>,
  options: HookLoadOptions,
): Promise<PluginHook[]> => {
  const resolved = await resolveWithin(root, target);
  if (resolved.kind === "missing" && optional) {
    return [];
  }
  if (resolved.kind !== "file") {
    options.report({
      message: "hook file missing, not a file, or symlink escapes plugin root",
      severity: "error",
      source: target,
    });
    return [];
  }
  if (seen.has(resolved.path)) {
    return [];
  }
  seen.add(resolved.path);
  const text = await readText(resolved.path);
  if (!text.ok) {
    options.report({ message: "cannot read hooks file", severity: "error", source: target });
    return [];
  }
  try {
    return parseHooks(
      root,
      format,
      JSON.parse(text.text) as unknown,
      path.relative(root, target),
      options,
    );
  } catch {
    options.report({ message: "invalid hooks JSON", severity: "error", source: target });
  }
  return [];
};
const loadHooks = async (
  root: string,
  format: Format,
  manifestRaw: Record<string, unknown>,
  options: HookLoadOptions,
): Promise<PluginHook[]> => {
  if (format === "agent-plugins") {
    if (manifestRaw["hooks"] !== undefined) {
      options.report({
        message: "agent-plugins does not define a vendor hooks contract",
        severity: "error",
        source: root,
      });
    }
    return [];
  }
  const declared = manifestRaw["hooks"];
  // Claude adds declared sources to the fixed file; Codex/Cursor declarations replace it.
  const sources: unknown[] = [
    ...(declared === undefined || format === "claude" ? ["./hooks/hooks.json"] : []),
    ...(declared === undefined ? [] : [declared].flat()),
  ];
  const result: PluginHook[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (isRecord(source)) {
      result.push(...parseHooks(root, format, source, `${root}/plugin.json#hooks`, options));
      continue;
    }
    for (const target of componentPaths(source, root, "hooks", options.report)) {
      result.push(
        // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve source precedence and symlink deduplication.
        ...(await loadHookFile(root, format, target, declared === undefined, seen, options)),
      );
    }
  }
  return result;
};

export type { HookLoadOptions, HookPhase, PluginHook } from "#src/vendor/hook-contract.ts";
export { hookMatcher } from "#src/vendor/hook-contract.ts";
export { parseHooks } from "#src/vendor/hook-parser.ts";
export { loadHooks };
