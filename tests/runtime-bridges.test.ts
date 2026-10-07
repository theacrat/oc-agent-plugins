import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { registerMonitors } from "#src/runtime/monitors.ts";
import { exportWorkflow } from "#src/runtime/workflows.ts";
import type { Diagnostic } from "#src/types.ts";
import { loadChannels } from "#src/vendor/channels.ts";
import type { PluginMonitor } from "#src/vendor/monitors.ts";
import { loadMonitors, parseMonitors } from "#src/vendor/monitors.ts";
import { loadRuntimeComponents } from "#src/vendor/runtimes.ts";
import { exportTheme, loadThemes, parseTheme } from "#src/vendor/themes.ts";
import { loadWorkflows, parseWorkflow } from "#src/vendor/workflows.ts";

const ignoreReport = (entry: Diagnostic) => {
  expect(["error", "warning"]).toContain(entry.severity);
};

const roots: string[] = [];
const disposers: (() => Promise<void>)[] = [];
const temporary = async () => {
  const root = await mkdtemp("/tmp/opencode/bridges-");
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(disposers.splice(0).map(async (dispose) => dispose()));
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

const monitor = {
  command: "printf hello",
  description: "Watch status",
  name: "watch",
  when: "always" as const,
};
const shellVariable = (name: string) => `\${${name}-unset}`;
const workflow =
  "export const meta = { name: 'audit', description: 'Audit routes', phases: ['Read', 'Check'], }\nconst found = await agent('Read');\nreturn found;";

describe("runtime discovery", () => {
  it("provides a single loader with explicit workflow and theme diagnostics", async () => {
    const root = await temporary();
    await mkdir(path.join(root, "workflows"));
    await writeFile(path.join(root, "workflows/audit.js"), workflow);
    const diagnostics: Diagnostic[] = [];
    const result = await loadRuntimeComponents(
      root,
      { experimental: { monitors: [monitor] } },
      (entry) => {
        diagnostics.push(entry);
      },
    );
    expect(result.monitors).toEqual([monitor]);
    expect(result.workflows.map((entry) => entry.name)).toEqual(["audit"]);
    expect(result.channels).toEqual([]);
    expect(diagnostics[0]?.message).toContain("process-isolated");
  });
  it("loads default monitors without executing and preserves start conditions", async () => {
    const root = await temporary();
    await mkdir(path.join(root, "monitors"));
    await writeFile(
      path.join(root, "monitors/monitors.json"),
      JSON.stringify([monitor, { ...monitor, name: "deploy", when: "on-skill-invoke:deploy" }]),
    );
    expect(await loadMonitors(root, {}, ignoreReport)).toEqual([
      monitor,
      { ...monitor, name: "deploy", when: "on-skill-invoke:deploy" },
    ]);
  });
  it("rejects unknown monitor fields, invalid triggers and shell user config", () => {
    const diagnostics: Diagnostic[] = [];
    expect(
      parseMonitors(
        [
          { ...monitor, disabled: true },
          { ...monitor, when: "on-change" },
          { ...monitor, command: `echo \${user_config.secret}` },
        ],
        "fixture",
        (entry) => {
          diagnostics.push(entry);
        },
      ),
    ).toEqual([]);
    expect(diagnostics).toHaveLength(3);
  });
  it("discovers literal workflow metadata without evaluating the body", async () => {
    const root = await temporary();
    await mkdir(path.join(root, "workflows"));
    await writeFile(path.join(root, "workflows/audit.js"), workflow);
    const diagnostics: Diagnostic[] = [];
    const found = await loadWorkflows(root, {}, (entry) => {
      diagnostics.push(entry);
    });
    expect(diagnostics).toEqual([]);
    expect(found[0]).toMatchObject({
      body: "const found = await agent('Read');\nreturn found;",
      description: "Audit routes",
      name: "audit",
      phases: ["Read", "Check"],
    });
    const [first] = found;
    if (first === undefined) {
      throw new Error("workflow not discovered");
    }
    expect(exportWorkflow(first).source).toBe(workflow);
    expect(exportWorkflow(first).unavailable).toContain("schema validation");
    expect(
      parseWorkflow(
        "export const meta = { name: process.exit(), description: 'bad' };",
        "bad",
        ignoreReport,
      ),
    ).toBeUndefined();
    expect(
      parseWorkflow(
        "export const meta = { name: 'broken', description: 'bad', phases: [ }; return 1;",
        "broken",
        ignoreReport,
      ),
    ).toBeUndefined();
  });
  it("rejects symlink escapes for discovery", async () => {
    const root = await temporary();
    const outside = await temporary();
    await writeFile(path.join(outside, "audit.js"), workflow);
    await symlink(outside, path.join(root, "workflows"));
    const diagnostics: Diagnostic[] = [];
    expect(
      await loadWorkflows(root, {}, (entry) => {
        diagnostics.push(entry);
      }),
    ).toEqual([]);
    expect(diagnostics[0]?.message).toContain("outside");
  });
  it("exports validated themes but never claims native UI registration", async () => {
    const root = await temporary();
    await mkdir(path.join(root, "themes"));
    const value = {
      base: "dark",
      name: "Dracula",
      overrides: { claude: "#bd93f9", error: "#ff5555" },
    };
    await writeFile(path.join(root, "themes/dracula.json"), JSON.stringify(value));
    const found = await loadThemes(root, {}, ignoreReport);
    const [first] = found;
    if (first === undefined) {
      throw new Error("theme not discovered");
    }
    expect(exportTheme(first).theme).toEqual(value);
    expect(exportTheme(first).unavailable).toContain("CLI");
    expect(
      parseTheme(
        { ...value, overrides: { error: "url(https://example.com)" } },
        "bad",
        ignoreReport,
      ),
    ).toBeUndefined();
  });
  it("preserves channel declarations and reports precise routing/auth blockers", () => {
    const diagnostics: Diagnostic[] = [];
    expect(
      loadChannels(
        { channels: [{ server: "telegram", userConfig: { token: { sensitive: true } } }] },
        (entry) => {
          diagnostics.push(entry);
        },
      ),
    ).toEqual([
      { displayName: "telegram", server: "telegram", userConfig: { token: { sensitive: true } } },
    ]);
    expect(diagnostics[0]?.message).toContain("authenticated sender allowlists");
    expect(
      loadChannels({ channels: [{ endpoint: "/invented", server: "telegram" }] }, ignoreReport),
    ).toEqual([]);
  });
});

const setup = async (
  overrides: Partial<Parameters<typeof registerMonitors>[1]> = {},
  definitions: readonly PluginMonitor[] = [monitor],
) => {
  const root = await temporary();
  const diagnostics: Diagnostic[] = [];
  const outputs: string[] = [];
  const bridge = registerMonitors(definitions, {
    cwd: root,
    env: {},
    interactive: true,
    notify: (session, name, text) => {
      outputs.push(`${session}/${name}:${text}`);
    },
    report: (entry) => {
      diagnostics.push(entry);
    },
    trusted: true,
    ...overrides,
  });
  disposers.push(bridge.dispose);
  return { bridge, diagnostics, outputs, root };
};
describe("trusted monitor lifecycle", () => {
  it("passes only explicit environment values and strips plugin option secrets", async () => {
    const { bridge, outputs } = await setup(
      { env: { CLAUDE_PLUGIN_OPTION_TOKEN: "secret", SAFE: "visible" } },
      [
        {
          ...monitor,
          command: `printf "%s|%s|%s" "$SAFE" "${shellVariable("CLAUDE_PLUGIN_OPTION_TOKEN")}" "${shellVariable("HOME")}"`,
        },
      ],
    );
    bridge.startSession("one");
    await expect.poll(() => outputs.join("")).toBe("one/watch:visible|unset|unset");
    await expect.poll(() => bridge.active()).toBe(0);
  });
  it("stops an infinite process if notification delivery fails", async () => {
    const { bridge, diagnostics } = await setup(
      {
        notify: () => {
          throw new Error("delivery failed");
        },
        stopGraceMs: 20,
      },
      [{ ...monitor, command: "while true; do printf output; done" }],
    );
    bridge.startSession("one");
    await expect.poll(() => bridge.active()).toBe(0);
    expect(diagnostics.map((entry) => entry.message)).toContain(
      "monitor notification failed: delivery failed",
    );
  });
  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])("rejects invalid limits %s", async (limit) => {
    await expect(setup({ maxOutputBytes: limit })).rejects.toThrow(
      "monitor limits must be positive integers",
    );
  });
  it("does not run when trust is omitted", async () => {
    const root = await temporary();
    const bridge = registerMonitors([monitor], {
      cwd: root,
      env: {},
      interactive: true,
      notify: () => {
        throw new Error("untrusted monitor ran");
      },
      report: ignoreReport,
    });
    disposers.push(bridge.dispose);
    bridge.startSession("one");
    expect(bridge.active()).toBe(0);
  });
  it.each([{ trusted: false }, { enabled: false }, { interactive: false }])(
    "does not autorun without trust or when disabled: %j",
    async (options) => {
      const { bridge, outputs } = await setup(options);
      bridge.startSession("session");
      expect(bridge.active()).toBe(0);
      expect(outputs).toEqual([]);
    },
  );
  it("routes output to the owning session and starts skill monitors only once", async () => {
    const { bridge, outputs } = await setup({}, [{ ...monitor, when: "on-skill-invoke:deploy" }]);
    bridge.startSession("one");
    bridge.invokeSkill("one", "other");
    expect(bridge.active()).toBe(0);
    bridge.invokeSkill("one", "deploy");
    bridge.invokeSkill("one", "deploy");
    await expect.poll(() => outputs.join("")).toBe("one/watch:hello");
    await expect.poll(() => bridge.active()).toBe(0);
    bridge.invokeSkill("one", "deploy");
    expect(bridge.active()).toBe(0);
  });
  it("bounds output and stops noisy processes", async () => {
    const { bridge, outputs, diagnostics } = await setup({ maxOutputBytes: 4 }, [
      { ...monitor, command: "while true; do printf 123456789; done" },
    ]);
    bridge.startSession("one");
    await expect.poll(() => bridge.active()).toBe(0);
    expect(outputs.join("")).toBe("one/watch:1234");
    expect(diagnostics.some((entry) => entry.message.includes("output limit"))).toBe(true);
  });
  it("sends TERM and escalates to KILL on cancellation", async () => {
    const controller = new AbortController();
    const { bridge, root, outputs } = await setup({ signal: controller.signal, stopGraceMs: 50 }, [
      {
        ...monitor,
        command:
          "trap 'printf stopped > stopped; trap \"\" TERM' TERM; printf ready; while true; do sleep 1; done",
      },
    ]);
    bridge.startSession("one");
    await expect.poll(() => outputs.join("")).toContain("ready");
    controller.abort();
    await expect.poll(() => bridge.active()).toBe(0);
    expect(await readFile(path.join(root, "stopped"), "utf8")).toBe("stopped");
    bridge.startSession("two");
    expect(bridge.active()).toBe(0);
  });
  it("cleans up session processes and honours process and runtime budgets", async () => {
    const { bridge, diagnostics } = await setup(
      { maxProcesses: 1, maxRuntimeMs: 50, stopGraceMs: 20 },
      [
        { ...monitor, command: "sleep 20" },
        { ...monitor, name: "second" },
      ],
    );
    bridge.startSession("one");
    expect(bridge.active()).toBe(1);
    await expect.poll(() => bridge.active()).toBe(0);
    expect(diagnostics.map((entry) => entry.message)).toEqual([
      "monitor process budget exhausted",
      "monitor runtime limit reached",
    ]);
    bridge.startSession("two");
    await bridge.stopSession("two");
    expect(bridge.active()).toBe(0);
  });
});
