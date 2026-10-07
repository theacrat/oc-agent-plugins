import path from "node:path";

import { isRecord, isStringArray, isStringRecord, parseJson } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import { ensureDir, isWithin, readText, realOrSelf, resolveWithin } from "#src/paths.ts";
import { MCP_SCHEMA } from "#src/types.ts";
import type { Diagnostic, PluginServer } from "#src/types.ts";

// oxlint-disable-next-line no-template-curly-in-string -- literal Agent Plugins placeholder, not a template
const ROOT = "${PLUGIN_ROOT}";
// oxlint-disable-next-line no-template-curly-in-string -- literal Agent Plugins placeholder, not a template
const DATA = "${PLUGIN_DATA}";
const RESERVED = ["PLUGIN_ROOT", "PLUGIN_DATA"] as const;
const STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);
const HTTP_FIELDS = new Set(["type", "url", "headers"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
// oxlint-disable-next-line no-control-regex -- header values must reject control characters other than tab
const HEADER_VALUE = /^[^\u0000-\u0008\u000A-\u001F\u007F]*$/u;

interface ServerContext {
  readonly root: string;
  readonly dataDir: string;
  readonly platform: NodeJS.Platform;
}

type ServerResult = { ok: true; server: PluginServer } | { ok: false; error: string };

const fail = (error: string): ServerResult => ({ error, ok: false });

const envKey = (key: string, platform: NodeJS.Platform) =>
  platform === "win32" ? key.toUpperCase() : key;

// Single, non-recursive pass: text substituted in is never rescanned.
const expand = (value: string, root: string, dataDir: string) =>
  value.replaceAll(/\$\{PLUGIN_(?:ROOT|DATA)\}/gu, (token) => (token === ROOT ? root : dataDir));

const isLoopback = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "[::1]" ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname);

const checkUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !URL.canParse(value)) {
    return "url must be an absolute URL";
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "url must use http or https";
  }
  if (url.username !== "" || url.password !== "" || value.includes("#")) {
    return "url must not contain user information or a fragment";
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    return "non-loopback url must use https";
  }
  return undefined;
};

const checkHeaders = (headers: unknown): string | undefined => {
  if (!isStringRecord(headers)) {
    return "headers must map strings to strings";
  }
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value)) {
      return `header "${name}" is not a valid HTTP header field`;
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      return `header "${name}" is repeated with different casing`;
    }
    seen.add(lower);
  }
  return undefined;
};

const parseHttp = (entry: Readonly<Record<string, unknown>>): ServerResult => {
  const extra = Object.keys(entry).find((key) => !HTTP_FIELDS.has(key));
  if (extra !== undefined) {
    return fail(`unknown field "${extra}"`);
  }
  const error =
    checkUrl(entry["url"]) ??
    (entry["headers"] === undefined ? undefined : checkHeaders(entry["headers"]));
  if (error !== undefined) {
    return fail(error);
  }
  return {
    ok: true,
    server: {
      headers: isStringRecord(entry["headers"]) ? entry["headers"] : {},
      type: "streamable-http",
      url: String(entry["url"]),
    },
  };
};

const resolveCwd = async (cwd: unknown, ctx: ServerContext): Promise<string | ServerResult> => {
  if (cwd === undefined) {
    return ctx.root;
  }
  if (typeof cwd !== "string") {
    return fail("cwd must be a string");
  }
  const inData = cwd === DATA || cwd.startsWith(`${DATA}/`);
  const inRoot = cwd === ROOT || cwd.startsWith(`${ROOT}/`) || cwd.startsWith("./");
  if (!inData && !inRoot) {
    return fail(`cwd must start with ./, ${ROOT} or ${DATA}`);
  }
  const expanded = cwd.startsWith("./")
    ? path.join(ctx.root, cwd)
    : expand(cwd, ctx.root, ctx.dataDir);
  let base = ctx.root;
  if (inData) {
    // PLUGIN_DATA is client-managed and starts empty, so create the requested subdirectory.
    if (!isWithin(ctx.dataDir, path.resolve(expanded))) {
      return fail(`cwd "${cwd}" escapes PLUGIN_DATA`);
    }
    const error = await ensureDir(expanded);
    if (error !== undefined) {
      return fail(error);
    }
    base = await realOrSelf(ctx.dataDir);
  }
  const resolved = await resolveWithin(base, expanded);
  if (resolved.kind !== "directory") {
    return fail(
      `cwd "${cwd}" must be an existing directory inside ${inData ? "PLUGIN_DATA" : "the plugin root"}`,
    );
  }
  return resolved.path;
};

const resolveCommand = async (command: unknown, root: string): Promise<string | ServerResult> => {
  if (typeof command !== "string" || command.length === 0) {
    return fail("command must be a non-empty string");
  }
  if (command.startsWith("./")) {
    const resolved = await resolveWithin(root, path.join(root, command));
    return resolved.kind === "file"
      ? resolved.path
      : fail(`command "${command}" must be a file inside the plugin root`);
  }
  if (/[/\\]/u.test(command)) {
    return fail("command must be a bare executable name or a ./ plugin-relative path");
  }
  return command;
};

const parseStdio = async (
  entry: Readonly<Record<string, unknown>>,
  ctx: ServerContext,
): Promise<ServerResult> => {
  const extra = Object.keys(entry).find((key) => !STDIO_FIELDS.has(key));
  if (extra !== undefined) {
    return fail(`unknown field "${extra}"`);
  }
  const { args = [], env = {} } = entry;
  if (!isStringArray(args)) {
    return fail("args must be an array of strings");
  }
  if (!isStringRecord(env)) {
    return fail("env must map strings to strings");
  }
  const reservedKeys = new Set(RESERVED.map((key) => envKey(key, ctx.platform)));
  const reserved = Object.keys(env).find((key) => reservedKeys.has(envKey(key, ctx.platform)));
  if (reserved !== undefined) {
    return fail(`env must not set ${reserved}`);
  }
  const command = await resolveCommand(entry["command"], ctx.root);
  if (typeof command !== "string") {
    return command;
  }
  const cwd = await resolveCwd(entry["cwd"], ctx);
  if (typeof cwd !== "string") {
    return cwd;
  }
  return {
    ok: true,
    server: {
      args: args.map((arg) => expand(arg, ctx.root, ctx.dataDir)),
      command,
      cwd,
      env: {
        ...Object.fromEntries(
          Object.entries(env).map(([key, value]) => [key, expand(value, ctx.root, ctx.dataDir)]),
        ),
        PLUGIN_DATA: ctx.dataDir,
        PLUGIN_ROOT: ctx.root,
      },
      type: "stdio",
    },
  };
};

const parseServer = async (entry: unknown, ctx: ServerContext): Promise<ServerResult> => {
  if (!isRecord(entry)) {
    return fail("server entry must be an object");
  }
  switch (entry["type"]) {
    case "stdio": {
      return parseStdio(entry, ctx);
    }
    case "streamable-http": {
      return parseHttp(entry);
    }
    case "sse": {
      const parsed = parseHttp(entry);
      return parsed.ok ? fail("legacy HTTP+SSE transport is not supported; skipped") : parsed;
    }
    default: {
      return fail(`unknown transport type ${JSON.stringify(entry["type"])}`);
    }
  }
};

// Top-level failures disable MCP for the whole plugin (spec 7.2.2 rule 2).
const readServers = (text: string): JsonRecord | string => {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return `invalid JSON: ${parsed.error}`;
  }
  const doc = parsed.value;
  if (!isRecord(doc)) {
    return "must contain a JSON object";
  }
  if (doc["$schema"] !== MCP_SCHEMA) {
    return `$schema must be ${MCP_SCHEMA} to match plugin.json`;
  }
  const extra = Object.keys(doc).find((key) => key !== "$schema" && key !== "mcpServers");
  if (extra !== undefined) {
    return `unknown top-level field "${extra}"`;
  }
  const servers = doc["mcpServers"];
  return isRecord(servers) ? servers : "mcpServers must be an object";
};

const discoverServers = async (
  ctx: ServerContext,
  report: (diagnostic: Diagnostic) => void,
): Promise<Record<string, PluginServer>> => {
  const location = await resolveWithin(ctx.root, path.join(ctx.root, "mcp.json"));
  if (location.kind === "missing") {
    return {};
  }
  const read =
    location.kind === "file"
      ? await readText(location.path)
      : { error: "mcp.json is not a regular file inside the plugin root", ok: false as const };
  const entries = read.ok ? readServers(read.text) : read.error;
  if (typeof entries === "string") {
    report({
      message: `${entries}; MCP disabled for this plugin`,
      severity: "error",
      source: "mcp.json",
    });
    return {};
  }

  const parsedEntries = await Promise.all(
    Object.entries(entries).map(
      async ([name, entry]) => [name, await parseServer(entry, ctx)] as const,
    ),
  );
  const servers: Record<string, PluginServer> = {};
  for (const [name, result] of parsedEntries) {
    if (result.ok) {
      servers[name] = result.server;
    } else {
      report({ message: result.error, severity: "error", source: `mcp.json#${name}` });
    }
  }
  return servers;
};

export type { ServerContext, ServerResult };
export { checkHeaders, checkUrl, discoverServers, expand, parseServer };
