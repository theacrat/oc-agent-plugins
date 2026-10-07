import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Plugin } from "@opencode/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerManagerTool } from "#src/runtime/manager-tool.ts";

import { manifest } from "./fixture.ts";

const roots: string[] = [];
const temporary = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "manager-tool-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

const harness = (directory: string) => {
  let definition: Info | undefined;
  let evaluate: ((event: PermissionEvaluation) => void) | undefined;
  const permissionDispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const toolDispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const get = vi.fn(async (_input: Parameters<Plugin.Context["session"]["get"]>[0]) => {
    await Promise.resolve();
    return { location: { directory } };
  });
  const transform = vi.fn(async (edit: (editor: ToolEditor) => void) => {
    await Promise.resolve();
    const editor: ToolEditor = {
      add: (tool: Info) => {
        definition = tool;
      },
      get: vi.fn<ToolEditor["get"]>(),
      list: () => [],
      namespace: vi.fn<ToolEditor["namespace"]>(),
      remove: vi.fn<ToolEditor["remove"]>(),
      update: vi.fn<ToolEditor["update"]>(),
    };
    edit(editor);
    return { dispose: toolDispose };
  });
  const hook = vi.fn(async (name: string, handler: (event: PermissionEvaluation) => void) => {
    await Promise.resolve();
    expect(name).toBe("evaluate");
    evaluate = handler;
    return { dispose: permissionDispose };
  });
  const ctx = {
    location: { directory: path.join(directory, "wrong") },
    permission: { hook },
    session: { get },
    tool: { transform },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- unrelated SDK context methods and session fields are not used by the tool
  } as unknown as Plugin.Context;
  const tool = () => {
    if (definition === undefined) {
      throw new Error("Tool was not registered");
    }
    return definition;
  };
  const invoke = async (input: unknown, signal = new AbortController().signal) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- executor fixture supplies the session ID and signal it uses, without unrelated SDK fields
    const context = { sessionID: "ses_manager_tool", signal } as ToolContext;
    const result = await tool().execute(input, context);
    expect(typeof result.content).toBe("string");
    if (typeof result.content !== "string") {
      throw new TypeError("Expected JSON text");
    }
    return result.content;
  };
  const decision = (action: string, effect: PermissionEvaluation["effect"]) => {
    const event: PermissionEvaluation = {
      action,
      effect,
      message: "Existing policy",
      resources: [],
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixed test session identifier has the SDK branded string shape
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

describe("manager tool", () => {
  it("registers a closed structured schema and native permission for every action", async () => {
    const native = harness(await temporary());
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
    const allowed = native.decision("agent_plugins_manage", "allow");
    expect(allowed.effect).toBe("ask");
    expect(allowed.message).toContain("including reads");
    for (const effect of ["ask", "deny"] as const) {
      expect(native.decision("agent_plugins_manage", effect)).toMatchObject({
        effect,
        message: "Existing policy",
      });
    }
    expect(native.decision("edit", "allow")).toMatchObject({
      effect: "allow",
      message: "Existing policy",
    });
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
  ])("rejects invalid input before session lookup or filesystem changes (%j)", async (input) => {
    const root = await temporary();
    const native = harness(root);
    await registerManagerTool(native.ctx);
    const output: unknown = JSON.parse(await native.invoke(input));
    expect(output).toMatchObject({ exitCode: 1 });
    expect(output).toHaveProperty("error");
    expect(native.get).not.toHaveBeenCalled();
    await expect(access(path.join(root, ".opencode"))).rejects.toThrow();
  });

  it("uses the invoking session for local sources, preserves spaces and runs the package lifecycle", async () => {
    const root = await temporary();
    const project = path.join(root, "session project");
    const source = path.join(project, '-source "quoted" with spaces');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "plugin.json"), manifest());
    await writeFile(path.join(source, "README.md"), "Original");
    const native = harness(project);
    await registerManagerTool(native.ctx);
    const installed = path.join(project, ".opencode/agent-plugins/demo/README.md");
    const relativeSource = path.basename(source);
    expect(
      JSON.parse(await native.invoke({ action: "install", source: relativeSource })),
    ).toMatchObject({
      command: "install",
      exitCode: 0,
      root: path.join(project, ".opencode/agent-plugins"),
      scope: "project",
    });
    expect(native.get).toHaveBeenCalledWith({ sessionID: "ses_manager_tool" });
    expect(await readFile(installed, "utf8")).toBe("Original");
    await expect(access(path.join(project, "wrong/.opencode"))).rejects.toThrow();
    expect(JSON.parse(await native.invoke({ action: "disable", name: "demo" }))).toMatchObject({
      entries: [{ enabled: false }],
    });
    await writeFile(path.join(source, "README.md"), "Updated");
    expect(JSON.parse(await native.invoke({ action: "update", all: true }))).toMatchObject({
      entries: [{ enabled: false }],
      exitCode: 0,
    });
    expect(JSON.parse(await native.invoke({ action: "enable", name: "demo" }))).toMatchObject({
      entries: [{ enabled: true }],
    });
    expect(await readFile(installed, "utf8")).toBe("Updated");
    expect(JSON.parse(await native.invoke({ action: "info", name: "demo" }))).toMatchObject({
      entries: [{ name: "demo" }],
    });
    expect(JSON.parse(await native.invoke({ action: "update", name: "demo" }))).toMatchObject({
      exitCode: 0,
    });
    await writeFile(installed, "User edit");
    expect(JSON.parse(await native.invoke({ action: "uninstall", name: "demo" }))).toMatchObject({
      error:
        "Installation has local edits or is unmanaged. Preserve local work and inspect it before retrying; retained staging data must not be deleted blindly.",
      exitCode: 1,
    });
    expect(JSON.parse(await native.invoke({ action: "doctor" }))).toMatchObject({ exitCode: 1 });
    expect(await readFile(installed, "utf8")).toBe("User edit");
    await writeFile(installed, "Updated");
    expect(JSON.parse(await native.invoke({ action: "uninstall", name: "demo" }))).toMatchObject({
      exitCode: 0,
    });
    expect(JSON.parse(await native.invoke({ action: "list" }))).toMatchObject({ entries: [] });
  });

  it("honours global config overrides while resolving sources from the session", async () => {
    const root = await temporary();
    vi.stubEnv("OPENCODE_CONFIG_DIR", path.join(root, "global"));
    const source = path.join(root, "-source");
    await mkdir(source);
    await writeFile(path.join(source, "plugin.json"), manifest());
    const native = harness(root);
    await registerManagerTool(native.ctx);
    expect(
      JSON.parse(await native.invoke({ action: "install", global: true, source: "-source" })),
    ).toMatchObject({
      exitCode: 0,
      root: path.join(root, "global/agent-plugins"),
      scope: "global",
    });
    expect(await readFile(path.join(root, "global/agent-plugins/demo/plugin.json"), "utf8")).toBe(
      manifest(),
    );
    await expect(access(path.join(root, ".opencode"))).rejects.toThrow();
  });

  it("returns safe JSON for SDK and source errors without exposing secrets", async () => {
    const native = harness(await temporary());
    await registerManagerTool(native.ctx);
    native.get.mockRejectedValueOnce(new Error("SDK credential-secret-body"));
    const sdk = await native.invoke({ action: "list" });
    expect(JSON.parse(sdk)).toEqual({
      error: "Unable to read the invoking session location. Retry when the session is available.",
      exitCode: 1,
    });
    expect(sdk).not.toContain("credential-secret-body");
    const source = await native.invoke({
      action: "install",
      source: "https://user:credential-secret-body@example.com/repo",
    });
    expect(JSON.parse(source)).toMatchObject({ exitCode: 1 });
    expect(source).not.toContain("credential-secret-body");
    expect(source).not.toContain("example.com");
    expect(JSON.parse(await native.invoke({ action: "info", name: "absent" }))).toEqual({
      error: 'Plugin "absent" is not installed in this scope',
      exitCode: 1,
    });
  });

  it("checks cancellation before lookup and again before dispatch", async () => {
    const root = await temporary();
    const native = harness(root);
    await registerManagerTool(native.ctx);
    const before = new AbortController();
    before.abort(new Error("secret abort reason"));
    const output = await native.invoke({ action: "list" }, before.signal);
    expect(JSON.parse(output)).toMatchObject({ exitCode: 1 });
    expect(output).not.toContain("secret abort reason");
    expect(native.get).not.toHaveBeenCalled();
    const during = new AbortController();
    native.get.mockImplementationOnce(async () => {
      await Promise.resolve();
      during.abort();
      return { location: { directory: root } };
    });
    expect(
      JSON.parse(await native.invoke({ action: "install", source: "missing" }, during.signal)),
    ).toMatchObject({ exitCode: 1 });
    expect(native.get).toHaveBeenCalledOnce();
    await expect(access(path.join(root, ".opencode"))).rejects.toThrow();
  });

  it("disposes registrations once, even if one cleanup fails", async () => {
    const native = harness(await temporary());
    const registration = await registerManagerTool(native.ctx);
    native.toolDispose.mockRejectedValueOnce(new Error("cleanup failure"));
    await registration.dispose();
    await registration.dispose();
    expect(native.toolDispose).toHaveBeenCalledOnce();
    expect(native.permissionDispose).toHaveBeenCalledOnce();
  });

  it("unwinds partial setup if tool registration fails", async () => {
    const native = harness(await temporary());
    native.transform.mockRejectedValueOnce(new Error("registration failure"));
    native.permissionDispose.mockRejectedValueOnce(new Error("cleanup failure"));
    await expect(registerManagerTool(native.ctx)).rejects.toThrow("registration failure");
    expect(native.permissionDispose).toHaveBeenCalledOnce();
    expect(native.toolDispose).not.toHaveBeenCalled();
  });
});
