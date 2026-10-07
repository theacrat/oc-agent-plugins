import path from "node:path";

import type { Plugin } from "@opencode/plugin";
import { describe, expect, it, vi } from "vitest";

import { loadAll } from "#src/loader.ts";
import { parseOptions } from "#src/options.ts";
import { registerCompatibility } from "#src/runtime/compatibility.ts";
import type { MonitorOptions } from "#src/runtime/monitors.ts";
import type { Diagnostic } from "#src/types.ts";
import { resolveConfiguration } from "#src/vendor/configuration.ts";
import { parseHooks } from "#src/vendor/hooks.ts";

import { makeTree } from "./fixture.ts";

const monitorOptions = vi.hoisted(() => ({ current: undefined as MonitorOptions | undefined }));
vi.mock("#src/runtime/monitors.ts", () => ({
  registerMonitors: (_monitors: unknown, options: MonitorOptions) => {
    monitorOptions.current = options;
    return {
      active: () => 0,
      dispose: async () => {
        await Promise.resolve();
      },
      invokeSkill: vi.fn(),
      startSession: vi.fn(),
      stopSession: async () => {
        await Promise.resolve();
      },
    };
  },
}));

const secret = "private-token.*[123]$";
const userConfig = {
  token: { description: "Credential", sensitive: true, title: "Token", type: "string" },
};
const configuration = { secure: { userConfig: { token: { env: "TOKEN" } } } };
const unexpected = (value: unknown) => {
  throw new Error(JSON.stringify(value));
};
const register = async () => {
  await Promise.resolve();
  return {
    dispose: async () => {
      await Promise.resolve();
    },
  };
};

describe("review security regressions", () => {
  it("redacts literal secrets without exposing them or reprocessing replacement text", () => {
    const config = resolveConfiguration({
      env: { TOKEN: secret },
      format: "claude",
      manifest: { userConfig },
      options: configuration.secure,
    });
    expect(config.redact(`before ${secret} and ${secret} after`)).toBe(
      "before [REDACTED] and [REDACTED] after",
    );
    expect(config.redact("private-token-not-a-secret")).toBe("private-token-not-a-secret");
    expect(JSON.stringify(config)).not.toContain(secret);
    const overlapping = resolveConfiguration({
      env: { LONG: "[REDACTED]suffix", SHORT: "REDACTED" },
      format: "claude",
      manifest: { userConfig: { long: userConfig.token, short: userConfig.token } },
      options: { userConfig: { long: { env: "LONG" }, short: { env: "SHORT" } } },
    });
    expect(overlapping.redact("[REDACTED]suffix REDACTED")).toBe("[REDACTED] [REDACTED]");
  });

  it("sanitises child-loader diagnostic messages and sources, including scalar MCP declarations", async () => {
    const root = await makeTree({
      ".claude-plugin/plugin.json": JSON.stringify({
        commands: `./${secret}.md`,
        hooks: `./${secret}.json`,
        mcpServers: secret,
        monitors: [{ command: "true", description: "Safe", name: secret, when: "invalid" }],
        name: "secure",
        userConfig,
      }),
    });
    const result = await loadAll([root], {
      configuration,
      dataRoot: path.join(root, "data"),
      env: { TOKEN: secret },
    });
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
    expect(result.diagnostics.some((entry) => entry.message.includes("[REDACTED]"))).toBe(true);
    expect(result.diagnostics.some((entry) => entry.source.includes("[REDACTED]"))).toBe(true);
  });

  it.each(["name", "description", "command", "when"])(
    "rejects known sensitive content in monitor %s",
    async (field) => {
      const monitor = {
        command: "true",
        description: "Safe",
        name: "watch",
        when: "always",
        [field]: field === "when" ? "on-skill-invoke:sensitive-marker" : "sensitive-marker",
      };
      const root = await makeTree({
        ".claude-plugin/plugin.json": JSON.stringify({
          monitors: [monitor],
          name: "secure",
          userConfig,
        }),
      });
      const result = await loadAll([root], {
        configuration,
        dataRoot: path.join(root, "data"),
        env: { TOKEN: "sensitive-marker" },
      });
      expect(result.plugins).toEqual([]);
      expect(JSON.stringify(result.diagnostics)).not.toContain("sensitive-marker");
      expect(result.diagnostics.some((entry) => entry.message.includes("validation failed"))).toBe(
        true,
      );
    },
  );

  it("redacts arbitrary monitor process output before delivering synthetic text", async () => {
    const root = await makeTree({
      ".claude-plugin/plugin.json": JSON.stringify({
        monitors: [{ command: "true", description: "Safe", name: "watch", when: "always" }],
        name: "secure",
        userConfig,
      }),
    });
    const result = await loadAll([root], {
      configuration,
      dataRoot: path.join(root, "data"),
      env: { TOKEN: secret },
    });
    expect(result.plugins).toHaveLength(1);
    const synthetic = vi.fn(async (_input: unknown) => {
      await Promise.resolve();
    });
    const fake = {
      event: {
        async *subscribe() {
          await Promise.resolve();
          yield* [];
        },
      },
      location: { directory: root, project: { directory: root } },
      session: { hook: register, synthetic },
      tool: { hook: register },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Mock only the native surfaces used by compatibility registration.
    const ctx = fake as unknown as Plugin.Context;
    const options = parseOptions(
      {
        dataHome: root,
        home: root,
        project: root,
        raw: { plugins: { secure: { monitors: { trusted: true } } } },
      },
      unexpected,
    );
    const runtime = await registerCompatibility(ctx, options, () => result, unexpected);
    try {
      if (monitorOptions.current === undefined) {
        throw new Error("monitor was not registered");
      }
      monitorOptions.current.notify("session", "watch", `arbitrary output: ${secret}\n${secret}`);
      expect(synthetic).toHaveBeenCalledWith({
        resume: false,
        sessionID: "session",
        text: "Monitor secure:watch\narbitrary output: [REDACTED]\n[REDACTED]",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects Cursor afterShellExecution failClosed before an exit-1 handler can run", () => {
    const diagnostics: Diagnostic[] = [];
    const hooks = parseHooks(
      "/plugin",
      "cursor",
      { hooks: { afterShellExecution: [{ command: "exit 1", failClosed: true }] }, version: 1 },
      "hooks.json",
      {
        enabled: true,
        report: (entry) => {
          diagnostics.push(entry);
        },
      },
    );
    expect(hooks).toEqual([]);
    expect(diagnostics).toEqual([
      {
        message:
          "afterShellExecution: failClosed is only supported for before-tool hooks; handler rejected, not weakened",
        severity: "error",
        source: "hooks.json",
      },
    ]);
  });

  it("rejects post-tool failClosed through normal plugin loading", async () => {
    const root = await makeTree({
      ".cursor-plugin/plugin.json": JSON.stringify({ name: "post" }),
      "hooks/hooks.json": JSON.stringify({
        hooks: { afterShellExecution: [{ command: "exit 1", failClosed: true }] },
        version: 1,
      }),
    });
    const loaded = await loadAll([root], {
      dataRoot: await makeTree({}),
      trustedHooks: ["post"],
    });
    expect(loaded.plugins[0]?.hooks).toEqual([]);
    expect(
      loaded.diagnostics.some((entry) =>
        entry.message.includes("failClosed is only supported for before-tool hooks"),
      ),
    ).toBe(true);
  });

  it.each(["PostToolUse", "PostToolUseFailure", "PreCompact"])(
    "rejects failClosed on the non-blocking %s phase",
    (event) => {
      const diagnostics: Diagnostic[] = [];
      expect(
        parseHooks(
          "/plugin",
          "claude",
          {
            hooks: {
              [event]: [{ hooks: [{ command: "exit 1", failClosed: true, type: "command" }] }],
            },
          },
          "hooks.json",
          {
            enabled: true,
            report: (entry) => {
              diagnostics.push(entry);
            },
          },
        ),
      ).toEqual([]);
      expect(diagnostics[0]?.message).toBe(
        `${event}: failClosed is only supported for before-tool hooks; handler rejected, not weakened`,
      );
    },
  );
});
