import { isRecord, isStringArray } from "#src/json.ts";
import { checkUrl } from "#src/mcp.ts";
import type { PluginServer, StreamableHttpServer } from "#src/types.ts";
import { positiveMs } from "#src/vendor/mcp-timeout.ts";

type Options = Pick<PluginServer, "disabled" | "timeout" | "toolPolicy"> &
  Pick<StreamableHttpServer, "oauth">;
type ParsedOptions =
  | { readonly ok: true; readonly options: Options }
  | { readonly ok: false; readonly error: string };

const POLICY_FIELDS = new Set([
  "enabled",
  "disabled",
  "oauth",
  "startup_timeout_sec",
  "startup_timeout_ms",
  "tool_timeout_sec",
  "timeout",
  "enabled_tools",
  "disabled_tools",
  "tools",
  "default_tools_approval_mode",
  "env_vars",
  "headersHelper",
  "http_headers_helper",
  "oauth_resource",
  "omit_tools_from",
  "alwaysLoad",
  "required",
]);

const fail = (error: string): never => {
  throw new Error(error);
};
const unsupported = (entry: Readonly<Record<string, unknown>>) => {
  for (const field of [
    "env_vars",
    "headersHelper",
    "http_headers_helper",
    "oauth_resource",
    "omit_tools_from",
    "alwaysLoad",
    "required",
  ]) {
    if (Object.hasOwn(entry, field)) {
      let reason =
        "the native MCP API cannot preserve this vendor policy; remove it only after reviewing its security and lifecycle implications";
      if (field === "env_vars") {
        reason =
          "native local MCP inherits the host environment and cannot enforce a vendor whitelist; use an explicitly environment-isolated stdio launcher";
      }
      if (field === "headersHelper" || field === "http_headers_helper") {
        reason =
          "native remote MCP has no dynamic header callback; use a trusted external stdio bridge that runs the helper per vendor semantics";
      }
      return fail(`${field} is not representable: ${reason}`);
    }
  }
};
const enablement = (entry: Readonly<Record<string, unknown>>): Pick<Options, "disabled"> => {
  for (const field of ["enabled", "disabled"]) {
    if (Object.hasOwn(entry, field) && typeof entry[field] !== "boolean") {
      return fail(`${field} must be a boolean`);
    }
  }
  if (
    typeof entry["enabled"] === "boolean" &&
    typeof entry["disabled"] === "boolean" &&
    entry["enabled"] === entry["disabled"]
  ) {
    return fail("enabled and disabled contradict each other");
  }
  if (typeof entry["disabled"] === "boolean") {
    return { disabled: entry["disabled"] };
  }
  return typeof entry["enabled"] === "boolean" ? { disabled: !entry["enabled"] } : {};
};
const timeouts = (entry: Readonly<Record<string, unknown>>): Pick<Options, "timeout"> => {
  const timeout: { startup?: number; catalog?: number; execution?: number } = {};
  if (Object.hasOwn(entry, "timeout")) {
    const raw = entry["timeout"];
    if (!isRecord(raw)) {
      return fail(
        "timeout must be an object of positive integer milliseconds (startup, catalog, execution); scalar vendor timeout units are ambiguous",
      );
    }
    for (const [key, value] of Object.entries(raw)) {
      if (key !== "startup" && key !== "catalog" && key !== "execution") {
        return fail(`unknown timeout field "${key}"`);
      }
      const ms = positiveMs(value);
      if (ms === undefined) {
        return fail(
          `timeout.${key} must be positive integer milliseconds no greater than 2147483647`,
        );
      }
      timeout[key] = ms;
    }
  }
  for (const [field, key, scale] of [
    ["startup_timeout_sec", "startup", 1000],
    ["startup_timeout_ms", "startup", 1],
    ["tool_timeout_sec", "execution", 1000],
  ] as const) {
    if (!Object.hasOwn(entry, field)) {
      continue;
    }
    const ms = positiveMs(entry[field], scale);
    if (ms === undefined) {
      return fail(
        `${field} must convert to positive integer milliseconds no greater than 2147483647`,
      );
    }
    if (timeout[key] !== undefined && timeout[key] !== ms) {
      return fail(`${field} conflicts with another ${key} timeout`);
    }
    timeout[key] = ms;
  }
  return Object.keys(timeout).length === 0 ? {} : { timeout };
};
const toolLists = (entry: Readonly<Record<string, unknown>>) => {
  const lists: { enabled?: readonly string[]; disabled?: readonly string[] } = {};
  for (const [field, key] of [
    ["enabled_tools", "enabled"],
    ["disabled_tools", "disabled"],
  ] as const) {
    if (!Object.hasOwn(entry, field)) {
      continue;
    }
    const value = entry[field];
    if (!isStringArray(value) || value.some((name) => !/^[A-Za-z0-9_-]+$/u.test(name))) {
      return fail(
        `${field} must contain exact tool names using letters, numbers, underscores or hyphens; names that require native normalisation cannot safely enforce policy`,
      );
    }
    if (key === "enabled" && value.some((name) => name.includes("_"))) {
      return fail(
        "enabled_tools names containing underscores are ambiguous after native normalisation; rename the upstream tools or enforce the allowlist in an external stdio bridge",
      );
    }
    lists[key] = value;
  }
  return lists;
};
const toolOverrides = (entry: Readonly<Record<string, unknown>>) => {
  const tools = new Map<string, { readonly approval: "ask" }>();
  if (Object.hasOwn(entry, "tools")) {
    if (!isRecord(entry["tools"])) {
      return fail("tools must be an object of per-tool policies");
    }
    for (const [name, value] of Object.entries(entry["tools"])) {
      if (!/^[A-Za-z0-9_-]+$/u.test(name)) {
        return fail(`tools name "${name}" cannot safely enforce policy after native normalisation`);
      }
      if (
        !isRecord(value) ||
        Object.keys(value).some((key) => key !== "approval_mode") ||
        value["approval_mode"] !== "prompt"
      ) {
        return fail(
          `tools.${name} supports only { approval_mode: "prompt" }; other vendor tool policies cannot be preserved`,
        );
      }
      tools.set(name, { approval: "ask" });
    }
  }
  return tools.size === 0 ? {} : { tools: Object.fromEntries(tools) };
};
const toolPolicy = (entry: Readonly<Record<string, unknown>>): Pick<Options, "toolPolicy"> => {
  const approval = entry["default_tools_approval_mode"];
  if (Object.hasOwn(entry, "default_tools_approval_mode") && approval !== "prompt") {
    return fail(
      "default_tools_approval_mode supports only prompt; auto, writes and approve require vendor approval semantics unavailable in the native API",
    );
  }
  const policy = {
    ...toolLists(entry),
    ...toolOverrides(entry),
    ...(approval === undefined ? {} : { approval: "ask" as const }),
  };
  return Object.keys(policy).length === 0 ? {} : { toolPolicy: policy };
};
const oauthString = (value: unknown, key: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    return fail(`oauth.${key} must be a non-empty string`);
  }
  if (key !== "redirect_uri" && key !== "auth_server_metadata_url") {
    return value;
  }
  if (checkUrl(value) !== undefined) {
    return fail(`oauth.${key} must be an absolute HTTP(S) URL without credentials`);
  }
  if (key === "redirect_uri") {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.hash !== "" ||
      url.search !== ""
    ) {
      return fail(
        "oauth.redirect_uri must be an HTTP loopback callback URL without query or fragment",
      );
    }
  }
  return value;
};
type OAuth = Exclude<StreamableHttpServer["oauth"], false | undefined>;
type MutableOAuth = { -readonly [Key in keyof OAuth]: OAuth[Key] };
const validateOAuth = (result: MutableOAuth) => {
  if (result.client_secret !== undefined && result.client_id === undefined) {
    return fail("oauth.client_secret requires client_id");
  }
  if (
    result.redirect_uri !== undefined &&
    result.callback_port !== undefined &&
    Number(new URL(result.redirect_uri).port || "80") !== result.callback_port
  ) {
    return fail("oauth.redirect_uri port must match callback_port");
  }
};
const oauthObject = (
  raw: Readonly<Record<string, unknown>>,
): Exclude<StreamableHttpServer["oauth"], false | undefined> => {
  const result: MutableOAuth = {};
  const aliases: Readonly<Record<string, string>> = {
    authServerMetadataUrl: "auth_server_metadata_url",
    callbackPort: "callback_port",
    clientId: "client_id",
    clientSecret: "client_secret",
    redirectUri: "redirect_uri",
  };
  for (const [field, value] of Object.entries(raw)) {
    const key = aliases[field] ?? field;
    if (Object.hasOwn(result, key)) {
      return fail(`duplicate oauth mapping for ${key}`);
    }
    if (key === "callback_port") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
        return fail("oauth.callback_port must be an integer from 1 through 65535");
      }
      result.callback_port = value;
    } else if (
      key === "client_id" ||
      key === "client_secret" ||
      key === "scope" ||
      key === "redirect_uri" ||
      key === "auth_server_metadata_url"
    ) {
      result[key] = oauthString(value, key);
    } else {
      return fail(
        `oauth.${field} cannot be represented by native OAuth; use documented native OAuth fields, not vendor callback or resource semantics`,
      );
    }
  }
  validateOAuth(result);
  return result;
};
const oauthOptions = (
  entry: Readonly<Record<string, unknown>>,
  remote: boolean,
): Pick<Options, "oauth"> => {
  if (!Object.hasOwn(entry, "oauth")) {
    return {};
  }
  if (!remote) {
    return fail("oauth is only valid for an HTTP server");
  }
  const raw = entry["oauth"];
  if (raw === false) {
    return { oauth: false };
  }
  if (!isRecord(raw)) {
    return fail("oauth must be false or a validated OAuth object");
  }
  return { oauth: oauthObject(raw) };
};
const parseServerOptions = (
  entry: Readonly<Record<string, unknown>>,
  remote: boolean,
): ParsedOptions => {
  try {
    unsupported(entry);
    return {
      ok: true,
      options: {
        ...enablement(entry),
        ...timeouts(entry),
        ...toolPolicy(entry),
        ...oauthOptions(entry, remote),
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid MCP policy", ok: false };
  }
};

export { POLICY_FIELDS, parseServerOptions };
