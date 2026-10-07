import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import pathModule from "node:path";
import { pathToFileURL } from "node:url";
// Adapt the Node subprocess boundary without a shell.
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { fingerprintDirectory } from "#src/manager/fingerprint.ts";
import { readMetadata } from "#src/manager/metadata.ts";
import { validateReceipt } from "#src/manager/receipt.ts";
import { snapshotDirectory } from "#src/manager/snapshot.ts";
// This integration suite exercises every source boundary and the receipt policy.
// eslint-disable-next-line import/max-dependencies
import { acquireSource, parseSource } from "#src/manager/source.ts";
import type { Source } from "#src/manager/types.ts";

const RECEIPT = ".oc-agent-plugin.json";
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const { join } = pathModule;

vi.mock("node:fs/promises", { spy: true });

const temporary: string[] = [];
const fixture = async (): Promise<string> => {
  const root = await mkdtemp("/tmp/opencode/manager-source-");
  temporary.push(root);
  return root;
};
const manifest = JSON.stringify({ $schema: PLUGIN_SCHEMA, name: "sample" });
const receipt = (source: unknown): unknown => ({
  fingerprint: "test",
  format: "agent-plugins",
  name: "sample",
  schemaVersion: 1,
  source,
});
// execFile's custom promisify overload returns stdout despite its void callback signature.
// eslint-disable-next-line typescript/strict-void-return
const executeFile = promisify(execFile);
const runGit = async (directory: string, args: readonly string[]): Promise<string> => {
  const result = await executeFile(
    "git",
    [
      `--git-dir=${directory.endsWith(".git") ? directory : join(directory, ".git")}`,
      ...(directory.endsWith(".git") ? [] : [`--work-tree=${directory}`]),
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      ...args,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: directory,
        PATH: "/usr/bin:/bin",
      },
    },
  );
  return result.stdout.trim();
};

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    temporary.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("manager sources", () => {
  it("uses the same public source policy for parsing and receipts", async () => {
    const root = await fixture();
    await Promise.all(
      [
        "https://github.com/owner/repo.git",
        "ssh://git@github.com/owner/repo.git",
        "git@github.com:owner/repo.git",
      ].map(async (url) => {
        const source = await parseSource(url, {
          cwd: root,
          ref: "feature/test",
          subdir: "plugins/example",
        });
        expect(() => {
          validateReceipt(receipt(source));
        }).not.toThrow();
      }),
    );
    const invalid: Extract<Source, { kind: "git" }>[] = [
      { kind: "git", url: "https://alice:SECRET@github.com/repo.git" },
      { kind: "git", url: "ssh://git:SECRET@github.com/repo.git" },
      { kind: "git", url: "ext::SECRET" },
      { kind: "git", url: "file:///SECRET" },
      ...["--bad", "a..b", "a//b", "a.lock", "a/.hidden"].map((ref) => ({
        kind: "git" as const,
        ref,
        url: "https://github.com/o/r.git",
      })),
      ...[".git", "node_modules/plugin", RECEIPT, "a/../b", "a//b", "./a", String.raw`a\b`].map(
        (subdir) => ({ kind: "git" as const, subdir, url: "https://github.com/o/r.git" }),
      ),
    ];
    await Promise.all(
      invalid.map(async (source) => {
        await expect(
          parseSource(source.url, {
            cwd: root,
            ...(source.ref === undefined ? {} : { ref: source.ref }),
            ...(source.subdir === undefined ? {} : { subdir: source.subdir }),
          }),
        ).rejects.toThrow();
        expect(() => {
          validateReceipt(receipt(source));
        }).toThrow();
        expect(() => {
          validateReceipt(receipt(source));
        }).not.toThrow("SECRET");
        if (!source.url.startsWith("file:")) {
          await expect(acquireSource(source, join(root, "scratch"))).rejects.toThrow();
          await expect(acquireSource(source, join(root, "scratch"))).rejects.not.toThrow("SECRET");
        }
      }),
    );
    for (const source of [
      { kind: "git", ref: 42, url: "https://github.com/o/r" },
      { kind: "git", subdir: [], url: "https://github.com/o/r" },
      { extra: true, kind: "git", url: "https://github.com/o/r" },
    ]) {
      expect(() => {
        validateReceipt(receipt(source));
      }).toThrow();
    }
  });

  it("fails closed before opening source files on non-Linux platforms", async () => {
    const root = await fixture();
    await writeFile(join(root, "plugin.json"), manifest);
    const filesystem = await import("node:fs/promises");
    const opened = vi.mocked(filesystem.open);
    opened.mockClear();
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    await expect(readMetadata(root)).rejects.toThrow("Secure file containment requires Linux");
    expect(opened).not.toHaveBeenCalled();
  });

  it("fails closed without readable Linux descriptor paths", async () => {
    const root = await fixture();
    await writeFile(join(root, "plugin.json"), manifest);
    const filesystem = await import("node:fs/promises");
    const actual = await vi.importActual<typeof filesystem>("node:fs/promises");
    vi.mocked(filesystem.realpath).mockImplementation(async (file) => {
      if (String(file).startsWith("/proc/self/fd/")) {
        throw new Error("Descriptor paths unavailable");
      }
      return actual.realpath(file);
    });
    try {
      await expect(readMetadata(root)).rejects.toThrow("Descriptor paths unavailable");
    } finally {
      vi.mocked(filesystem.realpath).mockImplementation(actual.realpath);
    }
  });
  it("fingerprints installed additions even in acquisition-excluded locations", async () => {
    const root = await fixture();
    await writeFile(join(root, "plugin.json"), manifest);
    const baseline = await fingerprintDirectory(root);
    for (const name of [".git", "node_modules", "nested"]) {
      const directory = join(root, name);
      // Each case restores the same baseline before the next mutation.
      // eslint-disable-next-line eslint/no-await-in-loop
      await mkdir(directory);
      // eslint-disable-next-line eslint/no-await-in-loop
      await writeFile(join(directory, RECEIPT), "user-added");
      // eslint-disable-next-line eslint/no-await-in-loop
      expect(await fingerprintDirectory(root)).not.toBe(baseline);
      // eslint-disable-next-line eslint/no-await-in-loop
      await rm(directory, { recursive: true });
    }
    await writeFile(join(root, RECEIPT), "manager-owned");
    expect(await fingerprintDirectory(root)).toBe(baseline);
  });

  it("redacts credential URLs and rejects public file transport", async () => {
    const root = await fixture();
    const rejected = parseSource("https://alice:SECRET@example.com/repo.git", { cwd: root });
    await expect(rejected).rejects.toThrow("Unsafe Git URL");
    await expect(rejected).rejects.not.toThrow("SECRET");
    await expect(parseSource("file:///secretpath", { cwd: root })).rejects.toThrow(
      "require HTTPS or SSH",
    );
  });

  it("rejects a parent symlink swapped in at the actual file open", async () => {
    const root = await fixture();
    const source = join(root, "source");
    const parent = join(source, "nested");
    const outside = join(root, "outside");
    await mkdir(parent, { recursive: true });
    await mkdir(outside);
    await writeFile(join(parent, "data"), "safe");
    await writeFile(join(outside, "data"), "EXTERNAL_SECRET");
    const filesystem = await import("node:fs/promises");
    const actual = await vi.importActual<typeof filesystem>("node:fs/promises");
    const originalOpen = actual.open;
    vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
      if (args[0] === join(parent, "data")) {
        await filesystem.rename(parent, join(source, "original"));
        await symlink(outside, parent);
      }
      return originalOpen(...args);
    });
    await expect(snapshotDirectory(source, join(root, "copy"))).rejects.toThrow();
    await expect(readFile(join(root, "copy", "nested", "data"))).rejects.toThrow();
    vi.mocked(filesystem.open).mockImplementation(originalOpen);
  });
  it("canonicalises local folders and never deletes them on disposal", async () => {
    const root = await fixture();
    await writeFile(join(root, "plugin.json"), manifest);
    const source = await parseSource(".", { cwd: root });
    expect(source).toEqual({ kind: "local", path: root });
    const acquired = await acquireSource(source, join(root, "scratch"));
    expect(await readMetadata(acquired.directory)).toEqual({
      format: "agent-plugins",
      manifest: { name: "sample" },
    });
    await acquired.dispose();
    expect(await readFile(join(root, "plugin.json"), "utf8")).toBe(manifest);
  });

  it("parses shorthand, refs and contained subdirectories", async () => {
    const root = await fixture();
    expect(await parseSource("owner/repo#main", { cwd: root, subdir: "plugins/example" })).toEqual({
      kind: "git",
      ref: "main",
      subdir: "plugins/example",
      url: "https://github.com/owner/repo.git",
    });
    expect(await parseSource("git@github.com:owner/repo.git", { cwd: root })).toEqual({
      kind: "git",
      url: "git@github.com:owner/repo.git",
    });
    for (const input of [
      "ext::echo pwned",
      "git://host/repo",
      "https://user:pass@host/repo",
      "https://host/repo#--upload-pack=x",
    ]) {
      // Exercise rejected inputs in order so a failure identifies the input.
      // eslint-disable-next-line eslint/no-await-in-loop
      await expect(parseSource(input, { cwd: root })).rejects.toThrow();
    }
    for (const subdir of ["../escape", "/absolute", "a/../b", String.raw`a\b`, "a//b"]) {
      // Exercise rejected inputs in order so a failure identifies the input.
      // eslint-disable-next-line eslint/no-await-in-loop
      await expect(parseSource("owner/repo", { cwd: root, subdir })).rejects.toThrow();
    }
    await expect(parseSource(".", { cwd: root, ref: "main" })).rejects.toThrow(
      "require a Git source",
    );
  });

  it("copies regular files, excludes dependencies and fingerprints modes and contents", async () => {
    const root = await fixture();
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source);
    await writeFile(join(source, "plugin.json"), manifest);
    await writeFile(join(source, "script"), "hello");
    await mkdir(join(source, "empty"));
    await mkdir(join(source, "node_modules"));
    await writeFile(join(source, "node_modules", "ignored"), "ignored");
    await snapshotDirectory(source, destination);
    const original = await fingerprintDirectory(destination);
    expect(original).toMatch(/^[a-f0-9]{64}$/u);
    expect(original).not.toBe(await fingerprintDirectory(source));
    await writeFile(join(destination, RECEIPT), "receipt");
    expect(await fingerprintDirectory(destination)).toBe(original);
    await chmod(join(destination, "script"), 0o755);
    expect(await fingerprintDirectory(destination)).not.toBe(original);
    await chmod(join(destination, "script"), 0o744);
    const ownerExecutable = await fingerprintDirectory(destination);
    await chmod(join(destination, "script"), 0o754);
    expect(await fingerprintDirectory(destination)).not.toBe(ownerExecutable);
    await chmod(join(destination, "script"), 0o644);
    await writeFile(join(destination, "script"), "different");
    expect(await fingerprintDirectory(destination)).not.toBe(original);
    await expect(readFile(join(destination, "node_modules", "ignored"))).rejects.toThrow();
    await expect(readFile(join(destination, "empty"))).rejects.toThrow();
    await expect(snapshotDirectory(source, destination)).rejects.toThrow("empty");
  });

  it("rejects source links, nested reserved receipts and unsafe destination links", async () => {
    const root = await fixture();
    const source = join(root, "source");
    await mkdir(source);
    await symlink(root, join(source, "escape"));
    await expect(snapshotDirectory(source, join(root, "copy"))).rejects.toThrow("Links");
    await rm(join(source, "escape"));
    await mkdir(join(source, "nested"));
    await writeFile(join(source, "nested", RECEIPT), "malicious");
    await expect(snapshotDirectory(source, join(root, "copy"))).rejects.toThrow("reserved receipt");
    await rm(join(source, "nested", RECEIPT));
    await mkdir(join(root, "target"));
    await symlink(join(root, "target"), join(root, "copy"));
    await expect(snapshotDirectory(source, join(root, "copy"))).rejects.toThrow("real directory");
  });

  it("rejects oversized files and linked manifests without loading plugin configuration", async () => {
    const root = await fixture();
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(root, "outside.json"), manifest);
    await symlink(join(root, "outside.json"), join(source, "plugin.json"));
    await expect(readMetadata(source)).rejects.toThrow();
    await rm(join(source, "plugin.json"));
    await writeFile(join(source, "large"), Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(snapshotDirectory(source, join(root, "copy"))).rejects.toThrow("oversized");
  });

  it("uses manifest priority, does not execute hooks and enforces safe vendor names", async () => {
    const root = await fixture();
    await mkdir(join(root, ".claude-plugin"));
    const vendorPath = join(root, ".claude-plugin", "plugin.json");
    await writeFile(
      vendorPath,
      JSON.stringify({
        hooks: { command: "exit 1" },
        mcpServers: { broken: {} },
        name: "Vendor_name",
      }),
    );
    const vendor = await readMetadata(root);
    expect(vendor.manifest.name).toBe("Vendor_name");
    await writeFile(join(root, "plugin.json"), manifest);
    const portable = await readMetadata(root);
    expect(portable.format).toBe("agent-plugins");
    await writeFile(join(root, "plugin.json"), "{}");
    await expect(readMetadata(root)).rejects.toThrow("Invalid agent-plugins");
    await rm(join(root, "plugin.json"));
    for (const name of ["bad.", "bad-", "x".repeat(65)]) {
      // These cases share one manifest path, so writes and checks must complete in order.
      // eslint-disable-next-line eslint/no-await-in-loop
      await writeFile(vendorPath, JSON.stringify({ name }));
      // These cases share one manifest path, so writes and checks must complete in order.
      // eslint-disable-next-line eslint/no-await-in-loop
      await expect(readMetadata(root)).rejects.toThrow("safe");
    }
  });

  it("extracts disposable bare Git sources, resolves updated refs and keeps pinned commits", async () => {
    const root = await fixture();
    const shared = join(root, "shared.git");
    await mkdir(shared);
    const sharedConfig = "[core]\n bare = false\n";
    await writeFile(join(shared, "config"), sharedConfig);
    vi.stubEnv("GIT_DIR", shared);
    vi.stubEnv("GIT_COMMON_DIR", shared);
    vi.stubEnv("GIT_WORK_TREE", root);
    vi.stubEnv("GIT_INDEX_FILE", join(shared, "index"));
    vi.stubEnv("GIT_CONFIG", join(shared, "config"));
    const repository = join(root, "work");
    await mkdir(repository);
    await runGit(repository, ["init", "-b", "main"]);
    await mkdir(join(repository, "plugins"));
    await writeFile(join(repository, "plugins", "plugin.json"), manifest);
    await writeFile(join(repository, "plugins", "value"), "one");
    await runGit(repository, ["add", "."]);
    await runGit(repository, ["commit", "-m", "first"]);
    const first = await runGit(repository, ["rev-parse", "HEAD"]);
    const bare = join(root, "bare.git");
    await mkdir(bare);
    await runGit(bare, ["init", "--bare"]);
    await runGit(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await runGit(repository, ["push", bare, "main"]);
    const source: Source = {
      kind: "git",
      ref: "main",
      subdir: "plugins",
      url: pathToFileURL(bare).href,
    };
    await writeFile(
      join(bare, "config"),
      '[core]\n bare = true\n[filter "malicious"]\n smudge = touch SHOULD_NOT_RUN\n',
    );
    const acquired = await acquireSource(source, join(root, "scratch"));
    expect(acquired.revision).toBe(first);
    expect(await readFile(join(acquired.directory, "value"), "utf8")).toBe("one");
    const metadata = await readMetadata(acquired.directory);
    expect(metadata.manifest.name).toBe("sample");
    await acquired.dispose();
    await expect(readFile(join(acquired.directory, "value"))).rejects.toThrow();
    await writeFile(join(repository, "plugins", "value"), "two");
    await runGit(repository, ["commit", "-am", "second"]);
    await runGit(repository, ["push", bare, "main"]);
    const updated = await acquireSource(source, join(root, "scratch"));
    expect(updated.revision).not.toBe(first);
    expect(await readFile(join(updated.directory, "value"), "utf8")).toBe("two");
    await updated.dispose();
    const pinned: Source = {
      kind: "git",
      ref: first,
      subdir: "plugins",
      url: pathToFileURL(bare).href,
    };
    const old = await acquireSource(pinned, join(root, "scratch"));
    expect(old.revision).toBe(first);
    expect(await readFile(join(old.directory, "value"), "utf8")).toBe("one");
    await old.dispose();
    await expect(
      acquireSource(
        { kind: "git", subdir: "missing", url: pathToFileURL(bare).href },
        join(root, "scratch"),
      ),
    ).rejects.toThrow("missing");
    await symlink("value", join(repository, "plugins", "link"));
    await runGit(repository, ["add", "."]);
    await runGit(repository, ["commit", "-m", "link"]);
    await runGit(repository, ["push", bare, "main"]);
    await expect(acquireSource(source, join(root, "scratch"))).rejects.toThrow("links");
    await expect(
      acquireSource(
        { kind: "git", subdir: "../escape", url: pathToFileURL(bare).href },
        join(root, "scratch"),
      ),
    ).rejects.toThrow("contained");
    await rm(join(repository, "plugins", "link"));
    await writeFile(join(repository, "plugins", RECEIPT), "malicious");
    await runGit(repository, ["add", "."]);
    await runGit(repository, ["commit", "-m", "receipt"]);
    await runGit(repository, ["push", bare, "main"]);
    await expect(acquireSource(source, join(root, "scratch"))).rejects.toThrow("reserved receipt");
    expect(await readFile(join(shared, "config"), "utf8")).toBe(sharedConfig);
    await expect(readFile(join(shared, "index"))).rejects.toThrow();
  });
});
