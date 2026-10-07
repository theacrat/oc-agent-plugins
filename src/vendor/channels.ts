import { isRecord } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import type { Report } from "#src/types.ts";

interface PluginChannel {
  readonly server: string;
  readonly displayName: string;
  readonly userConfig: JsonRecord;
}

const CHANNEL_BLOCKER =
  "Claude channel messages unavailable: OpenCode's plugin MCP transform does not expose notifications/claude/channel or channel capability negotiation. Safe delivery requires user opt-in, authenticated sender allowlists and explicit session routing; an MCP server definition alone does not provide these. Use the channel in Claude Code or supply a separate authenticated integration. No protocol endpoint is inferred or opened.";

const loadChannels = (raw: JsonRecord, report: Report): PluginChannel[] => {
  if (raw["channels"] === undefined) {
    return [];
  }
  if (!Array.isArray(raw["channels"])) {
    report({
      message: "channels must be an array",
      severity: "error",
      source: "plugin.json#channels",
    });
    return [];
  }
  const channels: PluginChannel[] = [];
  for (const entry of raw["channels"]) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some((key) => !["server", "displayName", "userConfig"].includes(key)) ||
      typeof entry["server"] !== "string" ||
      entry["server"].trim() === "" ||
      (entry["displayName"] !== undefined && typeof entry["displayName"] !== "string") ||
      (entry["userConfig"] !== undefined && !isRecord(entry["userConfig"]))
    ) {
      report({
        message:
          "invalid channel declaration; expected server, optional displayName and userConfig",
        severity: "error",
        source: "plugin.json#channels",
      });
      continue;
    }
    channels.push({
      displayName:
        typeof entry["displayName"] === "string" ? entry["displayName"] : entry["server"],
      server: entry["server"],
      userConfig: isRecord(entry["userConfig"]) ? entry["userConfig"] : {},
    });
    report({
      message: CHANNEL_BLOCKER,
      severity: "warning",
      source: `plugin.json#channels.${entry["server"]}`,
    });
  }
  return channels;
};

export type { PluginChannel };
export { CHANNEL_BLOCKER, loadChannels };
