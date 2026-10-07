import { describe, expect, it } from "vitest";

import { resolveConfiguration, resolveModelAlias } from "#src/vendor/configuration.ts";
import { placeholdersFor } from "#src/vendor/placeholders.ts";

const field = (extra: Record<string, unknown> = {}) => ({
  description: "A value",
  title: "Value",
  type: "string",
  ...extra,
});
const secret = "private-token-123";

describe("declared configuration", () => {
  it("rejects implicit type coercion and malformed runtime options", () => {
    for (const type of [["directory"], ["file"], 1, undefined]) {
      expect(() =>
        resolveConfiguration({
          env: {},
          format: "claude",
          manifest: { userConfig: { value: field({ type }) } },
        }),
      ).toThrow("unsupported userConfig type");
    }
    expect(() =>
      resolveConfiguration({
        env: {},
        format: "claude",
        manifest: {},
        // @ts-expect-error Runtime options originate outside TypeScript.
        options: { userConfig: "bad" },
      }),
    ).toThrow("must be an object");
    expect(() =>
      resolveConfiguration({
        env: {},
        format: "cursor",
        manifest: {},
        // @ts-expect-error A string must not be accepted as a list of public variable names.
        options: { publicVariables: "TOKEN" },
      }),
    ).toThrow("array of names");
    expect(() =>
      resolveConfiguration({
        env: {},
        format: "cursor",
        manifest: {},
        // @ts-expect-error Aliases are validated at the runtime options boundary.
        options: { modelAliases: { sonnet: 123 } },
      }),
    ).toThrow("map names to strings");
  });

  it("keeps nested secrets private and rejects public overlap without exposing diagnostics", () => {
    const input = {
      env: { TOKEN: JSON.stringify({ token: secret }) },
      format: "cursor" as const,
      manifest: {
        variables: {
          properties: {
            PRIVATE: {
              properties: { token: { type: "string" } },
              required: ["token"],
              type: "object",
            },
            PUBLIC: { type: "string" },
          },
          type: "object",
        },
      },
      options: { publicVariables: ["PUBLIC"], variables: { PRIVATE: { env: "TOKEN" } } },
    };
    const config = resolveConfiguration(input);
    expect(config.values).toEqual({});
    expect(JSON.stringify(config)).not.toContain(secret);
    expect(() => config.expandContent(secret)).toThrow("forbidden");
    expect(() => config.expandContent(`\${PRIVATE}`)).toThrow("forbidden");
    expect(() =>
      resolveConfiguration({
        ...input,
        options: { ...input.options, variables: { ...input.options.variables, PUBLIC: secret } },
      }),
    ).toThrow("overlaps a sensitive value");
  });

  it("captures schema sensitivity before later manifest mutation", () => {
    const token = { ...field(), sensitive: true };
    const input = {
      env: { TOKEN: secret },
      format: "claude" as const,
      manifest: { userConfig: { token } },
      options: { userConfig: { token: { env: "TOKEN" } } },
    };
    const config = resolveConfiguration(input);
    token.sensitive = false;
    expect(() => config.expandContent(`\${user_config.token}`)).toThrow("forbidden");
    expect(config.expand(`\${user_config.token}`)).toBe(secret);
  });

  it("does not let mutable public snapshots change transport configuration", () => {
    const config = resolveConfiguration({
      env: {},
      format: "claude",
      manifest: { userConfig: { tags: field({ default: ["one"], multiple: true }) } },
    });
    const { tags } = config.values;
    if (Array.isArray(tags)) {
      tags.push("changed");
    }
    expect(config.expand(`\${user_config.tags}`)).toBe('["one"]');
  });

  it("validates defaults, supplied typed values, options and required fields", () => {
    const config = resolveConfiguration({
      env: {},
      format: "claude",
      manifest: {
        userConfig: {
          count: field({ max: 5, min: 1, required: true, type: "number" }),
          enabled: field({ default: false, type: "boolean" }),
          tags: field({ default: ["one", "two"], multiple: true }),
          tone: field({ default: "warm", options: ["warm", "neutral"] }),
        },
      },
      options: { userConfig: { count: 3 } },
    });
    expect(config.values).toEqual({ count: 3, enabled: false, tags: ["one", "two"], tone: "warm" });
    expect(
      config.expandContent(`\${user_config.tone} \${user_config.count} \${user_config.tags}`),
    ).toBe('warm 3 ["one","two"]');
    expect(() =>
      resolveConfiguration({
        env: {},
        format: "claude",
        manifest: { userConfig: { count: field({ required: true, type: "number" }) } },
      }),
    ).toThrow("required");
    expect(() =>
      resolveConfiguration({
        env: {},
        format: "claude",
        manifest: { userConfig: { count: field({ max: 2, type: "number" }) } },
        options: { userConfig: { count: 3 } },
      }),
    ).toThrow("numeric");
  });

  it("resolves secrets only from explicitly supplied env references and rejects body references", () => {
    const input = {
      env: { TOKEN: secret },
      format: "claude" as const,
      manifest: {
        userConfig: {
          label: field({ default: "public" }),
          token: field({ required: true, sensitive: true }),
        },
      },
    };
    const config = resolveConfiguration({
      ...input,
      options: { userConfig: { token: { env: "TOKEN" } } },
    });
    expect(config.expand(`Bearer \${user_config.token}`)).toBe(`Bearer ${secret}`);
    expect(config.hookEnvironment()).toEqual({
      CLAUDE_PLUGIN_OPTION_LABEL: "public",
      CLAUDE_PLUGIN_OPTION_TOKEN: secret,
    });
    expect(JSON.stringify(config)).not.toContain(secret);
    for (const body of [`\${user_config.token}`, `\${user_config.token:-fallback}`, secret]) {
      expect(() => config.expandContent(body)).toThrow("forbidden");
    }
    let message = "";
    try {
      resolveConfiguration({ ...input, options: { userConfig: { token: secret } } });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("environment reference");
    expect(message).not.toContain(secret);
    expect(() =>
      resolveConfiguration({
        ...input,
        env: {},
        options: { userConfig: { token: { env: "TOKEN" } } },
      }),
    ).toThrow("unavailable");
  });

  it("validates Cursor schemas and keeps unspecified sensitivity private", () => {
    const input = {
      env: { TOKEN: secret },
      format: "cursor" as const,
      manifest: {
        variables: {
          properties: {
            API_TOKEN: { minLength: 3, type: "string" },
            COUNT: { default: 2, minimum: 1, type: "integer" },
            FLAGS: { default: [true], items: { type: "boolean" }, type: "array" },
          },
          required: ["API_TOKEN"],
          type: "object",
        },
      },
    };
    const config = resolveConfiguration({
      ...input,
      options: { publicVariables: ["COUNT", "FLAGS"], variables: { API_TOKEN: { env: "TOKEN" } } },
    });
    expect(config.values).toEqual({ COUNT: 2, FLAGS: [true] });
    expect(config.expand(`\${API_TOKEN}/\${COUNT}`)).toBe(`${secret}/2`);
    expect(() => config.expandContent(`\${API_TOKEN}`)).toThrow("forbidden");
    expect(config.expandContent(`\${COUNT}`)).toBe("2");
    expect(() =>
      resolveConfiguration({
        ...input,
        options: {
          publicVariables: ["COUNT", "FLAGS"],
          variables: { API_TOKEN: { env: "TOKEN" }, COUNT: 1.5 },
        },
      }),
    ).toThrow("wrong type");
    expect(() =>
      resolveConfiguration({
        env: {},
        format: "cursor",
        manifest: {
          variables: { properties: { token: { pattern: ".*", type: "string" } }, type: "object" },
        },
      }),
    ).toThrow("unsupported schema");
  });

  it("expands paths and configuration in one pass without rescanning inserted values", () => {
    const configuration = resolveConfiguration({
      env: { TOKEN: secret },
      format: "claude",
      manifest: { userConfig: { label: field(), token: field({ sensitive: true }) } },
      options: { userConfig: { label: `\${CLAUDE_PLUGIN_ROOT}`, token: { env: "TOKEN" } } },
    });
    const placeholders = placeholdersFor("claude", {
      configuration,
      dataDir: "/data",
      env: { TOKEN: secret },
      root: "/plugin",
    });
    expect(placeholders.expandContent(`\${CLAUDE_PLUGIN_ROOT} \${user_config.label}`)).toBe(
      `/plugin \${CLAUDE_PLUGIN_ROOT}`,
    );
    expect(placeholders.expand(`\${user_config.token}`)).toBe(secret);
    expect(() =>
      placeholders.expandContent(`\${user_config.token}`, { "user_config.token": "override" }),
    ).toThrow("forbidden");
    expect(() => placeholders.expandContent(`\${EXTRA}`, { EXTRA: secret })).toThrow("forbidden");
  });

  it("captures values at load time and replaces them only on an explicit new resolution", () => {
    const env = { TOKEN: "old-secret" };
    const input = {
      env,
      format: "claude" as const,
      manifest: { userConfig: { token: field({ sensitive: true }) } },
      options: { userConfig: { token: { env: "TOKEN" } } },
    };
    const before = resolveConfiguration(input);
    env.TOKEN = "new-secret";
    expect(before.expand(`\${user_config.token}`)).toBe("old-secret");
    expect(resolveConfiguration(input).expand(`\${user_config.token}`)).toBe("new-secret");
  });

  it("rejects unknown values, malformed declarations and sensitive defaults safely", () => {
    for (const declaration of [
      field({ unknown: secret }),
      field({ default: secret, sensitive: true }),
      field({ required: "yes" }),
      field({ default: "two", options: ["one"] }),
    ]) {
      expect(() =>
        resolveConfiguration({
          env: {},
          format: "claude",
          manifest: { userConfig: { token: declaration } },
        }),
      ).toThrow();
    }
    expect(() =>
      resolveConfiguration({
        env: {},
        format: "claude",
        manifest: {},
        options: { userConfig: { unknown: secret } },
      }),
    ).toThrow("undeclared");
  });

  it("rejects sensitive references introduced by public substitutions and invalid unused defaults", () => {
    const config = resolveConfiguration({
      env: { TOKEN: secret },
      format: "claude",
      manifest: { userConfig: { label: field(), token: field({ sensitive: true }) } },
      options: { userConfig: { label: `\${user_config.token}`, token: { env: "TOKEN" } } },
    });
    expect(() => config.expandContent(`\${user_config.label}`)).toThrow("forbidden");
    expect(() =>
      resolveConfiguration({
        env: {},
        format: "cursor",
        manifest: {
          variables: {
            properties: { count: { default: "invalid", type: "integer" } },
            type: "object",
          },
        },
        options: { publicVariables: ["count"], variables: { count: 1 } },
      }),
    ).toThrow("wrong type");
  });

  it("resolves only explicit model aliases and allows inheritance", () => {
    expect(resolveModelAlias("sonnet", { sonnet: "anthropic/claude-sonnet" })).toBe(
      "anthropic/claude-sonnet",
    );
    expect(resolveModelAlias("provider/models/nested")).toBe("provider/models/nested");
    expect(resolveModelAlias("inherit")).toBeUndefined();
    expect(() => resolveModelAlias("sonnet")).toThrow("provider/model");
    expect(() => resolveModelAlias("sonnet", { sonnet: "opus" })).toThrow("provider/model");
  });
});
