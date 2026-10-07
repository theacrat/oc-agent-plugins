import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "#src/cli/run.ts";
import { isRecord } from "#src/json.ts";

import { makeTree, manifest, skill } from "./fixture.ts";

const invoke = async (project: string, argv: readonly string[]) => {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCode = await runCli(argv, {
    cwd: project,
    env: { OPENCODE_CONFIG_DIR: path.join(project, "global") },
    home: path.join(project, "home"),
    stderr: (text) => {
      errors.push(text);
    },
    stdout: (text) => {
      output.push(text);
    },
  });
  return { errors, exitCode, output };
};

const entriesFrom = (output: readonly string[]): readonly unknown[] => {
  const parsed: unknown = JSON.parse(output[0] ?? "{}");
  if (!isRecord(parsed) || !Array.isArray(parsed["entries"])) {
    throw new Error("Invalid CLI JSON output");
  }
  return parsed["entries"];
};

describe("managed CLI lifecycle", () => {
  it("allows a valid install after rejecting an invalid first manifest", async () => {
    const source = await makeTree({ "plugin.json": "invalid JSON" });
    const project = await makeTree({ "README.md": "Project" });
    await expect(invoke(project, ["install", source])).rejects.toThrow("manifest");
    expect(await readdir(path.join(project, ".opencode/.agent-plugins-manager"))).toEqual([]);
    await writeFile(path.join(source, "plugin.json"), manifest());
    const installed = await invoke(project, ["install", source]);
    expect(installed.exitCode).toBe(0);
    const diagnosis = await invoke(project, ["doctor"]);
    expect(diagnosis.exitCode).toBe(0);
  });
  it("recovers from rejected source validation without blocking bulk updates", async () => {
    const source = await makeTree({ "plugin.json": manifest() });
    const project = await makeTree({ "README.md": "Project" });
    await invoke(project, ["install", source]);
    await writeFile(path.join(source, "plugin.json"), "invalid JSON");
    await expect(invoke(project, ["update", "demo"])).rejects.toThrow("manifest");
    await writeFile(path.join(source, "plugin.json"), manifest());
    const updated = await invoke(project, ["update", "--all"]);
    expect(updated.exitCode).toBe(0);
    const diagnosis = await invoke(project, ["doctor"]);
    expect(diagnosis.exitCode).toBe(0);
  });
  it("fails closed on unsupported platforms but leaves help and version available", async () => {
    const project = await makeTree({ "README.md": "Project" });
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      await expect(invoke(project, ["list"])).rejects.toThrow("requires Linux");
      const help = await invoke(project, ["help", "--json"]);
      const version = await invoke(project, ["version", "--json"]);
      expect(help.exitCode).toBe(0);
      expect(version.exitCode).toBe(0);
    } finally {
      platform.mockRestore();
    }
  });
  it("returns machine-readable help without reading a package", async () => {
    const project = await makeTree({ "README.md": "Project" });
    const result = await invoke(project, ["help", "--json"]);
    const parsed: unknown = JSON.parse(result.output[0] ?? "{}");
    expect(isRecord(parsed) && parsed["command"]).toBe("help");
    expect(isRecord(parsed) && parsed["help"]).toContain("Usage: npx oc-agent-plugins");
    expect(result.exitCode).toBe(0);
  });
  it.each(["node_modules", ".git", "nested"])(
    "protects newly added %s contents",
    async (folder) => {
      const source = await makeTree({ "plugin.json": manifest() });
      const project = await makeTree({ "README.md": "Project" });
      await invoke(project, ["install", source]);
      const added = path.join(project, ".opencode/agent-plugins/demo", folder);
      await mkdir(added);
      const filename = folder === "nested" ? ".oc-agent-plugin.json" : "user-work.txt";
      await writeFile(path.join(added, filename), "Keep this");
      await expect(invoke(project, ["update", "demo"])).rejects.toThrow("edited");
      await expect(invoke(project, ["uninstall", "demo"])).rejects.toThrow("local edits");
      expect(await readFile(path.join(added, filename), "utf8")).toBe("Keep this");
    },
  );
  it("installs and updates local snapshots while preserving disabled state and runtime data", async () => {
    const source = await makeTree({
      "plugin.json": manifest(),
      "skills/review/SKILL.md": skill("review"),
    });
    const project = await makeTree({ "data/state.txt": "keep" });
    const installed = await invoke(project, ["install", source, "--json"]);
    expect(installed.exitCode).toBe(0);
    const [managed] = entriesFrom(installed.output);
    expect(isRecord(managed) && managed["managed"]).toBe(true);
    await invoke(project, ["disable", "demo"]);
    await writeFile(path.join(source, "skills/review/SKILL.md"), skill("review", "Updated."));
    await invoke(project, ["update", "demo"]);
    const disabled = await invoke(project, ["list", "--json"]);
    const [entry] = entriesFrom(disabled.output);
    expect(isRecord(entry) && entry["enabled"]).toBe(false);
    await invoke(project, ["enable", "demo"]);
    expect(
      await readFile(
        path.join(project, ".opencode/agent-plugins/demo/skills/review/SKILL.md"),
        "utf8",
      ),
    ).toContain("Updated.");
    await invoke(project, ["uninstall", "demo"]);
    expect(await readFile(path.join(project, "data/state.txt"), "utf8")).toBe("keep");
    const listed = await invoke(project, ["list", "--json"]);
    expect(entriesFrom(listed.output)).toEqual([]);
  });

  it("protects local edits and uses the global native config directory", async () => {
    const source = await makeTree({ "README.md": "Original", "plugin.json": manifest() });
    const project = await makeTree({ "README.md": "Project" });
    await invoke(project, ["install", source, "--global"]);
    const file = path.join(project, "global/agent-plugins/demo/README.md");
    await writeFile(file, "User edit");
    await expect(invoke(project, ["update", "demo", "--global"])).rejects.toThrow("edited");
    await expect(invoke(project, ["uninstall", "demo", "--global"])).rejects.toThrow("local edits");
    expect(await readFile(file, "utf8")).toBe("User edit");
    const diagnosis = await invoke(project, ["doctor", "--global"]);
    expect(diagnosis.exitCode).toBe(1);
  });
});
