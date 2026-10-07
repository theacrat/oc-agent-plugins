import type { Plugin } from "@opencode/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
import { describe, expect, it, vi } from "vitest";

import { registerManagerTool } from "#src/runtime/manager-tool.ts";

const harness = () => {
  let definition: Info | undefined;
  let evaluate: ((event: PermissionEvaluation) => void) | undefined;
  const permissionDispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const toolDispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const get = vi.fn<Plugin.Context["session"]["get"]>();
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
  const hook = vi.fn(async (name: string, handler: (event: PermissionEvaluation) => void) => {
    await Promise.resolve();
    expect(name).toBe("evaluate");
    evaluate = handler;
    return { dispose: permissionDispose };
  });
  const ctx = {
    permission: { hook },
    session: { get },
    tool: { transform },
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
  const decision = (effect: PermissionEvaluation["effect"], action = "agent_plugins_manage") => {
    const event: PermissionEvaluation = {
      action,
      effect,
      message: "Existing policy",
      resources: [],
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixed test identifier has the SDK branded string shape
      sessionID: "ses_manager_tool" as PermissionEvaluation["sessionID"],
    };
    if (evaluate === undefined) {
      throw new Error("Hook was not registered");
    }
    evaluate(event);
    return event;
  };
  return { ctx, decision, get, invoke, permissionDispose, tool, toolDispose, transform };
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
    expect(native.decision("allow").effect).toBe("ask");
    expect(native.decision("ask")).toMatchObject({ effect: "ask", message: "Existing policy" });
    expect(native.decision("deny")).toMatchObject({ effect: "deny", message: "Existing policy" });
    expect(native.decision("allow", "edit")).toMatchObject({
      effect: "allow",
      message: "Existing policy",
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
    expect(native.decision("allow").effect).toBe("ask");
    expect(JSON.parse(await native.invoke(input))).toEqual({
      error:
        "Agent package management is unavailable because this OpenCode plugin SDK cannot request user approval. Ask the user to run /agent-plugins-manage with the desired action and scope.",
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
  ])("rejects invalid input without echoing it or looking up sessions (%j)", async (input) => {
    const native = harness();
    await registerManagerTool(native.ctx);
    const output = await native.invoke(input);
    expect(JSON.parse(output)).toMatchObject({ exitCode: 1 });
    expect(output).not.toContain("secret");
    expect(output).not.toContain("SDK cannot request");
    expect(native.get).not.toHaveBeenCalled();
  });

  it("blocks direct executor invocation even under deny policy", async () => {
    const native = harness();
    await registerManagerTool(native.ctx);
    expect(native.decision("deny").effect).toBe("deny");
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
  });

  it("disposes registrations once even if one cleanup fails", async () => {
    const native = harness();
    const registration = await registerManagerTool(native.ctx);
    native.toolDispose.mockRejectedValueOnce(new Error("cleanup failure"));
    await registration.dispose();
    await registration.dispose();
    expect(native.toolDispose).toHaveBeenCalledOnce();
    expect(native.permissionDispose).toHaveBeenCalledOnce();
  });

  it("unwinds partial setup without masking its error", async () => {
    const native = harness();
    native.transform.mockRejectedValueOnce(new Error("registration failure"));
    native.permissionDispose.mockRejectedValueOnce(new Error("cleanup failure"));
    await expect(registerManagerTool(native.ctx)).rejects.toThrow("registration failure");
    expect(native.permissionDispose).toHaveBeenCalledOnce();
    expect(native.toolDispose).not.toHaveBeenCalled();
  });
});
