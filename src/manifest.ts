import { isRecord, isStringArray, parseJson } from "@/json.ts";
import type { JsonRecord } from "@/json.ts";
import { PLUGIN_SCHEMA } from "@/types.ts";
import type { Manifest } from "@/types.ts";

const NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const STRING_FIELDS = ["version", "description", "homepage", "repository", "license"] as const;
const AUTHOR_FIELDS = new Set(["name", "email", "url"]);
const KNOWN_FIELDS = new Set([
  "$schema",
  "name",
  "author",
  "keywords",
  "extensions",
  ...STRING_FIELDS,
]);

type ManifestResult =
  | { readonly ok: true; readonly manifest: Manifest; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string };

const fail = (error: string): ManifestResult => ({ error, ok: false });

const checkAuthor = (author: unknown): string | undefined => {
  if (!isRecord(author)) {
    return "author must be an object";
  }
  for (const [key, value] of Object.entries(author)) {
    if (!AUTHOR_FIELDS.has(key)) {
      return `author.${key} is not a permitted field`;
    }
    if (typeof value !== "string") {
      return `author.${key} must be a string`;
    }
  }
  return undefined;
};

const checkFields = (doc: JsonRecord): string | undefined => {
  if (doc["$schema"] !== PLUGIN_SCHEMA) {
    return typeof doc["$schema"] === "string"
      ? `unsupported Agent Plugins version: ${doc["$schema"]}`
      : "$schema is missing or not a string";
  }
  const { name } = doc;
  if (typeof name !== "string" || name.length > 64 || !NAME.test(name)) {
    return "name must be 1-64 characters of a-z, 0-9, '-' or '.', start and end alphanumeric, with no '--' or '..'";
  }
  const badString = STRING_FIELDS.find((field) => field in doc && typeof doc[field] !== "string");
  if (badString !== undefined) {
    return `${badString} must be a string`;
  }
  if ("keywords" in doc && !isStringArray(doc["keywords"])) {
    return "keywords must be an array of strings";
  }
  return "author" in doc ? checkAuthor(doc["author"]) : undefined;
};

const pickStrings = (doc: JsonRecord) =>
  Object.fromEntries(
    STRING_FIELDS.flatMap((field) => (typeof doc[field] === "string" ? [[field, doc[field]]] : [])),
  );

const pickAuthor = (author: unknown) =>
  isRecord(author)
    ? {
        author: Object.fromEntries(
          Object.entries(author).map(([key, value]) => [key, String(value)]),
        ),
      }
    : {};

const parseManifest = (text: string): ManifestResult => {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return fail(`plugin.json is not valid JSON: ${parsed.error}`);
  }
  const doc = parsed.value;
  if (!isRecord(doc)) {
    return fail("plugin.json must contain a JSON object");
  }
  const error = checkFields(doc);
  if (error !== undefined) {
    return fail(error);
  }

  const warnings = Object.keys(doc)
    .filter((key) => !KNOWN_FIELDS.has(key))
    .map((key) => `ignoring unknown top-level field "${key}"`);
  if ("extensions" in doc && !isRecord(doc["extensions"])) {
    warnings.push("ignoring extensions because it is not an object");
  }
  const { keywords } = doc;
  const manifest: Manifest = {
    name: String(doc["name"]),
    ...pickStrings(doc),
    ...pickAuthor(doc["author"]),
    ...(isStringArray(keywords) && { keywords }),
  };
  return { manifest, ok: true, warnings };
};

export type { ManifestResult };
export { parseManifest };
