import path from "node:path";

import { isRecord, parseJson } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import { listDir, readText, resolveWithin } from "#src/paths.ts";
import type { Report } from "#src/types.ts";

interface AppEndpoint {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const appID = (definition: unknown): unknown => {
  if (typeof definition === "string") {
    return definition;
  }
  return isRecord(definition) ? (definition["id"] ?? definition["app_id"]) : undefined;
};

const resolveApps = (
  apps: JsonRecord,
  endpoints: Readonly<Record<string, AppEndpoint>>,
  report: Report,
): JsonRecord => {
  const servers: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(apps)) {
    const id = appID(definition);
    const endpoint = typeof id === "string" ? endpoints[id] : undefined;
    if (endpoint === undefined) {
      report({
        message: `registered app ${name} needs an explicit appEndpoints mapping; OpenAI app IDs cannot be resolved by OpenCode`,
        severity: "error",
        source: `apps#${name}`,
      });
    } else {
      servers[name] = { ...endpoint, type: "http" };
    }
  }
  return servers;
};

// App IDs are opaque references to OpenAI-owned infrastructure, not URLs. The user may explicitly
// supply an endpoint mapping; no private credentials or guessed endpoints are retrieved.
const loadAppMappings = async (
  root: string,
  declared: unknown,
  endpoints: Readonly<Record<string, AppEndpoint>>,
  report: Report,
): Promise<JsonRecord> => {
  if (declared === undefined) {
    return {};
  }
  if (typeof declared !== "string" || !declared.startsWith("./")) {
    report({
      message: "apps must name a ./-relative .app.json file",
      severity: "error",
      source: "apps",
    });
    return {};
  }
  const file = await resolveWithin(root, path.resolve(root, declared));
  if (file.kind !== "file") {
    report({
      message: "app manifest is missing or escapes the plugin root",
      severity: "error",
      source: "apps",
    });
    return {};
  }
  const read = await readText(file.path);
  const parsed = read.ok ? parseJson(read.text) : read;
  if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value["apps"])) {
    report({
      message: "app manifest must contain an apps object",
      severity: "error",
      source: "apps",
    });
    return {};
  }
  return resolveApps(parsed.value["apps"], endpoints, report);
};

// These features require a runtime contract the current OpenCode plugin API does not supply.
// Their presence is an error with remediation, not an ignored field or an executed JS import.
const reportBlockedRuntimes = async (root: string, raw: JsonRecord, report: Report) => {
  const declarations: readonly [string, unknown, string][] = [
    [
      "channels",
      raw["channels"],
      "Claude channels need an authenticated session-routing bridge; use a normal MCP server until such a bridge is configured",
    ],
    [
      "workflows",
      raw["workflows"],
      "Claude workflow scripts need the isolated agent/pipeline/parallel runtime; port the workflow to OpenCode commands and subagents",
    ],
    [
      "experimental",
      raw["experimental"],
      "experimental vendor runtimes must be translated individually; no arbitrary vendor module is executed",
    ],
  ];
  for (const [source, declaration, message] of declarations) {
    if (declaration !== undefined) {
      report({ message, severity: "error", source });
    }
  }
  await Promise.all(
    ["workflows", "monitors", "themes"].map(async (directory) => {
      const resolved = await resolveWithin(root, path.join(root, directory));
      if (resolved.kind === "directory") {
        const entries = await listDir(resolved.path);
        if (entries.length > 0 && raw[directory] === undefined) {
          report({
            message: `${directory}/ needs a vendor runtime not exposed by OpenCode; files were not executed or applied. Port workflows to commands, monitors to explicit background shell tasks, and themes to a CLI plugin`,
            severity: "error",
            source: `${directory}/`,
          });
        }
      }
    }),
  );
};

export type { AppEndpoint };
export { loadAppMappings, reportBlockedRuntimes };
