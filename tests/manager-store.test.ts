import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  doctor,
  install,
  listInstallations,
  removeInstallation,
  setEnabled,
  update,
} from "#src/manager/store.ts";
import type { StoreDependencies } from "#src/manager/store.ts";
import type { AcquiredSource, PluginMetadata } from "#src/manager/types.ts";
import { RECEIPT } from "#src/manager/types.ts";

const { join } = nodePath;

let directory: string;
let root: string;
let source: AcquiredSource;

async function fingerprintDirectory(path: string): Promise<string> {
  const entries = await readdir(path, { withFileTypes: true });
  const contents = await Promise.all(
    entries
      .filter((entry) => entry.name !== RECEIPT)
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => [
        entry.name,
        entry.isDirectory()
          ? await fingerprintDirectory(join(path, entry.name))
          : await readFile(join(path, entry.name), "utf8"),
      ]),
  );
  return JSON.stringify(contents);
}

const deps: StoreDependencies = {
  fingerprintDirectory,
  readMetadata: async (path) => {
    try {
      const value: unknown = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
      // Test fixtures are generated here with this exact shape.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return value as PluginMetadata;
    } catch {
      return;
    }
  },
  snapshotDirectory: async (from, to) => {
    await cp(from, to, { recursive: true });
  },
};

beforeEach(async () => {
  directory = await mkdtemp("/tmp/opencode/store-test-");
  root = join(directory, "project", ".opencode", "agent-plugins");
  const path = join(directory, "source");
  await mkdir(path);
  await writeFile(
    join(path, "manifest.json"),
    JSON.stringify({ format: "agent-plugins", manifest: { name: "demo", version: "1" } }),
  );
  await writeFile(join(path, "payload.txt"), "first");
  source = {
    directory: path,
    dispose: async () => {
      await Promise.resolve();
    },
    source: { kind: "local", path },
  };
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe("manager store", () => {
  it("rolls back failed disable and uninstall", async () => {
    await install(root, source, deps);
    const failing: StoreDependencies = {
      ...deps,
      boundary: async (boundary) => {
        await Promise.resolve();
        if (boundary === "committed") {
          throw new Error("injected failure");
        }
      },
    };
    await expect(setEnabled(root, "demo", false, failing)).rejects.toThrow("injected failure");
    await expect(removeInstallation(root, "demo", failing)).rejects.toThrow("injected failure");
    const inventory = await listInstallations(root, deps);
    expect(inventory[0]?.enabled).toBe(true);
    const diagnostics = await doctor(root, deps);
    expect(diagnostics.problems).toEqual([]);
  });

  it("copies, disables, updates while disabled, enables and removes only its snapshot", async () => {
    const installed = await install(root, source, deps);
    expect(installed.managed).toBe(true);
    await setEnabled(root, "demo", false, deps);
    expect(await readdir(root)).toEqual([]);
    await writeFile(join(source.directory, "payload.txt"), "second");
    const updated = await update(root, "demo", source, deps);
    expect(updated.enabled).toBe(false);
    expect(updated.directory).toBe(
      join(directory, "project", ".opencode", ".agent-plugins-disabled", "demo"),
    );
    expect(await readFile(join(updated.directory, "payload.txt"), "utf8")).toBe("second");
    await setEnabled(root, "demo", true, deps);
    const runtime = join(directory, "project", ".opencode", "runtime.txt");
    await writeFile(runtime, "persistent");
    await removeInstallation(root, "demo", deps);
    expect(await listInstallations(root, deps)).toEqual([]);
    expect(await readFile(runtime, "utf8")).toBe("persistent");
  });

  it("never adopts, replaces or removes unmanaged directories", async () => {
    await mkdir(join(root, "demo"), { recursive: true });
    await cp(source.directory, join(root, "demo"), { recursive: true });
    const inventory = await listInstallations(root, deps);
    expect(inventory[0]?.managed).toBe(false);
    await expect(install(root, source, deps)).rejects.toThrow("already exists");
    await expect(removeInstallation(root, "demo", deps)).rejects.toThrow("unmanaged");
    await expect(update(root, "demo", source, deps)).rejects.toThrow("unmanaged");
  });

  it("rejects edited payloads for all destructive operations", async () => {
    await install(root, source, deps);
    await writeFile(join(root, "demo", "payload.txt"), "user edit");
    const diagnostics = await doctor(root, deps);
    expect(diagnostics.problems).toHaveLength(1);
    await expect(update(root, "demo", source, deps)).rejects.toThrow("local edits");
    await expect(setEnabled(root, "demo", false, deps)).rejects.toThrow("local edits");
    await expect(removeInstallation(root, "demo", deps)).rejects.toThrow("local edits");
  });

  it("fails closed for stale, malformed and symlink receipts", async () => {
    await install(root, source, deps);
    const path = join(root, "demo", RECEIPT);
    const receipt: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof receipt !== "object" || !receipt) {
      throw new Error("Invalid test receipt");
    }
    await writeFile(path, JSON.stringify({ ...receipt, schemaVersion: 2 }));
    await expect(removeInstallation(root, "demo", deps)).rejects.toThrow("unsupported");
    await writeFile(path, "broken");
    const inventory = await listInstallations(root, deps);
    expect(inventory[0]?.managed).toBe(false);
    await rm(path);
    await writeFile(join(directory, "receipt"), JSON.stringify(receipt));
    await symlink(join(directory, "receipt"), path);
    await expect(removeInstallation(root, "demo", deps)).rejects.toThrow(
      "Unsafe installation receipt",
    );
  });

  it("rejects traversal, symlink scopes and overlapping source", async () => {
    await expect(removeInstallation(root, "../demo", deps)).rejects.toThrow("Unsafe plugin name");
    await mkdir(join(directory, "project"));
    await symlink(source.directory, join(directory, "project", ".opencode"));
    await expect(install(root, source, deps)).rejects.toThrow("Unsafe directory");
    await rm(join(directory, "project", ".opencode"));
    await expect(install(root, { ...source, directory }, deps)).rejects.toThrow("overlap");
  });

  it("does not persist credential-bearing Git references", async () => {
    await expect(
      install(
        root,
        { ...source, source: { kind: "git", url: "https://secret@example.com/repo" } },
        deps,
      ),
    ).rejects.toThrow("credentials");
    expect(await readdir(root)).toEqual([]);
  });

  it("serialises concurrent operations without stealing locks", async () => {
    const gate = Promise.withResolvers<undefined>();
    const ready = Promise.withResolvers<undefined>();
    const running = install(root, source, {
      ...deps,
      boundary: async (boundary) => {
        if (boundary === "staged") {
          ready.resolve(undefined);
          await gate.promise;
        }
      },
    });
    await ready.promise;
    await expect(install(root, source, deps)).rejects.toThrow("locked");
    gate.resolve(undefined);
    await running;
  });

  it.each(["staged", "journalled", "backed-up", "committed"] as const)(
    "rolls back updates failing at %s",
    async (failure) => {
      await install(root, source, deps);
      await writeFile(join(source.directory, "payload.txt"), "replacement");
      await expect(
        update(root, "demo", source, {
          ...deps,
          boundary: async (boundary) => {
            await Promise.resolve();
            if (boundary === failure) {
              throw new Error("injected failure");
            }
          },
        }),
      ).rejects.toThrow("injected failure");
      expect(await readFile(join(root, "demo", "payload.txt"), "utf8")).toBe("first");
      const diagnostics = await doctor(root, deps);
      expect(diagnostics.problems).toEqual([]);
    },
  );

  it("reports interrupted transactions without deleting them", async () => {
    await install(root, source, deps);
    const journal = join(
      directory,
      "project",
      ".opencode",
      ".agent-plugins-manager",
      "journal.json",
    );
    await writeFile(journal, "interrupted");
    const diagnostics = await doctor(root, deps);
    expect(diagnostics.problems).toContain(
      "Interrupted transaction: journal.json requires manual recovery",
    );
    await listInstallations(root, deps);
    await expect(removeInstallation(root, "demo", deps)).rejects.toThrow("Interrupted transaction");
    expect(await readFile(journal, "utf8")).toBe("interrupted");
  });

  it("refuses disabled collisions and reports exact duplicate inventory", async () => {
    await install(root, source, deps);
    await setEnabled(root, "demo", false, deps);
    await mkdir(join(root, "demo"));
    await expect(setEnabled(root, "demo", true, deps)).rejects.toThrow("conflicting");
    const inventory = await listInstallations(root, deps);
    expect(inventory).toHaveLength(2);
    const diagnostics = await doctor(root, deps);
    expect(diagnostics.problems).toContain("Conflicting active/disabled installation: demo");
  });

  it("rejects symlink payloads and symlink manager state", async () => {
    await install(root, source, deps);
    await symlink(join(source.directory, "payload.txt"), join(root, "demo", "linked"));
    await expect(removeInstallation(root, "demo", deps)).rejects.toThrow("Unsafe payload");
    const alternate = join(directory, "alternate", "agent-plugins");
    await mkdir(join(directory, "alternate"));
    await symlink(source.directory, join(directory, "alternate", ".agent-plugins-manager"));
    await expect(install(alternate, source, deps)).rejects.toThrow("Unsafe directory");
  });

  it.each(["journalled", "committed"] as const)(
    "rolls back fresh installation at %s",
    async (failure) => {
      await expect(
        install(root, source, {
          ...deps,
          boundary: async (boundary) => {
            await Promise.resolve();
            if (boundary === failure) {
              throw new Error("injected failure");
            }
          },
        }),
      ).rejects.toThrow("injected failure");
      expect(await readdir(root)).toEqual([]);
      const diagnostics = await doctor(root, deps);
      expect(diagnostics.problems).toEqual([]);
    },
  );
});
