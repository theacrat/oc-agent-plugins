import { isRecord, isStringArray, parseJson } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import type { Manifest } from "#src/types.ts";

// Hosts namespace components under the name, so it can't contain separators OpenCode uses.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const STRING_FIELDS = ["version", "description", "homepage", "repository", "license"] as const;

type VendorManifestResult =
  | { readonly ok: true; readonly manifest: Manifest; readonly raw: JsonRecord }
  | { readonly ok: false; readonly error: string };

const pickAuthor = (author: unknown) => {
  if (!isRecord(author)) {
    return {};
  }
  const fields = Object.entries(author).filter(
    ([key, value]) => ["name", "email", "url"].includes(key) && typeof value === "string",
  );
  return fields.length === 0 ? {} : { author: Object.fromEntries(fields) };
};

const manifestFrom = (doc: unknown, fallbackName: string | undefined): VendorManifestResult => {
  if (!isRecord(doc)) {
    return { error: "manifest must be a JSON object", ok: false };
  }
  const name = typeof doc["name"] === "string" && doc["name"] !== "" ? doc["name"] : fallbackName;
  if (name === undefined) {
    return { error: "name is required", ok: false };
  }
  if (!NAME.test(name)) {
    return {
      error: `name "${name}" may only contain letters, digits, '.', '_' and '-'`,
      ok: false,
    };
  }
  const strings = Object.fromEntries(
    STRING_FIELDS.flatMap((field) => (typeof doc[field] === "string" ? [[field, doc[field]]] : [])),
  );
  const { keywords } = doc;
  return {
    manifest: {
      name,
      ...strings,
      ...pickAuthor(doc["author"]),
      ...(isStringArray(keywords) && { keywords }),
    },
    ok: true,
    raw: doc,
  };
};

// Vendor manifests are lenient like their hosts: only the name is required.
const parseVendorManifest = (
  text: string,
  fallbackName: string | undefined,
): VendorManifestResult => {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return { error: `invalid JSON: ${parsed.error}`, ok: false };
  }
  return manifestFrom(parsed.value, fallbackName);
};

export type { VendorManifestResult };
export { manifestFrom, parseVendorManifest };
