import path from "node:path";

import { isRecord, parseJson } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import { readText, resolveWithin } from "#src/paths.ts";
import type { Report } from "#src/types.ts";
import { componentPaths } from "#src/vendor/paths.ts";

interface PluginMonitor {
  readonly name: string;
  readonly command: string;
  readonly description: string;
  readonly when: "always" | `on-skill-invoke:${string}`;
}

const isMonitorWhen = (value: unknown): value is PluginMonitor["when"] =>
  typeof value === "string" &&
  (value === "always" || /^on-skill-invoke:[A-Za-z0-9._-]+$/u.test(value));

const parseMonitors = (value: unknown, source: string, report: Report): PluginMonitor[] => {
  if (!Array.isArray(value)) {
    report({ message: "monitors must be an array", severity: "error", source });
    return [];
  }
  const monitors: PluginMonitor[] = [];
  const names = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some((key) => !["name", "command", "description", "when"].includes(key)) ||
      ![entry["name"], entry["command"], entry["description"]].every(
        (field) => typeof field === "string" && field.trim() !== "",
      ) ||
      typeof entry["name"] !== "string" ||
      typeof entry["command"] !== "string" ||
      typeof entry["description"] !== "string"
    ) {
      report({
        message:
          "monitor requires name, command and description strings; unknown fields are rejected",
        severity: "error",
        source,
      });
      continue;
    }
    const when = entry["when"] ?? "always";
    if (!isMonitorWhen(when)) {
      report({
        message: `monitor ${entry["name"]} has an unsupported start condition`,
        severity: "error",
        source,
      });
      continue;
    }
    if (entry["command"].includes("${user_config.")) {
      report({
        message: `monitor ${entry["name"]} cannot substitute user_config into a shell command`,
        severity: "error",
        source,
      });
      continue;
    }
    if (names.has(entry["name"])) {
      report({ message: `duplicate monitor name ${entry["name"]}`, severity: "error", source });
      continue;
    }
    names.add(entry["name"]);
    monitors.push({
      command: entry["command"],
      description: entry["description"],
      name: entry["name"],
      when,
    });
  }
  return monitors;
};

const loadMonitors = async (
  root: string,
  raw: JsonRecord,
  report: Report,
): Promise<PluginMonitor[]> => {
  const experimental = isRecord(raw["experimental"]) ? raw["experimental"] : {};
  const declared = experimental["monitors"] ?? raw["monitors"];
  if (Array.isArray(declared)) {
    return parseMonitors(declared, "plugin.json#experimental.monitors", report);
  }
  const targets =
    declared === undefined
      ? [path.join(root, "monitors/monitors.json")]
      : componentPaths(declared, root, "experimental.monitors", report);
  if (targets.length !== 1) {
    report({
      message: "monitors accepts one JSON file or an inline array",
      severity: "error",
      source: root,
    });
    return [];
  }
  const [target] = targets;
  if (target === undefined) {
    return [];
  }
  const resolved = await resolveWithin(root, target);
  if (resolved.kind === "missing" && declared === undefined) {
    return [];
  }
  if (resolved.kind !== "file" || !resolved.path.endsWith(".json")) {
    report({
      message: `monitors requires a contained JSON file (${resolved.kind})`,
      severity: "error",
      source: target,
    });
    return [];
  }
  const read = await readText(resolved.path);
  if (!read.ok) {
    report({ message: read.error, severity: "error", source: target });
    return [];
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    report({ message: parsed.error, severity: "error", source: target });
    return [];
  }
  return parseMonitors(parsed.value, target, report);
};

export type { PluginMonitor };
export { loadMonitors, parseMonitors };
