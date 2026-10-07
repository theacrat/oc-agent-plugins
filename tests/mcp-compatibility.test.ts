import { describe, expect, it, vi } from "vitest";

import { toPolicyServerConfigs, toServerConfigs } from "#src/opencode.ts";
import { mcpPolicies, mcpToolEffect, restrictMcpPermission } from "#src/runtime/mcp-policy.ts";
import type { AgentPlugin } from "#src/types.ts";
import { discoverVendorServers, parseVendorServer } from "#src/vendor/mcp.ts";
import { placeholdersFor } from "#src/vendor/placeholders.ts";

const ctx = {
  dataDir: "/tmp/opencode/mcp-test-data",
  placeholders: placeholdersFor("cursor", {
    dataDir: "/tmp/opencode/mcp-test-data",
    env: {},
    root: "/tmp/opencode",
  }),
  root: "/tmp/opencode",
};
const warn = vi.fn<(message: string) => void>();
const parse = async (entry: unknown) => parseVendorServer(entry, ctx, warn);
const plugin = (servers: AgentPlugin["servers"]): AgentPlugin => ({
  agents: [],
  commands: [],
  dataDir: ctx.dataDir,
  format: "cursor",
  manifest: { name: "demo" },
  root: ctx.root,
  rules: [],
  servers,
  skills: [],
});

describe("MCP compatibility", () => {
  it("preserves disabled local servers and rejects local OAuth", async () => {
    const result = await parse({ command: "node", disabled: true, startup_timeout_ms: 10 });
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(toServerConfigs(plugin({ local: result.server }))).toEqual([
      [
        "demo-local",
        {
          command: ["node"],
          cwd: "/tmp/opencode",
          disabled: true,
          environment: { CLAUDE_PLUGIN_ROOT: "/tmp/opencode", CURSOR_PLUGIN_ROOT: "/tmp/opencode" },
          timeout: { startup: 10 },
          type: "local",
        },
      ],
    ]);
    expect(await parse({ command: "node", oauth: false })).toEqual({
      error: "oauth is only valid for an HTTP server",
      ok: false,
    });
  });

  it("an empty allowlist denies every tool", async () => {
    const result = await parse({ enabled_tools: [], url: "https://example.com" });
    if (!result.ok) {
      throw new Error(result.error);
    }
    const policies = mcpPolicies([plugin({ docs: result.server })]);
    expect(mcpToolEffect(policies, "demo-docs_read")).toBe("deny");
  });
  it("preserves explicit enablement, authentication and timeout units", async () => {
    const result = await parse({
      enabled: false,
      oauth: false,
      startup_timeout_sec: 1.25,
      timeout: { catalog: 3000 },
      tool_timeout_sec: 60,
      url: "https://example.com/mcp",
    });
    expect(result).toEqual({
      ok: true,
      server: {
        disabled: true,
        headers: {},
        oauth: false,
        timeout: { catalog: 3000, execution: 60_000, startup: 1250 },
        type: "streamable-http",
        url: "https://example.com/mcp",
      },
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(toServerConfigs(plugin({ docs: result.server }))).toEqual([
      [
        "demo-docs",
        {
          disabled: true,
          headers: {},
          oauth: false,
          timeout: { catalog: 3000, execution: 60_000, startup: 1250 },
          type: "remote",
          url: "https://example.com/mcp",
        },
      ],
    ]);
  });

  it("maps validated OAuth aliases without dropping unknown properties", async () => {
    expect(
      await parse({
        oauth: {
          callbackPort: 12_345,
          clientId: "client",
          redirectUri: "http://127.0.0.1:12345/callback",
          scope: "read write",
        },
        url: "https://example.com",
      }),
    ).toEqual({
      ok: true,
      server: {
        headers: {},
        oauth: {
          callback_port: 12_345,
          client_id: "client",
          redirect_uri: "http://127.0.0.1:12345/callback",
          scope: "read write",
        },
        type: "streamable-http",
        url: "https://example.com",
      },
    });
  });

  it.each([
    { enabled: "false" },
    { disabled: 1 },
    { disabled: true, enabled: true },
    { startup_timeout_sec: 0 },
    { tool_timeout_sec: -1 },
    { timeout: 30 },
    { timeout: { catalog: 1.5 } },
    { startup_timeout_sec: Infinity },
    { startup_timeout_ms: 2, startup_timeout_sec: 1 },
    { timeout: { unexpected: 1 } },
    { env_vars: [] },
    { headersHelper: "echo secret" },
    { oauth_resource: "https://resource" },
    { omit_tools_from: [] },
    { alwaysLoad: false },
    { required: false },
    { default_tools_approval_mode: "auto" },
    { default_tools_approval_mode: "approve" },
    { default_tools_approval_mode: "writes" },
    { enabled_tools: ["read/file"] },
    { enabled_tools: ["read_file"] },
    { tools: { read: { output_token_limit: 4 } } },
    { oauth: true },
    { oauth: { resource: "https://example.com" } },
    { oauth: { clientId: "b", client_id: "a" } },
    { oauth: { client_secret: "secret" } },
    { oauth: { callback_port: 0 } },
    { oauth: { redirect_uri: "https://evil.com/callback" } },
    { oauth: { callback_port: 5, redirect_uri: "http://localhost:6/callback" } },
  ])("rejects malformed or unrepresentable policy %j", async (fields) => {
    const result = await parse({ url: "https://example.com", ...fields });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unsafe server accepted");
    }
    expect(result.error.length).toBeGreaterThan(10);
  });

  it.each(["sse", "ws", "websocket"])("does not relabel %s as native HTTP", async (type) => {
    expect(await parse({ type, url: "https://example.com" })).toEqual({
      error: `"${type}" transport is not supported by native MCP (remote uses Streamable HTTP only); configure a trusted external stdio transport bridge explicitly`,
      ok: false,
    });
  });

  it("enforces exact allowlists, deny precedence and prompts without widening host denial", async () => {
    const result = await parse({
      default_tools_approval_mode: "prompt",
      disabled_tools: ["write"],
      enabled_tools: ["read", "write"],
      tools: { read: { approval_mode: "prompt" } },
      url: "https://example.com",
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    const loaded = plugin({ docs: result.server });
    const plugins = [loaded];
    expect(result.server.toolPolicy).toEqual({
      approval: "ask",
      disabled: ["write"],
      enabled: ["read", "write"],
      tools: { read: { approval: "ask" } },
    });
    expect(toServerConfigs(loaded)[0]?.[1].disabled).toBe(true);
    expect(toPolicyServerConfigs(loaded)[0]?.[1].disabled).toBeUndefined();
    const policies = mcpPolicies(plugins);
    expect(
      ["demo-docs_read", "demo-docs_write", "demo-docs_admin", "other_read"].map((id) =>
        mcpToolEffect(policies, id),
      ),
    ).toEqual(["ask", "deny", "deny", undefined]);
    const denied = { action: "demo-docs_read", effect: "deny" as const };
    const allowed = { action: "demo-docs_read", effect: "allow" as const };
    const forbidden = { action: "demo-docs_write", effect: "allow" as const };
    restrictMcpPermission(policies, denied);
    restrictMcpPermission(policies, allowed);
    restrictMcpPermission(policies, forbidden);
    expect([denied.effect, allowed.effect, forbidden.effect]).toEqual(["deny", "ask", "deny"]);
  });

  it("rejects ambiguous server namespaces", () => {
    const server = { headers: {}, type: "streamable-http" as const, url: "https://example.com" };
    expect(() => mcpPolicies([plugin({ docs: server, docs_other: server })])).toThrow(
      "namespace collision",
    );
  });

  it("a rejected override removes the earlier working definition", async () => {
    const reports: unknown[] = [];
    expect(
      await discoverVendorServers(
        {
          declared: [
            { docs: { url: "https://example.com" } },
            { docs: { enabled_tools: ["unsafe/name"], url: "https://example.com" } },
          ],
          declaredReplacesDefaults: false,
          defaults: [],
        },
        ctx,
        (report) => {
          reports.push(report);
        },
      ),
    ).toEqual({});
    expect(reports).toHaveLength(1);
  });

  it("bundle archives fail explicitly without extraction or execution", async () => {
    const reports: unknown[] = [];
    expect(
      await discoverVendorServers(
        { declared: "./server.mcpb", declaredReplacesDefaults: false, defaults: [] },
        ctx,
        (report) => {
          reports.push(report);
        },
      ),
    ).toEqual({});
    expect(reports).toEqual([
      {
        message:
          'unsupported mcpServers entry "./server.mcpb"; .mcpb/.dxt archives require validated extraction and user configuration outside the loader; extract with a trusted bundle installer and declare a reviewed .json stdio definition',
        severity: "error",
        source: "plugin.json#mcpServers",
      },
    ]);
  });
});
