import { parseDocument } from "yaml";

import { isRecord, isStringArray } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import type { Report } from "#src/types.ts";
import { loadRuntimeFiles } from "#src/vendor/runtime-files.ts";

interface PluginWorkflow {
  readonly name: string;
  readonly description: string;
  readonly phases: readonly string[];
  readonly path: string;
  readonly source: string;
  readonly body: string;
}

// Only a literal metadata subset is accepted. Discovery never imports or evaluates a script.
const parseWorkflow = (
  source: string,
  file: string,
  report: Report,
): PluginWorkflow | undefined => {
  const match = /^\s*export\s+const\s+meta\s*=\s*(?<meta>\{[\s\S]*?\})\s*;?/u.exec(source);
  const literal = match?.groups?.["meta"];
  if (match === null || literal === undefined) {
    report({
      message: "workflow must begin with export const meta and a literal metadata object",
      severity: "error",
      source: file,
    });
    return undefined;
  }
  // Restrict tokens before YAML parsing so executable JS, tags and aliases cannot become metadata.
  const tokens = literal.match(
    /'(?:[^'\\]|\\['\\])*'|"(?:[^"\\]|\\["\\])*"|[A-Za-z_][A-Za-z_0-9]*|[{}[\],:]|\s+/gu,
  );
  if (
    tokens?.join("") !== literal ||
    tokens.some(
      (token) => /^[A-Za-z_]/u.test(token) && !["name", "description", "phases"].includes(token),
    )
  ) {
    report({
      message:
        "workflow metadata supports only literal name, description and string-array phases; no expressions",
      severity: "error",
      source: file,
    });
    return undefined;
  }
  const document = parseDocument(literal, { schema: "failsafe", uniqueKeys: true });
  if (document.errors.length > 0) {
    report({ message: "invalid literal workflow metadata", severity: "error", source: file });
    return undefined;
  }
  const meta: unknown = document.toJS({ maxAliasCount: 0 });
  if (
    document.errors.length > 0 ||
    !isRecord(meta) ||
    Object.keys(meta).some((key) => !["name", "description", "phases"].includes(key)) ||
    typeof meta["name"] !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(meta["name"]) ||
    typeof meta["description"] !== "string" ||
    meta["description"].trim() === "" ||
    (meta["phases"] !== undefined && !isStringArray(meta["phases"]))
  ) {
    report({ message: "invalid literal workflow metadata", severity: "error", source: file });
    return undefined;
  }
  return {
    body: source.slice(match[0].length),
    description: meta["description"],
    name: meta["name"],
    path: file,
    phases: isStringArray(meta["phases"]) ? meta["phases"] : [],
    source,
  };
};

const loadWorkflows = async (
  root: string,
  raw: JsonRecord,
  report: Report,
): Promise<PluginWorkflow[]> => {
  const files = await loadRuntimeFiles(root, raw["workflows"], "workflows", ".js", report);
  const workflows = new Map<string, PluginWorkflow>();
  for (const file of files) {
    const workflow = parseWorkflow(file.text, file.path, report);
    if (workflow !== undefined) {
      workflows.set(workflow.name, workflow);
    }
  }
  return [...workflows.values()];
};

export type { PluginWorkflow };
export { loadWorkflows, parseWorkflow };
