import { realpath, stat } from "node:fs/promises";
import path from "node:path";

type Resolved =
  | { readonly kind: "missing" }
  | { readonly kind: "outside" }
  | { readonly kind: "file" | "directory" | "other"; readonly path: string };

const isWithin = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// Follows symlinks, then checks the real target is still inside `root` (which must already be a realpath).
const resolveWithin = async (root: string, target: string): Promise<Resolved> => {
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    return { kind: "missing" };
  }
  if (!isWithin(root, real)) {
    return { kind: "outside" };
  }
  const info = await stat(real);
  if (info.isFile()) {
    return { kind: "file", path: real };
  }
  if (info.isDirectory()) {
    return { kind: "directory", path: real };
  }
  return { kind: "other", path: real };
};

export type { Resolved };
export { isWithin, resolveWithin };
