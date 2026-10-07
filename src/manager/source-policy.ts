import { EXCLUDED, safeRelativePath } from "#src/manager/snapshot.ts";
import { RECEIPT } from "#src/manager/types.ts";
import type { Source } from "#src/manager/types.ts";

type GitSource = Extract<Source, { kind: "git" }>;

const validateSelection = ({ ref, subdir }: GitSource): void => {
  if (
    ref !== undefined &&
    (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(ref) ||
      ref.includes("..") ||
      ref.includes("//") ||
      ref.endsWith("/") ||
      ref.endsWith(".") ||
      ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")))
  ) {
    throw new Error("Unsafe Git ref");
  }
  if (
    subdir !== undefined &&
    (!safeRelativePath(subdir) ||
      subdir.split("/").some((part) => EXCLUDED.has(part) || part === RECEIPT))
  ) {
    throw new Error("Subdirectory must be a contained relative path without reserved directories");
  }
};

const validateGitSource = (source: GitSource, allowFile = false): void => {
  validateSelection(source);
  const { url } = source;
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/u.test(url)) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Unsupported Git URL");
  }
  if (parsed.protocol === "file:" && !allowFile) {
    throw new Error("Public Git sources require HTTPS or SSH transport");
  }
  if (
    !["https:", "ssh:", ...(allowFile ? ["file:"] : [])].includes(parsed.protocol) ||
    parsed.password !== "" ||
    (parsed.protocol !== "ssh:" && parsed.username !== "") ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    /[\s\0\\]/u.test(url) ||
    (parsed.protocol !== "file:" && parsed.hostname === "")
  ) {
    throw new Error("Unsafe Git URL (credentials and query strings are not stored)");
  }
  if (parsed.protocol === "file:" && parsed.hostname !== "" && parsed.hostname !== "localhost") {
    throw new Error("File Git URLs must refer to the local host");
  }
};

export { validateGitSource };
