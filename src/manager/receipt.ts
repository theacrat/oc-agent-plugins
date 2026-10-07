import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateGitSource } from "#src/manager/source-policy.ts";
import { FORMATS } from "#src/types.ts";

import { validateName } from "./paths.ts";
import { RECEIPT } from "./types.ts";
import type { Receipt, Source } from "./types.ts";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (ref !== undefined && typeof ref !== "string") {
    throw new Error("Invalid receipt ref");
  }
  if (subdir !== undefined && typeof subdir !== "string") {
    throw new Error("Invalid receipt subdirectory");
  }
  validateGitSource({
    kind,
    url,
    ...(ref === undefined ? {} : { ref }),
    ...(subdir === undefined ? {} : { subdir }),
  });
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

function sameSource(left: Source, right: Source): boolean {
  if (left.kind === "local" && right.kind === "local") {
    return left.path === right.path;
  }
  if (left.kind === "git" && right.kind === "git") {
    return left.url === right.url && left.ref === right.ref && left.subdir === right.subdir;
  }
  return false;
}

function assertUpdateReceipt(
  previous: Receipt | undefined,
  source: Source,
  expected?: Receipt,
): void {
  validateSourceReference(source);
  if (!previous || !sameSource(previous.source, source)) {
    throw new Error(
      "Installation source changed during acquisition; acquire it again before updating",
    );
  }
  if (!expected) {
    return;
  }
  validateReceipt(expected);
  if (
    previous.schemaVersion !== expected.schemaVersion ||
    previous.name !== expected.name ||
    previous.format !== expected.format ||
    previous.version !== expected.version ||
    previous.revision !== expected.revision ||
    previous.fingerprint !== expected.fingerprint ||
    !sameSource(previous.source, expected.source)
  ) {
    throw new Error(
      "Installation receipt changed during acquisition; acquire it again before updating",
    );
  }
}

export { assertUpdateReceipt, readReceipt, validateReceipt, writeReceipt };
