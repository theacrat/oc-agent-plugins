import { parse } from "yaml";

import { errorMessage, isRecord } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";

const FRONTMATTER = /^\uFEFF?---\r?\n(?<yaml>[\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/u;

type FrontmatterResult =
  | { readonly ok: true; readonly data: JsonRecord; readonly body: string }
  | { readonly ok: false; readonly error: string };

// Claude Code and Cursor accept frontmatter that isn't strict YAML, such as
// `argument-hint: [file] [--flag]`. Read it as flat `key: value` lines instead.
const parseLoose = (yaml: string): JsonRecord =>
  Object.fromEntries(
    yaml.split(/\r?\n/u).flatMap((line) => {
      const match = /^(?<key>[A-Za-z][\w-]*):\s*(?<value>.*)$/u.exec(line);
      const key = match?.groups?.["key"];
      const raw = match?.groups?.["value"]?.trim() ?? "";
      if (key === undefined) {
        return [];
      }
      const unquoted = /^(?<quote>["']).*\k<quote>$/u.test(raw) ? raw.slice(1, -1) : raw;
      const booleans: Readonly<Record<string, boolean>> = { false: false, true: true };
      return [[key, booleans[unquoted] ?? unquoted]];
    }),
  );

// Markdown without frontmatter is valid for vendor components. `strict` is for Agent Skills, which
// must have valid YAML frontmatter; vendor files fall back to a line-based read.
const parseFrontmatter = (text: string, strict: boolean): FrontmatterResult => {
  const match = FRONTMATTER.exec(text);
  const yaml = match?.groups?.["yaml"];
  if (match === null || yaml === undefined) {
    return strict
      ? { error: "must start with YAML frontmatter", ok: false }
      : { body: text.trim(), data: {}, ok: true };
  }
  let data: unknown;
  try {
    data = yaml.trim() === "" ? {} : parse(yaml);
  } catch (error) {
    if (!strict) {
      return { body: text.slice(match[0].length).trim(), data: parseLoose(yaml), ok: true };
    }
    return { error: `invalid frontmatter YAML: ${errorMessage(error)}`, ok: false };
  }
  if (!isRecord(data)) {
    return { error: "frontmatter must be a YAML mapping", ok: false };
  }
  return { body: text.slice(match[0].length).trim(), data, ok: true };
};

const optionalString = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

export type { FrontmatterResult };
export { optionalString, parseFrontmatter };
