import path from "node:path";

import { isRecord, isStringArray, isStringRecord, parseJson } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import { checkHeaders, checkUrl } from "#src/mcp.ts";
import type { ServerResult } from "#src/mcp.ts";
import { ensureDir, readText, resolveWithin } from "#src/paths.ts";
import type { PluginServer, Report } from "#src/types.ts";
import { componentPaths } from "#src/vendor/paths.ts";
import type { Placeholders } from "#src/vendor/placeholders.ts";

// Host-specific keys that don't change how the server connects; ignored with a warning.
const IGNORED_FIELDS = new Set([
  "default_tools_approval_mode",
  "disabled",
  "enabled",
  "enabled_tools",
  "env_vars",
  "oauth",
  "oauth_resource",
  "omit_tools_from",
  "startup_timeout_sec",
  "timeout",
  "tool_timeout_sec",
  "tools",
  "alwaysLoad",
  "headersHelper",
]);
const STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);
const HTTP_FIELDS = new Set(["type", "url", "headers"]);

interface VendorServerContext {
  readonly root: string;
  readonly dataDir: string;
  readonly placeholders: Placeholders;
}

type Entry = Readonly<Record<string, unknown>>;

const fail = (error: string): ServerResult => ({ error, ok: false });

const unknownFields = (entry: Entry, allowed: ReadonlySet<string>) =>
  Object.keys(entry).filter((key) => !allowed.has(key));

// Vendor files may be absolute (Codex bundles are), but plugin-relative paths must stay in the root.
const resolveRelative = async (
  value: string,
  ctx: VendorServerContext,
  kind: "file" | "directory",
): Promise<string | undefined> => {
  if (path.isAbsolute(value)) {
    return value;
  }
  const resolved = await resolveWithin(ctx.root, path.resolve(ctx.root, value));
  return resolved.kind === kind ? resolved.path : undefined;
};

const parseStdio = async (entry: Entry, ctx: VendorServerContext): Promise<ServerResult> => {
  const { expand } = ctx.placeholders;
  const { args = [], env = {} } = entry;
  if (typeof entry["command"] !== "string" || entry["command"].trim() === "") {
    return fail("command must be a non-empty string");
  }
  if (!isStringArray(args)) {
    return fail("args must be an array of strings");
  }
  if (!isStringRecord(env)) {
    return fail("env must map strings to strings");
  }
  const rawCommand = expand(entry["command"]);
  const isPath = /[/\\]/u.test(rawCommand);
  const command = isPath ? await resolveRelative(rawCommand, ctx, "file") : rawCommand;
  if (command === undefined) {
    return fail(`command "${entry["command"]}" must be a file inside the plugin root`);
  }
  let cwd = ctx.root;
  if (entry["cwd"] !== undefined) {
    if (typeof entry["cwd"] !== "string") {
      return fail("cwd must be a string");
    }
    const resolved = await resolveRelative(expand(entry["cwd"]), ctx, "directory");
    if (resolved === undefined) {
      return fail(`cwd "${entry["cwd"]}" must be a directory inside the plugin root`);
    }
    cwd = resolved;
  }
  if (Object.keys(ctx.placeholders.processEnv).length > 0) {
    const error = await ensureDir(ctx.dataDir);
    if (error !== undefined) {
      return fail(error);
    }
  }
  return {
    ok: true,
    server: {
      args: args.map((arg) => expand(arg)),
      command,
      cwd,
      env: {
        ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, expand(value)])),
        ...ctx.placeholders.processEnv,
      },
      type: "stdio",
    },
  };
};

const parseHttp = (entry: Entry, ctx: VendorServerContext): ServerResult => {
  const { expand, expandRemote } = ctx.placeholders;
  const expandValue = expandRemote ? expand : (value: string) => value;
  if (typeof entry["url"] !== "string") {
    return fail("url must be a string");
  }
  if (entry["headers"] !== undefined && !isStringRecord(entry["headers"])) {
    return fail("headers must map strings to strings");
  }
  const url = expandValue(entry["url"]);
  const headers = Object.fromEntries(
    Object.entries(isStringRecord(entry["headers"]) ? entry["headers"] : {}).map(([key, value]) => [
      key,
      expandValue(value),
    ]),
  );
  const error = checkUrl(url) ?? checkHeaders(headers);
  return error === undefined
    ? { ok: true, server: { headers, type: "streamable-http", url } }
    : fail(error);
};

type Transport =
  | { readonly kind: "stdio" | "http" }
  | { readonly kind: "unsupported"; readonly error: string };

// Transport comes from `type`, or is inferred from `command`/`url` as Claude, Codex and Cursor do.
const transportOf = (entry: Entry): Transport => {
  const { type } = entry;
  if (type === undefined) {
    if (entry["command"] !== undefined) {
      return { kind: "stdio" };
    }
    return entry["url"] === undefined
      ? { error: "server needs a command or url", kind: "unsupported" }
      : { kind: "http" };
  }
  if (type === "stdio") {
    return { kind: "stdio" };
  }
  if (type === "streamable-http" || type === "http") {
    return { kind: "http" };
  }
  return {
    error: `${JSON.stringify(type)} transport is not supported; skipped`,
    kind: "unsupported",
  };
};

const parseVendorServer = async (
  entry: unknown,
  ctx: VendorServerContext,
  warn: (message: string) => void,
): Promise<ServerResult> => {
  if (!isRecord(entry)) {
    return fail("server entry must be an object");
  }
  const transport = transportOf(entry);
  if (transport.kind === "unsupported") {
    return fail(transport.error);
  }
  const allowed = transport.kind === "stdio" ? STDIO_FIELDS : HTTP_FIELDS;
  const unknown = unknownFields(entry, allowed);
  const misplaced = unknown.filter((key) => !IGNORED_FIELDS.has(key));
  if (misplaced.length > 0) {
    return fail(`unknown field "${misplaced[0]}" for ${transport.kind} server`);
  }
  if (unknown.length > 0) {
    warn(`ignoring host-specific fields: ${unknown.join(", ")}`);
  }
  return transport.kind === "stdio" ? parseStdio(entry, ctx) : parseHttp(entry, ctx);
};

// Some files wrap servers in `mcpServers`, others are the bare server map.
const serverMap = (doc: JsonRecord): JsonRecord | string => {
  if ("mcpServers" in doc) {
    const servers = doc["mcpServers"];
    return isRecord(servers) ? servers : "mcpServers must be an object";
  }
  return doc;
};

const readServerFile = async (
  file: string,
  ctx: VendorServerContext,
): Promise<JsonRecord | string> => {
  const resolved = await resolveWithin(ctx.root, file);
  if (resolved.kind !== "file") {
    return resolved.kind === "missing"
      ? "file not found"
      : "not a regular file inside the plugin root";
  }
  const read = await readText(resolved.path);
  if (!read.ok) {
    return read.error;
  }
  const parsed = parseJson(read.text);
  if (!parsed.ok) {
    return `invalid JSON: ${parsed.error}`;
  }
  return isRecord(parsed.value) ? serverMap(parsed.value) : "must contain a JSON object";
};

interface ServerSources {
  // Default files read before any declared sources (for example `.mcp.json`).
  readonly defaults: readonly string[];
  // Manifest `mcpServers`: a path, inline map, or an array of either.
  readonly declared: unknown;
  // Cursor: a declared value replaces the default file instead of adding to it.
  readonly declaredReplacesDefaults: boolean;
}

type Source =
  | { readonly kind: "file"; readonly file: string; readonly required: boolean }
  | { readonly kind: "inline"; readonly value: JsonRecord };

// Decides which sources to read, in merge order. Manifests often declare the default file too
// (`"mcpServers": "./.mcp.json"`), so each file appears once.
const planSources = (sources: ServerSources, root: string, report: Report): Source[] => {
  const declared = sources.declared === undefined ? [] : [sources.declared].flat();
  const useDefaults = !(sources.declaredReplacesDefaults && declared.length > 0);
  const plan: Source[] = (useDefaults ? sources.defaults : []).map((file) => ({
    file: path.join(root, file),
    kind: "file",
    required: false,
  }));
  for (const value of declared) {
    if (isRecord(value)) {
      plan.push({ kind: "inline", value });
    } else if (typeof value === "string" && value.endsWith(".json")) {
      plan.push(
        ...componentPaths(value, root, "mcpServers", report).map((file): Source => ({
          file,
          kind: "file",
          required: true,
        })),
      );
    } else {
      report({
        message: `unsupported mcpServers entry ${JSON.stringify(value)}; MCP bundles aren't supported`,
        severity: "warning",
        source: "plugin.json#mcpServers",
      });
    }
  }
  const files = new Set<string>();
  return plan.filter((source) => {
    if (source.kind === "inline") {
      return true;
    }
    const fresh = !files.has(source.file);
    files.add(source.file);
    return fresh;
  });
};

const readSource = async (
  source: Source,
  ctx: VendorServerContext,
  report: Report,
): Promise<{ readonly source: string; readonly servers: JsonRecord } | undefined> => {
  const label =
    source.kind === "inline" ? "plugin.json#mcpServers" : path.relative(ctx.root, source.file);
  const servers =
    source.kind === "inline" ? serverMap(source.value) : await readServerFile(source.file, ctx);
  if (typeof servers !== "string") {
    return { servers, source: label };
  }
  if (source.kind === "inline" || source.required || servers !== "file not found") {
    report({ message: `${servers}; skipped`, severity: "error", source: label });
  }
  return undefined;
};

// Later declarations replace earlier servers of the same name, as Claude Code does.
const discoverVendorServers = async (
  sources: ServerSources,
  ctx: VendorServerContext,
  report: Report,
): Promise<Record<string, PluginServer>> => {
  const maps = await Promise.all(
    planSources(sources, ctx.root, report).map(async (source) => readSource(source, ctx, report)),
  );
  const entries = maps
    .filter((map) => map !== undefined)
    .flatMap(({ servers, source }) =>
      Object.entries(servers).map(([name, entry]) => ({
        entry,
        name,
        source: `${source}#${name}`,
      })),
    );
  const results = await Promise.all(
    entries.map(async ({ entry, source }) =>
      parseVendorServer(entry, ctx, (message) => {
        report({ message, severity: "warning", source });
      }),
    ),
  );
  const servers: Record<string, PluginServer> = {};
  for (const [index, result] of results.entries()) {
    const { name = "", source = "" } = entries[index] ?? {};
    if (result.ok) {
      servers[name] = result.server;
    } else {
      report({ message: result.error, severity: "error", source });
    }
  }
  return servers;
};

export type { ServerSources, VendorServerContext };
export { discoverVendorServers, parseVendorServer };
