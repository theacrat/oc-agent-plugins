import { describe, expect, it } from "vitest";

import { parseManifest } from "#src/manifest.ts";

import { PLUGIN_SCHEMA } from "./fixture.ts";

const parse = (doc: unknown) => parseManifest(JSON.stringify(doc));

describe("parseManifest", () => {
  it("accepts a full manifest and drops extensions", () => {
    const result = parse({
      $schema: PLUGIN_SCHEMA,
      author: { email: "a@b.c", name: "A" },
      description: "d",
      extensions: { "com.other.client": { anything: [1, 2] } },
      keywords: ["k"],
      license: "not-spdx",
      name: "acme.tools",
      version: "not-semver",
    });
    expect(result).toEqual({
      manifest: {
        author: { email: "a@b.c", name: "A" },
        description: "d",
        keywords: ["k"],
        license: "not-spdx",
        name: "acme.tools",
        version: "not-semver",
      },
      ok: true,
      warnings: [],
    });
  });

  it("reports and ignores unknown fields and non-object extensions", () => {
    const result = parse({ $schema: PLUGIN_SCHEMA, extensions: "nope", name: "a", skills: "./x" });
    expect(result).toEqual({
      manifest: { name: "a" },
      ok: true,
      warnings: [
        'ignoring unknown top-level field "skills"',
        "ignoring extensions because it is not an object",
      ],
    });
  });

  it.each([
    ["My-Plugin"],
    ["-start"],
    ["end-"],
    ["has--double"],
    ["too.many..dots"],
    [""],
    ["a".repeat(65)],
  ])("rejects invalid name %j", (name) => {
    expect(parse({ $schema: PLUGIN_SCHEMA, name }).ok).toBe(false);
  });

  it.each([["a"], ["lint3r"], ["acme.tools"], ["a".repeat(64)]])(
    "accepts valid name %j",
    (name) => {
      expect(parse({ $schema: PLUGIN_SCHEMA, name }).ok).toBe(true);
    },
  );

  it("rejects unsupported versions, wrong types and bad authors", () => {
    expect(
      parse({ $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json", name: "a" }),
    ).toEqual({
      error:
        "unsupported Agent Plugins version: https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
      ok: false,
    });
    expect(parse({ name: "a" }).ok).toBe(false);
    expect(parse({ $schema: PLUGIN_SCHEMA, name: "a", version: 1 }).ok).toBe(false);
    expect(parse({ $schema: PLUGIN_SCHEMA, author: { twitter: "x" }, name: "a" }).ok).toBe(false);
    expect(parse({ $schema: PLUGIN_SCHEMA, keywords: [1], name: "a" }).ok).toBe(false);
    expect(parseManifest("{nope").ok).toBe(false);
    expect(parseManifest("[]").ok).toBe(false);
  });
});
