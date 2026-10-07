import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Plugin } from "@opencode/plugin";
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
import { describe, expect, it, vi } from "vitest";

import { registerManagerTool } from "#src/runtime/manager-tool.ts";

import { manifest } from "./fixture.ts";

const harness = () => {
  let definition: Info | undefined;
  const toolDispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const get = vi.fn<Plugin.Context["session"]["get"]>();
  const questionExecute = vi
    .fn<Info["execute"]>()
    .mockResolvedValue({ output: { answers: [["Reject"]] } });
  const list = vi.fn<Plugin.Context["tool"]["list"]>().mockResolvedValue([]);
  const transform = vi.fn(async (edit: (editor: ToolEditor) => void) => {
    await Promise.resolve();
    edit({
      add: (tool: Info) => {
        definition = tool;
      },
      get: vi.fn<ToolEditor["get"]>(),
      list: () => [],
      namespace: vi.fn<ToolEditor["namespace"]>(),
      remove: vi.fn<ToolEditor["remove"]>(),
      update: vi.fn<ToolEditor["update"]>(),
    });
    return { dispose: toolDispose };
  });
  const ctx = {
    session: { get },
    tool: { list, transform },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixture supplies only the plugin methods used by registration
  } as unknown as Plugin.Context;
  const tool = () => {
    if (definition === undefined) {
      throw new Error("Tool was not registered");
    }
    return definition;
  };
  const invoke = async (input: unknown, signal = new AbortController().signal) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixed test identifier has the SDK branded string shape
    const context = { sessionID: "ses_manager_tool", signal } as ToolContext;
    const result = await tool().execute(input, context);
    if (typeof result.content !== "string") {
      throw new TypeError("Expected JSON text");
    }
    return result.content;
  };
  const useQuestion = () => {
    list.mockResolvedValue([
      {
        description: "Native question",
        execute: questionExecute,
        id: "question",
        input: { type: "object" },
        name: "question",
      },
    ]);
  };
  return {
    ctx,
    get,
    invoke,
    list,
    questionExecute,
    tool,
    toolDispose,
    transform,
    useQuestion,
  };
};

describe("manager tool approval boundary", () => {
  it("retains the deny-filter permission and a closed input schema", async () => {
    const native = harness();
    await registerManagerTool(native.ctx);
    expect(native.tool().name).toBe("agent_plugins_manage");
    expect(native.tool().options).toEqual({ codemode: true, permission: "agent_plugins_manage" });
    expect(native.tool().input).toEqual({
      additionalProperties: false,
      properties: {
        action: {
          enum: ["install", "update", "list", "info", "enable", "disable", "uninstall", "doctor"],
          type: "string",
        },
        all: { type: "boolean" },
        global: { type: "boolean" },
        name: { type: "string" },
        ref: { type: "string" },
        source: { type: "string" },
        subdir: { type: "string" },
      },
      required: ["action"],
      type: "object",
    });
  });

  it.each([
    { action: "install", source: "-source with spaces" },
    { action: "update", name: "demo" },
    { action: "update", all: true },
    { action: "list" },
    { action: "info", name: "demo" },
    { action: "enable", name: "demo" },
    { action: "disable", name: "demo" },
    { action: "uninstall", name: "demo" },
    { action: "doctor" },
    { action: "install", global: true, source: "source" },
  ])("fails closed for valid operations before lookup under allow policy (%j)", async (input) => {
    const native = harness();
    await registerManagerTool(native.ctx);
    expect(JSON.parse(await native.invoke(input))).toEqual({
      error:
        "Package management was not approved or the native question tool is unavailable. Ask the user to run /agent-plugins-manage instead.",
      exitCode: 1,
    });
    expect(native.get).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    [],
    "list",
    {},
    { action: "remove", name: "demo" },
    { action: "list", project: "secret" },
    { action: "list", approved: true },
    { action: "list", global: "true" },
    { action: "install", source: 1 },
    { action: "install", source: "" },
    { action: "install", name: "demo", source: "x" },
    { action: "info", name: "demo", source: "secret" },
    { action: "list", name: "demo" },
    { action: "doctor", source: "secret" },
    { action: "list", all: false },
    { action: "list", ref: "secret" },
    { action: "update", name: "demo", subdir: "secret" },
    { action: "update", all: true, name: "demo" },
    { action: "update" },
    { action: "info" },
    { action: "install" },
    { action: "info", name: "--global" },
    { action: "list", ref: undefined },
    { action: "update", all: "true" },
    { action: "install", source: "https://user:secret@example.com/repo" },
    { action: "install", source: "folder\nsecret" },
    { action: "install", source: "x".repeat(4097) },
  ])("rejects invalid input without echoing it or looking up sessions (%j)", async (input) => {
    const native = harness();
    await registerManagerTool(native.ctx);
    const output = await native.invoke(input);
    expect(JSON.parse(output)).toMatchObject({ exitCode: 1 });
    expect(output).not.toContain("secret");
    expect(output).not.toContain("SDK cannot request");
    expect(native.get).not.toHaveBeenCalled();
    expect(native.list).not.toHaveBeenCalled();
  });

  it("blocks direct executor invocation even under deny policy", async () => {
    const native = harness();
    await registerManagerTool(native.ctx);
    expect(JSON.parse(await native.invoke({ action: "list" }))).toMatchObject({ exitCode: 1 });
    expect(native.get).not.toHaveBeenCalled();
  });

  it("handles aborted invocations without echoing their reason", async () => {
    const native = harness();
    await registerManagerTool(native.ctx);
    const controller = new AbortController();
    controller.abort(new Error("secret abort reason"));
    const output = await native.invoke({ action: "list" }, controller.signal);
    expect(JSON.parse(output)).toMatchObject({ exitCode: 1 });
    expect(output).not.toContain("secret abort reason");
    expect(native.get).not.toHaveBeenCalled();
    expect(native.list).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { answers: [] },
    { answers: [["Reject"]] },
    { answers: [["Approve once", "Reject"]] },
    { answers: [["Approve once"], ["Approve once"]] },
    { answers: "Approve once" },
  ])("requires an exact single structured approval (%j)", async (output) => {
    const native = harness();
    native.useQuestion();
    native.questionExecute.mockResolvedValue({ content: "Approve once", output });
    await registerManagerTool(native.ctx);
    expect(JSON.parse(await native.invoke({ action: "list" }))).toMatchObject({ exitCode: 1 });
    expect(native.questionExecute).toHaveBeenCalledOnce();
    expect(native.get).not.toHaveBeenCalled();
  });

  it("waits for the native question reply before lookup and installation, and asks again for reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tool-approval-"));
    try {
      const source = path.join(root, "-source with spaces");
      await mkdir(source);
      await writeFile(path.join(source, "plugin.json"), manifest());
      const native = harness();
      native.useQuestion();
      const pending = Promise.withResolvers<Awaited<ReturnType<Info["execute"]>>>();
      native.questionExecute.mockImplementationOnce(async () => pending.promise);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- session fixture supplies the location used by this executor
      native.get.mockResolvedValue({ location: { directory: root } } as Awaited<
        ReturnType<Plugin.Context["session"]["get"]>
      >);
      await registerManagerTool(native.ctx);
      const invocation = native.invoke({ action: "install", source: "-source with spaces" });
      await vi.waitFor(() => {
        expect(native.questionExecute).toHaveBeenCalledOnce();
      });
      expect(native.get).not.toHaveBeenCalled();
      await expect(access(path.join(root, ".opencode"))).rejects.toThrow();
      pending.resolve({ output: { answers: [["Approve"]] } });
      expect(JSON.parse(await invocation)).toMatchObject({
        command: "install",
        exitCode: 0,
        scope: "project",
      });
      expect(
        await readFile(path.join(root, ".opencode/agent-plugins/demo/plugin.json"), "utf8"),
      ).toBe(manifest());
      const [call] = native.questionExecute.mock.calls;
      expect(call?.[0]).toMatchObject({ questions: [{ multiple: false }] });
      expect(call?.[1].sessionID).toBe("ses_manager_tool");
      const read = await native.invoke({ action: "list" });
      expect(JSON.parse(read)).toMatchObject({ exitCode: 1 });
      expect(native.questionExecute).toHaveBeenCalledTimes(2);
      expect(native.get).toHaveBeenCalledOnce();
      const payload = path.join(root, ".opencode/agent-plugins/demo/plugin.json");
      await writeFile(payload, `${manifest()}\n`);
      native.questionExecute.mockResolvedValue({ output: { answers: [["Approve"]] } });
      const edited = await native.invoke({ action: "uninstall", name: "demo" });
      expect(JSON.parse(edited)).toMatchObject({ exitCode: 1 });
      expect(edited).toContain("local edits");
      expect(await readFile(payload, "utf8")).toBe(`${manifest()}\n`);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails closed when the native question denies, dismisses or fails", async () => {
    const native = harness();
    native.useQuestion();
    native.questionExecute.mockRejectedValue(new Error("Permission denied: question secret"));
    await registerManagerTool(native.ctx);
    const result = await native.invoke({ action: "list" });
    expect(JSON.parse(result)).toMatchObject({ exitCode: 1 });
    expect(result).not.toContain("secret");
    expect(native.get).not.toHaveBeenCalled();
  });

  it("checks cancellation after approval before any lookup", async () => {
    const native = harness();
    native.useQuestion();
    const controller = new AbortController();
    native.questionExecute.mockImplementationOnce(async () => {
      await Promise.resolve();
      controller.abort();
      return { output: { answers: [["Approve"]] } };
    });
    await registerManagerTool(native.ctx);
    expect(JSON.parse(await native.invoke({ action: "list" }, controller.signal))).toMatchObject({
      exitCode: 1,
    });
    expect(native.get).not.toHaveBeenCalled();
  });

  it("disposes registrations once even if one cleanup fails", async () => {
    const native = harness();
    const registration = await registerManagerTool(native.ctx);
    native.toolDispose.mockRejectedValueOnce(new Error("cleanup failure"));
    await registration.dispose();
    await registration.dispose();
    expect(native.toolDispose).toHaveBeenCalledOnce();
  });

  it("unwinds partial setup without masking its error", async () => {
    const native = harness();
    native.transform.mockRejectedValueOnce(new Error("registration failure"));
    await expect(registerManagerTool(native.ctx)).rejects.toThrow("registration failure");
    expect(native.toolDispose).not.toHaveBeenCalled();
  });
});
