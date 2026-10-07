import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runHookProcess } from "#src/runtime/hook-process.ts";
import {
  decodeHookOutput,
  nativeInput,
  redactHookContext,
  registerHooks,
  vendorInput,
  vendorTool,
} from "#src/runtime/hooks.ts";
import type { HooksContext } from "#src/runtime/hooks.ts";
import type { Diagnostic } from "#src/types.ts";
import { hookMatcher, loadHooks, parseHooks } from "#src/vendor/hooks.ts";
import type { PluginHook } from "#src/vendor/hooks.ts";

const roots: string[] = [];
const fixture = async () => {
  const root = await mkdtemp("/tmp/opencode/hooks-test-");
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});
const hook: PluginHook = {
  args: [],
  command: "cat",
  event: "PreToolUse",
  failClosed: false,
  format: "claude",
  phase: "before",
  root: "/tmp/opencode",
  source: "test",
  timeout: 1000,
};

describe("vendor hooks", () => {
  it("parses disabled command hooks but emits opt-in diagnostics and exact blockers", () => {
    const diagnostics: Diagnostic[] = [];
    const hooks = parseHooks(
      hook.root,
      "claude",
      {
        hooks: {
          PermissionRequest: [],
          PreToolUse: [{ hooks: [{ args: [], command: "cat", type: "command" }], matcher: "Bash" }],
          Stop: [],
        },
      },
      "test",
      {
        report: (item) => {
          diagnostics.push(item);
        },
      },
    );
    expect(hooks).toHaveLength(1);
    expect(diagnostics.map((item) => item.message).join("\n")).toMatch(/execution disabled/u);
    expect(diagnostics.map((item) => item.message).join("\n")).toMatch(
      /lacks the vendor tool input/u,
    );
  });
  it("rejects unknown types, async semantics, invalid regex and cross-vendor events", () => {
    const diagnostics: Diagnostic[] = [];
    const hooks = parseHooks(
      hook.root,
      "claude",
      {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { prompt: "ok", type: "prompt" },
                { async: true, command: "cat", type: "command" },
              ],
            },
            { hooks: [{ command: "cat", type: "command" }], matcher: "[" },
          ],
          preToolUse: [],
        },
      },
      "test",
      {
        report: (item) => {
          diagnostics.push(item);
        },
      },
    );
    expect(hooks).toEqual([]);
    expect(diagnostics).toHaveLength(4);
  });
  it("loads fixed and inline Claude sources and rejects escaping symlinks", async () => {
    const root = await fixture();
    const outside = await fixture();
    await mkdir(path.join(root, "hooks"));
    const raw = { hooks: { PostToolUse: [{ hooks: [{ command: "true", type: "command" }] }] } };
    await writeFile(path.join(root, "hooks/hooks.json"), JSON.stringify(raw));
    const diagnostics: Diagnostic[] = [];
    const options = { report: (item: Diagnostic) => diagnostics.push(item) };
    expect(await loadHooks(root, "claude", { hooks: raw }, options)).toHaveLength(2);
    await writeFile(path.join(outside, "escape.json"), JSON.stringify(raw));
    await symlink(path.join(outside, "escape.json"), path.join(root, "escape.json"));
    expect(await loadHooks(root, "codex", { hooks: "./escape.json" }, options)).toEqual([]);
    expect(diagnostics.at(-1)?.message).toMatch(/escapes/u);
  });
  it("uses Codex declared sources instead of defaults and Cursor flat arrays", async () => {
    const root = await fixture();
    const options = {
      enabled: true,
      report: () => {
        // Intentionally ignored; completion is handled separately.
      },
    };
    expect(
      await loadHooks(
        root,
        "codex",
        { hooks: [{ hooks: { PreToolUse: [{ hooks: [{ command: "true", type: "command" }] }] } }] },
        options,
      ),
    ).toHaveLength(1);
    expect(
      parseHooks(
        root,
        "cursor",
        { hooks: { preToolUse: [{ command: "true", matcher: "Shell" }] }, version: 1 },
        "test",
        options,
      ),
    ).toHaveLength(1);
  });
  it("preserves exact Claude matchers versus Cursor/Codex regex", () => {
    expect(hookMatcher({ format: "claude", matcher: "Edit|Write" }, "NotebookEdit")).toBe(false);
    expect(hookMatcher({ format: "codex", matcher: "Edit|Write" }, "NotebookEdit")).toBe(true);
    expect(hookMatcher({ format: "cursor", matcher: "^Shell$" }, "Shell")).toBe(true);
  });
  it("round trips native tool input names", () => {
    const input = { filePath: "x", newString: "b", oldString: "a", replaceAll: true };
    expect(vendorInput(input)).toEqual({
      file_path: "x",
      new_string: "b",
      old_string: "a",
      replace_all: true,
    });
    expect(nativeInput(vendorInput(input))).toEqual(input);
    expect(vendorTool("cursor", "bash")).toBe("Shell");
    expect(vendorTool("claude", "shell")).toBe("Bash");
    expect(vendorTool("cursor", "shell")).toBe("Shell");
    expect(vendorTool("claude", "subagent")).toBe("Task");
    expect(vendorTool("codex", "subagent")).toBe("Agent");
    expect(vendorTool("codex", "patch")).toBe("apply_patch");
  });
});

describe("hook decisions and processes", () => {
  it("redacts overlapping secret values before model text", () => {
    expect(redactHookContext("token-long token", ["token", "token-long"])).toBe(
      "[redacted] [redacted]",
    );
  });
  it("registers inert hooks, reads current hooks on reload and disposes registrations", async () => {
    const callbacks = new Map<string, (event: unknown) => unknown>();
    let disposed = 0;
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Test double for public callback registration.
    const register = (name: string, callback: (event: unknown) => unknown) => {
      callbacks.set(name, callback);
      return {
        dispose: () => {
          disposed += 1;
        },
      };
    };
    // Generic hook overloads are erased only in this test mock; production is checked against 2.0.24.
    const mock = {
      location: { directory: "/tmp/opencode" },
      session: { hook: register },
      tool: { hook: register },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Minimal test double erases generic overloads only here.
    const ctx = mock as unknown as HooksContext;
    const { args: ignored, ...shellHook } = hook;
    expect(ignored).toEqual([]);
    let current: PluginHook[] = [{ ...shellHook, command: "exit 2" }];
    let enabled = false;
    const cleanup = await registerHooks(ctx, () => current, {
      enabled: () => enabled,
      report: () => {
        // Diagnostics are tested separately.
      },
      secretValues: () => ["private-hook-token"],
    });
    const event = { id: "call", input: { command: "true" }, sessionID: "session", tool: "shell" };
    await callbacks.get("execute.before")?.(event);
    enabled = true;
    await expect(callbacks.get("execute.before")?.(event)).rejects.toThrow(/denied/u);
    for (const matcher of ["Task", "Agent"]) {
      current = [{ ...shellHook, command: "exit 2", matcher }];
      // oxlint-disable-next-line eslint/no-await-in-loop -- Mutate the hot-reload fixture only after the previous invocation completes.
      await expect(
        callbacks.get("execute.before")?.({ ...event, tool: "subagent" }),
      ).rejects.toThrow(/denied/u);
    }
    current = [{ ...shellHook, command: "exit 2", matcher: "Bash" }];
    await expect(callbacks.get("execute.before")?.(event)).rejects.toThrow(/denied/u);
    for (const output of [
      "invalid",
      '{"hookSpecificOutput":false}',
      '{"continue":"false"}',
      '{"permission":"deny"}',
      '{"hookSpecificOutput":{"permissionDecision":"ask"}}',
    ]) {
      current = [{ ...shellHook, args: ["%s", output], command: "printf", matcher: "Bash" }];
      // oxlint-disable-next-line eslint/no-await-in-loop -- Mutate the hot-reload fixture only after the previous invocation completes.
      await expect(callbacks.get("execute.before")?.(event)).rejects.toThrow(/failed closed/u);
    }
    current = [{ ...shellHook, command: "exit 2", matcher: "Edit" }];
    await expect(callbacks.get("execute.before")?.({ ...event, tool: "patch" })).rejects.toThrow(
      /failed closed/u,
    );
    current = [
      {
        ...shellHook,
        args: ["%s", '{"hookSpecificOutput":{"additionalContext":"private-hook-token"}}'],
        command: "printf",
        matcher: "Bash",
      },
    ];
    await callbacks.get("execute.before")?.(event);
    const context = { sessionID: "session", system: [] };
    await callbacks.get("context")?.(context);
    expect(context.system).toEqual([{ text: "[redacted]", type: "text" }]);
    current = [];
    await callbacks.get("execute.before")?.(event);
    await cleanup();
    expect(disposed).toBe(4);
  });
  it("translates deny and updatedInput without converting allow into host approval", () => {
    expect(
      decodeHookOutput(hook, '{"hookSpecificOutput":{"permissionDecision":"deny"}}', 0).deny,
    ).toBe(true);
    expect(
      decodeHookOutput(
        hook,
        '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"file_path":"x"},"additionalContext":"note"}}',
        0,
      ),
    ).toEqual({ context: "note", deny: false, updatedInput: { file_path: "x" } });
    expect(decodeHookOutput(hook, "", 2).deny).toBe(true);
    expect(() =>
      decodeHookOutput(hook, '{"hookSpecificOutput":{"permissionDecision":"ask"}}', 0),
    ).toThrow(/ask cannot/u);
  });
  it("fails closed on malformed and unsupported security decisions", () => {
    expect(() => decodeHookOutput(hook, "invalid", 0)).toThrow(/JSON/u);
    expect(() => decodeHookOutput({ ...hook, phase: "after" }, '{"decision":"block"}', 0)).toThrow(
      /blocking/u,
    );
    expect(() =>
      decodeHookOutput(hook, '{"hookSpecificOutput":{"updatedPermissions":[]}}', 0),
    ).toThrow(/unsupported/u);
    expect(() => decodeHookOutput({ ...hook, format: "cursor" }, "", 0)).toThrow(/no JSON/u);
    expect(() => decodeHookOutput({ ...hook, failClosed: true }, "", 1)).toThrow(/failed/u);
  });
  it("delivers JSON stdin and exec args without shell evaluation", async () => {
    const result = await runHookProcess(
      hook,
      { session_id: "test" },
      { cwd: hook.root, signal: new AbortController().signal },
    );
    expect(JSON.parse(result.stdout)).toEqual({ session_id: "test" });
    const literal = await runHookProcess(
      { ...hook, args: ["%s", "$(touch nope)"], command: "printf" },
      {},
      { cwd: hook.root, signal: new AbortController().signal },
    );
    expect(literal.stdout).toBe("$(touch nope)");
  });
  it("cancels subprocess groups on timeout and abort", async () => {
    const controller = new AbortController();
    const slow = { ...hook, args: ["10"], command: "sleep", timeout: 20 };
    await expect(
      runHookProcess(slow, {}, { cwd: hook.root, signal: controller.signal }),
    ).rejects.toThrow(/timed out/u);
    controller.abort();
    await expect(
      runHookProcess({ ...slow, timeout: 1000 }, {}, { cwd: hook.root, signal: controller.signal }),
    ).rejects.toThrow(/cancelled/u);
  });
});
