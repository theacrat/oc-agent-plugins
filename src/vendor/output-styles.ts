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

const parseStyle = (
  text: string,
  file: { readonly path: string; readonly name: string },
  reportError: (message: string) => void,
  expand?: Placeholders["expandContent"],
): PluginOutputStyle | undefined => {
  const parsed = parseFrontmatter(text, false);
  if (!parsed.ok) {
    reportError("output style could not be parsed");
    return;
  }
  const invalidFlag = ["keep-coding-instructions", "force-for-plugin"].find(
    (flag) => parsed.data[flag] !== undefined && typeof parsed.data[flag] !== "boolean",
  );
  if (invalidFlag !== undefined) {
    reportError(`output style ${invalidFlag} must be a boolean`);
    return;
  }
  if (parsed.body === "") {
    return;
  }
  let content: string;
  try {
    content = expand?.(parsed.body) ?? parsed.body;
  } catch {
    reportError("output style body configuration expansion failed");
    return;
  }
  const description = optionalString(parsed.data["description"]);
  return {
    content,
    forceForPlugin: parsed.data["force-for-plugin"] === true,
    keepCodingInstructions: parsed.data["keep-coding-instructions"] === true,
    name: optionalString(parsed.data["name"]) ?? file.name,
    path: file.path,
    ...(description === undefined ? {} : { description }),
  };
};

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
    const reportError = (message: string) => {
      report({
        message,
        severity: "error",
        source: path.relative(root, file.path),
      });
    };
    if (!read.ok) {
      reportError("output style could not be parsed");
      continue;
    }
    const style = parseStyle(read.text, file, reportError, expand);
    if (style !== undefined) {
      found.push(style);
    }
  }
  return [...new Map(found.map((style) => [style.name, style])).values()];
};

export type { PluginOutputStyle };
export { loadOutputStyles };
