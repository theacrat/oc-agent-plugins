import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateSource } from "#src/manager/paths.ts";
import { validateReceipt } from "#src/manager/receipt.ts";
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

import { makeTempDir } from "./fixture.ts";

const { join } = nodePath;
const nativePlatform = process.platform;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<{ open: typeof open }>();
  return { ...original, open: vi.fn(original.open) };
});

async function directoryLink(target: string, destination: string): Promise<void> {
  await symlink(target, destination, nativePlatform === "win32" ? "junction" : "dir");
}

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
  directory = await makeTempDir("store-test-");
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
  vi.mocked(open).mockReset();
  if (platformDescriptor) {
    Object.defineProperty(process, "platform", platformDescriptor);
  }
  await rm(directory, { force: true, recursive: true });
});

describe.each(["native", "windows fallback"])("manager store (%s)", (mode) => {
  beforeEach(async () => {
    const original = await vi.importActual<{ open: typeof open }>("node:fs/promises");
    vi.mocked(open).mockImplementation(async (...args) => {
      if (mode === "windows fallback" && nodePath.basename(String(args[0])).startsWith("stage-")) {
        throw Object.assign(new Error("Windows directory open unsupported"), {
          code: "EPERM",
          path: args[0],
          syscall: "open",
        });
      }
      return original.open(...args);
    });
    if (mode === "windows fallback") {
      Object.defineProperty(process, "platform", { configurable: true, get: () => "win32" });
    }
  });

  it.each(["EPERM", "EISDIR", "EACCES"])(
    "uses identity ownership only for Windows directory open %s",
    async (code) => {
      vi.mocked(open).mockImplementation(async (filename) => {
        await Promise.resolve();
        throw Object.assign(new Error("directory open failed"), {
          code,
          path: filename,
          syscall: "open",
        });
      });
      if (process.platform === "win32") {
        const installed = await install(root, source, deps);
        expect(installed.managed).toBe(true);
      } else {
        await expect(install(root, source, deps)).rejects.toThrow("directory open failed");
        expect(await readdir(root)).toEqual([]);
      }
      const diagnostics = await doctor(root, deps);
      expect(diagnostics.problems).toEqual([]);
    },
  );

  it.each(["EIO", "ENOENT", "EMFILE", "wrong syscall", "wrong path", "missing context"])(
    "rejects unrelated stage open failures (%s) and cleans its private stage",
    async (failure) => {
      let copied = false;
      vi.mocked(open).mockImplementation(async (filename) => {
        await Promise.resolve();
        throw Object.assign(
          new Error("unrelated open failure"),
          failure === "missing context"
            ? { code: "EPERM" }
            : {
                code: failure.startsWith("E") ? failure : "EPERM",
                path: failure === "wrong path" ? source.directory : filename,
                syscall: failure === "wrong syscall" ? "stat" : "open",
              },
        );
      });
      await expect(
        install(root, source, {
          ...deps,
          snapshotDirectory: async () => {
            copied = true;
            await Promise.resolve();
          },
        }),
      ).rejects.toThrow("unrelated open failure");
      expect(copied).toBe(false);
      expect(await readdir(root)).toEqual([]);
      const diagnostics = await doctor(root, deps);
      expect(diagnostics.problems).toEqual([]);
    },
  );

  it("preserves an identical validated snapshot replacing the owned stage", async () => {
    const state = join(nodePath.dirname(root), ".agent-plugins-manager");
    let replacement: string | undefined;
    await expect(
      install(root, source, {
        ...deps,
        boundary: async (boundary) => {
          if (boundary !== "staged") {
            return;
          }
          const entries = await readdir(state);
          const name = entries.find(
            (entry) => entry.startsWith("stage-") && !entry.endsWith(".backup"),
          );
          if (!name) {
            throw new Error("Missing test stage");
          }
          replacement = join(state, name);
          const original = join(directory, "original-stage");
          await rename(replacement, original);
          await cp(original, replacement, { recursive: true });
        },
      }),
    ).rejects.toThrow("Staging directory replaced");
    if (!replacement) {
      throw new Error("Missing test replacement");
    }
    expect(await readFile(join(replacement, "payload.txt"), "utf8")).toBe("first");
    expect(await readFile(join(replacement, RECEIPT), "utf8")).toContain('"schemaVersion": 1');
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    { failure: "journalled", updating: false },
    { failure: "journalled", updating: true },
    { failure: "backed-up", updating: true },
  ])(
    "rejects identical stage replacements at $failure (update=$updating)",
    async ({ failure, updating }) => {
      if (updating) {
        await install(root, source, deps);
      }
      const state = join(nodePath.dirname(root), ".agent-plugins-manager");
      let stage: string | undefined;
      const replacing: StoreDependencies = {
        ...deps,
        boundary: async (boundary) => {
          if (boundary !== failure) {
            return;
          }
          const entries = await readdir(state);
          const name = entries.find(
            (entry) => entry.startsWith("stage-") && !entry.endsWith(".backup"),
          );
          if (!name) {
            throw new Error("Missing test stage");
          }
          stage = join(state, name);
          const original = join(directory, "original-stage");
          await rename(stage, original);
          await cp(original, stage, { recursive: true });
        },
      };
      await expect(
        updating ? update(root, "demo", source, replacing) : install(root, source, replacing),
      ).rejects.toThrow("Staging directory replaced");
      if (!stage) {
        throw new Error("Missing test stage");
      }
      expect(await readFile(join(stage, "payload.txt"), "utf8")).toBe("first");
      const diagnostics = await doctor(root, deps);
      expect(diagnostics.problems).toContain(
        "Interrupted transaction: journal.json requires manual recovery",
      );
      if (updating) {
        expect(await readFile(join(root, "demo", "payload.txt"), "utf8")).toBe("first");
      } else {
        expect(await readdir(root)).toEqual([]);
      }
    },
  );

  it.each([
    { failing: false, updating: false },
    { failing: true, updating: false },
    { failing: false, updating: true },
    { failing: true, updating: true },
  ])(
    "preserves identical published replacements (update=$updating, failure=$failing)",
    async ({ failing, updating }) => {
      if (updating) {
        await install(root, source, deps);
      }
      const target = join(root, "demo");
      const replacing: StoreDependencies = {
        ...deps,
        boundary: async (boundary) => {
          if (boundary !== "committed") {
            return;
          }
          const original = join(directory, "published-stage");
          await rename(target, original);
          await cp(original, target, { recursive: true });
          if (failing) {
            throw new Error("injected replacement failure");
          }
        },
      };
      await expect(
        updating ? update(root, "demo", source, replacing) : install(root, source, replacing),
      ).rejects.toThrow("Staging directory replaced");
      expect(await readFile(join(target, "payload.txt"), "utf8")).toBe("first");
      const diagnostics = await doctor(root, deps);
      expect(diagnostics.problems).toContain(
        "Interrupted transaction: journal.json requires manual recovery",
      );
    },
  );

  it("preserves an identical replacement during collision cleanup", async () => {
    await install(root, source, deps);
    let stage: string | undefined;
    const replacing: StoreDependencies = {
      ...deps,
      boundary: async (boundary) => {
        if (boundary === "staged") {
          const entries = await readdir(join(nodePath.dirname(root), ".agent-plugins-manager"));
          const name = entries.find((entry) => entry.startsWith("stage-"));
          if (!name) {
            throw new Error("Missing test stage");
          }
          stage = join(nodePath.dirname(root), ".agent-plugins-manager", name);
        }
      },
      readMetadata: async (location) => {
        const metadata = await deps.readMetadata(location);
        if (stage === location) {
          stage = undefined;
          const original = join(directory, "collision-stage");
          await rename(location, original);
          await cp(original, location, { recursive: true });
          stage = location;
        }
        return metadata;
      },
    };
    await expect(install(root, source, replacing)).rejects.toThrow("Staging directory replaced");
    if (!stage) {
      throw new Error("Missing test stage");
    }
    expect(await readFile(join(stage, "payload.txt"), "utf8")).toBe("first");
    expect(await readFile(join(root, "demo", "payload.txt"), "utf8")).toBe("first");
  });
  it.each(["payload", "receipt"] as const)(
    "retains validated stage %s edits after a staged-boundary failure",
    async (change) => {
      await install(root, source, deps);
      const state = join(nodePath.dirname(root), ".agent-plugins-manager");
      let stage: string | undefined;
      await expect(
        update(root, "demo", source, {
          ...deps,
          boundary: async (boundary) => {
            if (boundary !== "staged") {
              return;
            }
            const entries = await readdir(state);
            const name = entries.find((entry) => entry.startsWith("stage-"));
            if (!name) {
              throw new Error("Missing test stage");
            }
            stage = join(state, name);
            const filename = change === "payload" ? "external-user-work.txt" : RECEIPT;
            await writeFile(
              join(stage, filename),
              change === "payload" ? "preserve" : "externally modified receipt",
            );
            throw new Error("injected staged failure");
          },
        }),
      ).rejects.toThrow();
      if (!stage) {
        throw new Error("Missing test stage");
      }
      const userFile = join(stage, change === "payload" ? "external-user-work.txt" : RECEIPT);
      expect(await readFile(userFile, "utf8")).toBe(
        change === "payload" ? "preserve" : "externally modified receipt",
      );
      expect(await readFile(join(root, "demo", "payload.txt"), "utf8")).toBe("first");
      const diagnostics = await doctor(root, deps);
      expect(diagnostics.problems).toContain(
        `Retained transaction snapshot: ${nodePath.basename(stage)}`,
      );
    },
  );

  it("cleans identity-changing update stages and preserves the previous installation", async () => {
    await install(root, source, deps);
    await writeFile(
      join(source.directory, "manifest.json"),
      JSON.stringify({ format: "claude", manifest: { name: "other" } }),
    );
    await expect(update(root, "demo", source, deps)).rejects.toThrow(
      "cannot change plugin name or format",
    );
    const diagnostics = await doctor(root, deps);
    expect(diagnostics.problems).toEqual([]);
    expect(await readFile(join(root, "demo", "payload.txt"), "utf8")).toBe("first");
  });

  it("retains a partial stage if interrupted-operation metadata appears", async () => {
    const state = join(nodePath.dirname(root), ".agent-plugins-manager");
    let stage: string | undefined;
    await expect(
      install(root, source, {
        ...deps,
        snapshotDirectory: async (_from, to) => {
          stage = to;
          await writeFile(join(to, "partial"), "retained");
          await writeFile(join(state, "journal.json"), "interrupted");
          throw new Error("interrupted copier");
        },
      }),
    ).rejects.toThrow("interrupted copier");
    if (!stage) {
      throw new Error("Missing test stage");
    }
    expect(await readFile(join(stage, "partial"), "utf8")).toBe("retained");
    expect(await readFile(join(state, "journal.json"), "utf8")).toBe("interrupted");
  });

  it.each([false, true])(
    "cleans invalid manifests before receipt creation (update=%s)",
    async (updating) => {
      if (updating) {
        await install(root, source, deps);
      }
      await writeFile(join(source.directory, "manifest.json"), "invalid manifest");
      await expect(
        updating ? update(root, "demo", source, deps) : install(root, source, deps),
      ).rejects.toThrow("supported plugin manifest");
      const diagnostics = await doctor(root, deps);
      expect(diagnostics.problems).toEqual([]);
      if (updating) {
        expect(await readFile(join(root, "demo", "payload.txt"), "utf8")).toBe("first");
      }
      await writeFile(
        join(source.directory, "manifest.json"),
        JSON.stringify({ format: "agent-plugins", manifest: { name: "demo", version: "2" } }),
      );
      await (updating ? update(root, "demo", source, deps) : install(root, source, deps));
    },
  );

  it("cleans asynchronous partial copier failures and permits subsequent updates", async () => {
    await install(root, source, deps);
    await expect(
      update(root, "demo", source, {
        ...deps,
        snapshotDirectory: async (from, to) => {
          await mkdir(join(to, "partial"));
          await cp(join(from, "payload.txt"), join(to, "partial", "payload"));
          throw new Error("copy failed");
        },
      }),
    ).rejects.toThrow("copy failed");
    const diagnostics = await doctor(root, deps);
    expect(diagnostics.problems).toEqual([]);
    expect(await readFile(join(root, "demo", "payload.txt"), "utf8")).toBe("first");
    await update(root, "demo", source, deps);
  });

  it("cleans rejected symlinks without traversing their external targets", async () => {
    const external = join(directory, "external");
    await mkdir(external);
    await writeFile(join(external, "user-data"), "preserve");
    await expect(
      install(root, source, {
        ...deps,
        snapshotDirectory: async (_from, to) => {
          await directoryLink(external, join(to, "escape"));
        },
      }),
    ).rejects.toThrow("Unsafe payload");
    expect(await readFile(join(external, "user-data"), "utf8")).toBe("preserve");
    const diagnostics = await doctor(root, deps);
    expect(diagnostics.problems).toEqual([]);
    await install(root, source, deps);
  });

  it.each([false, true])("preserves external replacement stages (symlink=%s)", async (link) => {
    const external = join(directory, "external");
    await mkdir(external);
    await writeFile(join(external, "user-data"), "preserve");
    let stage: string | undefined;
    let replacementInode: number | undefined;
    await expect(
      install(root, source, {
        ...deps,
        snapshotDirectory: async (_from, to) => {
          stage = to;
          await rename(to, join(directory, "original-stage"));
          if (link) {
            await directoryLink(external, to);
          } else {
            await mkdir(to);
            await writeFile(join(to, "user-data"), "replacement");
          }
          const stat = await lstat(to);
          replacementInode = stat.ino;
          throw new Error("copy failed after replacement");
        },
      }),
    ).rejects.toThrow("Staging directory replaced");
    if (!stage) {
      throw new Error("Missing test stage");
    }
    const stat = await lstat(stage);
    expect(stat.ino).toBe(replacementInode);
    expect(await readFile(join(external, "user-data"), "utf8")).toBe("preserve");
    if (!link) {
      expect(await readFile(join(stage, "user-data"), "utf8")).toBe("replacement");
    }
  });

  it("rejects a successful copier that replaces its stage", async () => {
    let stage: string | undefined;
    await expect(
      install(root, source, {
        ...deps,
        snapshotDirectory: async (from, to) => {
          stage = to;
          await rename(to, join(directory, "original-stage"));
          await cp(from, to, { recursive: true });
        },
      }),
    ).rejects.toThrow("Staging directory replaced");
    if (!stage) {
      throw new Error("Missing test stage");
    }
    expect(await readFile(join(stage, "payload.txt"), "utf8")).toBe("first");
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects stale acquisitions after reinstalling from a different source", async () => {
    const original = await install(root, source, deps);
    await removeInstallation(root, "demo", deps);
    const replacementPath = join(directory, "replacement");
    await cp(source.directory, replacementPath, { recursive: true });
    await writeFile(join(replacementPath, "payload.txt"), "replacement");
    await install(
      root,
      { ...source, directory: replacementPath, source: { kind: "local", path: replacementPath } },
      deps,
    );
    await expect(update(root, "demo", source, deps)).rejects.toThrow("source changed");
    await expect(update(root, "demo", source, deps, original.receipt)).rejects.toThrow(
      "source changed",
    );
    expect(await readFile(join(root, "demo", "payload.txt"), "utf8")).toBe("replacement");
    const state = join(nodePath.dirname(root), ".agent-plugins-manager");
    expect(await readdir(state)).toEqual([]);
  });

  it.each(["fingerprint", "revision"] as const)(
    "rejects an expected receipt with stale %s",
    async (field) => {
      const installed = await install(root, source, deps);
      if (!installed.receipt) {
        throw new Error("Missing test receipt");
      }
      const expected = {
        ...installed.receipt,
        [field]: field === "revision" ? "a".repeat(40) : "stale fingerprint",
      };
      await writeFile(join(source.directory, "payload.txt"), "new acquisition");
      await expect(update(root, "demo", source, deps, expected)).rejects.toThrow("receipt changed");
      expect(await readFile(join(root, "demo", "payload.txt"), "utf8")).toBe("first");
      const state = join(nodePath.dirname(root), ".agent-plugins-manager");
      expect(await readdir(state)).toEqual([]);
    },
  );

  it("compares equivalent receipts independently of JSON field order", async () => {
    const gitSource: AcquiredSource = {
      ...source,
      revision: "a".repeat(40),
      source: { kind: "git", ref: "main", subdir: "plugin", url: "https://example.com/repo" },
    };
    const installed = await install(root, gitSource, deps);
    if (!installed.receipt) {
      throw new Error("Missing test receipt");
    }
    const { receipt } = installed;
    const reorderedSource = Object.fromEntries(Object.entries(receipt.source).toReversed());
    const entries = Object.entries({ ...receipt, source: reorderedSource }).toReversed();
    const expected: unknown = Object.fromEntries(entries);
    validateReceipt(expected);
    await writeFile(join(source.directory, "payload.txt"), "updated");
    await update(root, "demo", gitSource, deps, expected);
    expect(await readFile(join(root, "demo", "payload.txt"), "utf8")).toBe("updated");
  });

  it("retains the journal and unmanaged destination on a disable rollback collision", async () => {
    await install(root, source, deps);
    const active = join(root, "demo");
    const disabled = join(nodePath.dirname(root), ".agent-plugins-disabled", "demo");
    const state = join(nodePath.dirname(root), ".agent-plugins-manager");
    const original = await lstat(active);
    let collisionInode: number | undefined;
    await expect(
      setEnabled(root, "demo", false, {
        ...deps,
        boundary: async (boundary) => {
          if (boundary === "committed") {
            await mkdir(active);
            const collision = await lstat(active);
            collisionInode = collision.ino;
            throw new Error("injected failure");
          }
        },
      }),
    ).rejects.toThrow("Rollback collision");
    const preserved = await lstat(active);
    const snapshot = await lstat(disabled);
    expect(preserved.ino).toBe(collisionInode);
    expect(await readdir(active)).toEqual([]);
    expect(snapshot.ino).toBe(original.ino);
    expect(await readFile(join(disabled, "payload.txt"), "utf8")).toBe("first");
    const journal: unknown = JSON.parse(await readFile(join(state, "journal.json"), "utf8"));
    expect(journal).toMatchObject({ target: disabled });
  });

  it("rejects filesystem roots before invoking snapshot callbacks", async () => {
    const filesystemRoot = nodePath.parse(directory).root;
    await expect(validateSource(filesystemRoot, [root])).rejects.toThrow("Filesystem root");
    let copied = false;
    await expect(
      install(
        root,
        { ...source, directory: filesystemRoot },
        {
          ...deps,
          snapshotDirectory: async () => {
            copied = true;
            await Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow("Filesystem root");
    expect(copied).toBe(false);
    await expect(validateSource(directory, [root])).rejects.toThrow("overlap");
    await expect(validateSource(source.directory, [directory])).rejects.toThrow("overlap");
    await validateSource(source.directory, [join(directory, "source-sibling", "agent-plugins")]);
  });

  it.each(["journal.json", "lock"])(
    "surfaces %s in empty and populated read-only inventory",
    async (entry) => {
      const state = join(nodePath.dirname(root), ".agent-plugins-manager");
      await mkdir(state, { recursive: true });
      const marker = join(state, entry);
      await (entry === "lock" ? mkdir(marker) : writeFile(marker, "interrupted"));
      const before = await lstat(marker);
      const empty = await listInstallations(root, deps);
      expect(empty).toHaveLength(1);
      expect(empty[0]).toMatchObject({
        directory: state,
        enabled: false,
        managed: false,
        name: ".agent-plugins-manager",
      });
      expect(empty[0]?.problem).toContain(
        entry === "lock" ? "Store lock exists" : "Interrupted transaction",
      );
      await mkdir(join(root, "unmanaged"), { recursive: true });
      const populated = await listInstallations(root, deps);
      expect(populated).toHaveLength(2);
      const diagnostics = await doctor(root, deps);
      expect(diagnostics.problems).toHaveLength(1);
      const after = await lstat(marker);
      expect(after.ino).toBe(before.ino);
      if (entry === "journal.json") {
        expect(await readFile(marker, "utf8")).toBe("interrupted");
      } else {
        expect(await readdir(marker)).toEqual([]);
      }
    },
  );

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
    await directoryLink(source.directory, join(directory, "project", ".opencode"));
    await expect(install(root, source, deps)).rejects.toThrow("Unsafe directory");
    await rm(join(directory, "project", ".opencode"));
    await expect(install(root, { ...source, directory }, deps)).rejects.toThrow("overlap");
  });

  it("rejects a directory link used as the store root", async () => {
    await mkdir(nodePath.dirname(root), { recursive: true });
    await directoryLink(source.directory, root);
    await expect(install(root, source, deps)).rejects.toThrow("Unsafe directory");
    expect(await readFile(join(source.directory, "payload.txt"), "utf8")).toBe("first");
    const entries = await readdir(source.directory);
    expect(entries.toSorted()).toEqual(["manifest.json", "payload.txt"]);
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
    await directoryLink(source.directory, join(directory, "alternate", ".agent-plugins-manager"));
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
