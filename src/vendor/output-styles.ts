import path from "node:path";

import { optionalString, parseFrontmatter } from "#src/frontmatter.ts";
import { readText } from "#src/paths.ts";
import type { Report } from "#src/types.ts";
import { findAll } from "#src/vendor/markdown.ts";
import { componentPaths } from "#src/vendor/paths.ts";
import type { Placeholders } from "#src/vendor/placeholders.ts";

interface PluginOutputStyle {
  readonly name: string;
  readonly path: string;
  readonly description?: string;
  readonly content: string;
  readonly keepCodingInstructions: boolean;
  readonly forceForPlugin: boolean;
}

const loadOutputStyles = async (
  root: string,
  declared: unknown,
  report: Report,
  expand?: Placeholders["expandContent"],
): Promise<PluginOutputStyle[]> => {
  const targets =
    declared === undefined
      ? [path.join(root, "output-styles")]
      : componentPaths(declared, root, "outputStyles", report);
  const files = await findAll(root, targets, [".md"], report);
  const reads = await Promise.all(files.map(async (file) => readText(file.path)));
  const found: PluginOutputStyle[] = [];
  for (const [index, file] of files.entries()) {
    const read = reads[index];
    if (read === undefined) {
      continue;
    }
    const parsed = read.ok ? parseFrontmatter(read.text, false) : read;
    if (!parsed.ok) {
      report({
        message: "output style could not be parsed",
        severity: "error",
        source: path.relative(root, file.path),
      });
      continue;
    }
    for (const flag of ["keep-coding-instructions", "force-for-plugin"]) {
      if (parsed.data[flag] !== undefined && typeof parsed.data[flag] !== "boolean") {
        throw new Error("Output style flags must be booleans");
      }
    }
    const description = optionalString(parsed.data["description"]);
    if (parsed.body === "") {
      continue;
    }
    found.push({
      content: expand?.(parsed.body) ?? parsed.body,
      forceForPlugin: parsed.data["force-for-plugin"] === true,
      keepCodingInstructions: parsed.data["keep-coding-instructions"] === true,
      name: optionalString(parsed.data["name"]) ?? file.name,
      path: file.path,
      ...(description === undefined ? {} : { description }),
    });
  }
  return [...new Map(found.map((style) => [style.name, style])).values()];
};

export type { PluginOutputStyle };
export { loadOutputStyles };
