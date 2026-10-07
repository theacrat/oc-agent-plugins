import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { FORMATS } from "#src/types.ts";

import { validateName } from "./paths.ts";
import { RECEIPT } from "./types.ts";
import type { Receipt, Source } from "./types.ts";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateGitUrl(url: string): void {
  if (/^git@[a-zA-Z0-9.-]+:[^\s?#]+$/u.test(url)) {
    return;
  }
  const parsed = new URL(url);
  if (
    !["https:", "ssh:"].includes(parsed.protocol) ||
    parsed.password ||
    (parsed.protocol === "https:" && parsed.username) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Unsafe receipt Git URL (credentials and query strings are not stored)");
  }
}

function validateSourceReference(value: unknown): asserts value is Source {
  if (!object(value)) {
    throw new Error("Invalid receipt source");
  }
  const { kind, path: localPath, url, ref, subdir } = value;
  const keys = kind === "local" ? ["kind", "path"] : ["kind", "url", "ref", "subdir"];
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error("Unexpected receipt source fields");
  }
  if (kind === "local" && typeof localPath === "string" && path.isAbsolute(localPath)) {
    return;
  }
  if (kind !== "git" || typeof url !== "string") {
    throw new Error("Invalid receipt source");
  }
  validateGitUrl(url);
  if (
    ref !== undefined &&
    (typeof ref !== "string" ||
      !ref ||
      /\s/u.test(ref) ||
      ref.split("").some((character) => (character.codePointAt(0) ?? 0) < 32))
  ) {
    throw new Error("Invalid receipt ref");
  }
  if (
    subdir !== undefined &&
    (typeof subdir !== "string" ||
      !subdir ||
      path.isAbsolute(subdir) ||
      subdir.split(/[\\/]/u).includes(".."))
  ) {
    throw new Error("Invalid receipt subdirectory");
  }
}

function validateReceipt(value: unknown): asserts value is Receipt {
  if (!object(value)) {
    throw new Error("Invalid or unsupported installation receipt");
  }
  const { schemaVersion, name, format, fingerprint, version, revision, source } = value;
  const keys = new Set([
    "schemaVersion",
    "name",
    "format",
    "fingerprint",
    "version",
    "revision",
    "source",
  ]);
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error("Unexpected receipt fields");
  }
  if (schemaVersion !== 1 || typeof name !== "string") {
    throw new Error("Invalid or unsupported installation receipt");
  }
  validateName(name);
  if (
    !FORMATS.some((candidate) => candidate === format) ||
    typeof fingerprint !== "string" ||
    !fingerprint
  ) {
    throw new Error("Invalid installation receipt format or fingerprint");
  }
  if (version !== undefined && typeof version !== "string") {
    throw new Error("Invalid receipt version");
  }
  if (
    revision !== undefined &&
    (typeof revision !== "string" || !/^[a-fA-F0-9]{40,64}$/u.test(revision))
  ) {
    throw new Error("Invalid receipt revision");
  }
  validateSourceReference(source);
}

async function readReceipt(directory: string): Promise<Receipt> {
  const receiptPath = path.join(directory, RECEIPT);
  const stat = await lstat(receiptPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Unsafe installation receipt");
  }
  const value: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
  validateReceipt(value);
  return value;
}

async function writeReceipt(directory: string, receipt: Receipt): Promise<void> {
  validateReceipt(receipt);
  await writeFile(path.join(directory, RECEIPT), `${JSON.stringify(receipt, undefined, 2)}\n`, {
    flag: "wx",
  });
}

export { readReceipt, validateReceipt, writeReceipt };
