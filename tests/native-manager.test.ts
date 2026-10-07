import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Plugin } from "@opencode/plugin";
import type { CommandDefinition, CommandEditor } from "@opencode/plugin/promise/command";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseOptions } from "#src/options.ts";
import type { registerCompatibility } from "#src/runtime/compatibility.ts";
import { managerArguments } from "#src/runtime/manager-arguments.ts";
import { safeNativeError } from "#src/runtime/manager-errors.ts";
import { registerCommands } from "#src/runtime/plugin-commands.ts";
import type { Report } from "#src/types.ts";

import { manifest } from "./fixture.ts";

const roots: string[] = [];
const temporary = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-manager-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

const registered = async (directory: string) => {
  const commands = new Map<string, CommandDefinition>();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixed test session identifier has the SDK's branded string shape
  const sessionID = "ses_native_manager" as Parameters<
    CommandDefinition["execute"]
  >[0]["sessionID"];
  const messages: Parameters<Plugin.Context["session"]["synthetic"]>[0][] = [];
  const get = vi.fn(async (input: Parameters<Plugin.Context["session"]["get"]>[0]) => {
    await Promise.resolve();
    expect(input).toEqual({ sessionID });
    return { location: { directory } };
  });
  const synthetic = vi.fn(async (input: Parameters<Plugin.Context["session"]["synthetic"]>[0]) => {
    await Promise.resolve();
    messages.push(input);
  });
  const ctx = {
    command: {
      transform: async (transform: (editor: CommandEditor) => void) => {
        await Promise.resolve();
        transform({
          add: (definition) => {
            commands.set(definition.name, definition);
          },
        });
      },
    },
    location: { directory: path.join(directory, "other-location") },
    session: { get, synthetic },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SDK inputs are typed; unrelated context methods and response fields are not used
  const native = ctx as unknown as Plugin.Context;
  const compatibility: Awaited<ReturnType<typeof registerCompatibility>> = {
    addCommands: vi.fn<(editor: CommandEditor) => void>(),
    dispose: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    replace: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  const reload = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  await registerCommands(
    native,
    parseOptions(
      { dataHome: directory, home: directory, project: directory, raw: {} },
      vi.fn<Report>(),
    ),
    { current: { diagnostics: [], plugins: [] } },
    reload,
    compatibility,
  );
  const invoke = async (text: string) => {
    const command = commands.get("agent-plugins-manage");
    if (command === undefined) {
      throw new Error("manager command was not registered");
    }
    await command.execute({ delivery: "steer", prompt: { text }, sessionID });
    const message = messages.at(-1);
    expect(message).toMatchObject({ resume: false, sessionID });
    expect(reload).not.toHaveBeenCalled();
    return message?.text ?? "";
  };
  return { commands, get, invoke, reload, sessionID };
};

describe("native manager arguments", () => {
  it.each([
    ["", []],
    ["  \t\n", []],
    ['install "folder with spaces" --json', ["install", "folder with spaces", "--json"]],
    [
      "install 'single quoted' --project=\"my project\"",
      ["install", "single quoted", "--project=my project"],
    ],
    [String.raw`install a\ b "" '' ab"cd"`, ["install", "a b", "", "", "abcd"]],
    ["install -- -source", ["install", "--", "-source"]],
    [
      "$HOME $(touch nope) `cmd` ; | > # literal",
      ["$HOME", "$(touch", "nope)", "`cmd`", ";", "|", ">", "#", "literal"],
    ],
  ])("tokenises %s without shell expansion or comments", (input, expected) => {
    expect(managerArguments(input)).toEqual(expected);
  });
  it.each(['install "secret', "install 'secret", "install secret\\"])(
    "rejects malformed input without echoing it",
    (input) => {
      expect(() => managerArguments(input)).toThrow("Unmatched quote or trailing escape");
      expect(() => managerArguments(input)).not.toThrow("secret");
    },
  );
});

describe("native manager command", () => {
  it("registers beside the existing rescan and returns help without model continuation", async () => {
    const root = await temporary();
    const command = await registered(root);
    expect([...command.commands.keys()]).toEqual([
      "agent-plugins-lsp",
      "agent-plugins",
      "agent-plugins-manage",
    ]);
    expect(await command.invoke("")).toContain("Usage:");
    expect(JSON.parse(await command.invoke("--help --json"))).toMatchObject({ command: "help" });
    const rescan = command.commands.get("agent-plugins");
    await rescan?.execute({
      delivery: "queue",
      prompt: { text: "" },
      sessionID: command.sessionID,
    });
    expect(command.reload).toHaveBeenCalledOnce();
  });

  it("installs, disables, updates, enables and removes in the invoking session directory", async () => {
    const root = await temporary();
    const source = path.join(root, "source with spaces");
    const project = path.join(root, "session project");
    await mkdir(source);
    await mkdir(project);
    await writeFile(path.join(source, "plugin.json"), manifest());
    await writeFile(path.join(source, "README.md"), "Original");
    const command = await registered(project);
    expect(JSON.parse(await command.invoke(`install "${source}" --json`))).toMatchObject({
      command: "install",
      scope: "project",
    });
    expect(
      await readFile(path.join(project, ".opencode/agent-plugins/demo/README.md"), "utf8"),
    ).toBe("Original");
    await expect(access(path.join(project, "other-location/.opencode"))).rejects.toThrow();
    expect(JSON.parse(await command.invoke("disable demo --json"))).toMatchObject({
      entries: [{ enabled: false }],
    });
    await writeFile(path.join(source, "README.md"), "Updated");
    expect(JSON.parse(await command.invoke("update --all --json"))).toMatchObject({
      entries: [{ enabled: false }],
    });
    expect(JSON.parse(await command.invoke("enable demo --json"))).toMatchObject({
      entries: [{ enabled: true }],
    });
    expect(JSON.parse(await command.invoke("info demo --json"))).toMatchObject({
      entries: [{ name: "demo" }],
    });
    await writeFile(path.join(project, ".opencode/agent-plugins/demo/README.md"), "User edit");
    expect(JSON.parse(await command.invoke("uninstall demo --json"))).toMatchObject({
      error:
        "Installation has local edits or is unmanaged. Preserve local work and inspect it before retrying; retained staging data must not be deleted blindly.",
      exitCode: 1,
    });
    expect(await command.invoke("doctor")).toContain("Exit status: 1");
    expect(
      await readFile(path.join(project, ".opencode/agent-plugins/demo/README.md"), "utf8"),
    ).toBe("User edit");
    await writeFile(path.join(project, ".opencode/agent-plugins/demo/README.md"), "Updated");
    await command.invoke("uninstall demo");
    expect(JSON.parse(await command.invoke("list --json"))).toMatchObject({ entries: [] });
    expect(command.get).toHaveBeenCalled();
  });

  it("passes global and project scopes and leading-dash sources through CLI validation", async () => {
    const root = await temporary();
    vi.stubEnv("OPENCODE_CONFIG_DIR", path.join(root, "global"));
    const project = path.join(root, "override project");
    const source = path.join(root, "-source");
    await mkdir(project);
    await mkdir(source);
    await writeFile(path.join(source, "plugin.json"), manifest());
    const command = await registered(root);
    expect(JSON.parse(await command.invoke("install --json --global -- -source"))).toMatchObject({
      scope: "global",
    });
    expect(
      JSON.parse(await command.invoke(`install "${source}" -p "${project}" --json`)),
    ).toMatchObject({ scope: "project" });
    expect(await readFile(path.join(root, "global/agent-plugins/demo/plugin.json"), "utf8")).toBe(
      manifest(),
    );
    expect(
      await readFile(path.join(project, ".opencode/agent-plugins/demo/plugin.json"), "utf8"),
    ).toBe(manifest());
    expect(JSON.parse(await command.invoke("list --global --project nope --json"))).toMatchObject({
      error: "Use --global or --project, not both",
      exitCode: 1,
    });
    expect(JSON.parse(await command.invoke("install --ref bad --subdir bad --json"))).toMatchObject(
      { exitCode: 1 },
    );
  });

  it("sanitises executor failures and uses parsed argv for JSON errors", async () => {
    const command = await registered(await temporary());
    const secret = "credential-do-not-echo";
    const malformed = await command.invoke(`install "${secret} --json`);
    expect(JSON.parse(malformed)).toEqual({
      error:
        "Unterminated quote or trailing escape. Run /agent-plugins-manage --help to check usage.",
      exitCode: 1,
    });
    expect(malformed).not.toContain(secret);
    const rejected = await command.invoke(`"--json" "${secret}"`);
    expect(JSON.parse(rejected)).toEqual({
      error: "Unknown command. Run /agent-plugins-manage --help to check usage.",
      exitCode: 1,
    });
    expect(rejected).not.toContain(secret);
    command.get.mockRejectedValueOnce(new Error(secret));
    const sdkFailure = await command.invoke("list --json");
    expect(sdkFailure).not.toContain(secret);
    expect(JSON.parse(sdkFailure)).toMatchObject({
      error: "Unable to read the invoking session location. Retry when the session is available.",
      exitCode: 1,
    });
    expect(JSON.parse(await command.invoke("info absent --json"))).toEqual({
      error: 'Plugin "absent" is not installed in this scope',
      exitCode: 1,
    });
    expect(JSON.parse(await command.invoke("list --no-such-option --json"))).toMatchObject({
      error: "Unknown option. Run /agent-plugins-manage --help to check supported flags.",
      exitCode: 1,
    });
    const sourceFailure = await command.invoke(
      `install "https://user:${secret}@example.com/source" --json`,
    );
    expect(sourceFailure).not.toContain(secret);
    expect(sourceFailure).not.toContain("example.com");
    expect(JSON.parse(sourceFailure)).toMatchObject({
      error:
        "Unsafe source or installation path. Use real, contained directories without symlinks or reserved paths.",
      exitCode: 1,
    });
  });
});

describe("safe native error presentation", () => {
  it.each([
    ["Store is locked: /secret/state", "Store is locked"],
    ["Rollback collision; transaction journal retained", "retained journal"],
    ["Interrupted transaction detected; inspect journal.json", "retained journal"],
    ["Edited staging snapshot retained for inspection: /secret/stage", "local edits"],
    ["Unsafe payload entry: https://user:secret@example.com/path", "Unsafe source"],
    ["Missing or conflicting installation: absent", "missing, conflicting"],
    ["--ref and --subdir require a Git source", "require a Git source"],
  ])("provides actionable fixed text for %s", (message, diagnostic) => {
    const output = safeNativeError(new Error(message));
    expect(output).toContain(diagnostic);
    expect(output).not.toContain("secret");
    expect(output).not.toContain("example.com");
  });
  it("never echoes unrecognised errors or invalid captured plugin names", () => {
    for (const error of [
      new Error("SDK body secret"),
      new Error('Plugin "https://user:secret@example.com" is not installed in this scope'),
      { message: "secret" },
    ]) {
      expect(safeNativeError(error)).toBe(
        "Manager command failed. Run /agent-plugins-manage --help to check usage.",
      );
    }
  });
});
