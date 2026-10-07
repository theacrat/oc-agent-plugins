import { isRecord, isStringArray } from "#src/json.ts";
import { fieldsFor } from "#src/vendor/configuration-fields.ts";
import type { ConfigurationField } from "#src/vendor/configuration-fields.ts";
import {
  configurationValue,
  fail,
  identifier,
  validateValue,
} from "#src/vendor/configuration-schema.ts";
import type { ConfigurationValue } from "#src/vendor/configuration-schema.ts";

interface EnvironmentReference {
  readonly env: string;
}
interface PluginConfigurationOptions {
  readonly userConfig?: Readonly<Record<string, ConfigurationValue | EnvironmentReference>>;
  readonly variables?: Readonly<Record<string, ConfigurationValue | EnvironmentReference>>;
  // Cursor does not declare sensitivity. Only explicitly public variables may enter model bodies.
  readonly publicVariables?: readonly string[];
  readonly modelAliases?: Readonly<Record<string, string>>;
}
interface ConfigurationInput {
  readonly format: "claude" | "cursor" | "codex";
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly options?: PluginConfigurationOptions;
  readonly env: Readonly<Record<string, string | undefined>>;
}
interface ResolvedConfiguration {
  readonly values: Readonly<Record<string, ConfigurationValue>>;
  readonly expand: (text: string) => string;
  readonly expandContent: (text: string) => string;
  readonly assertContent: (text: string) => void;
  readonly hookEnvironment: () => Readonly<Record<string, string>>;
}
interface ConfigurationSnapshot {
  readonly format: ConfigurationInput["format"];
  readonly fields: ReadonlyMap<string, ConfigurationField>;
  readonly resolved: ReadonlyMap<string, ConfigurationValue>;
  readonly publicValues: Readonly<Record<string, ConfigurationValue>>;
  readonly secretStrings: readonly string[];
}

const textOf = (value: ConfigurationValue): string =>
  typeof value === "string" ? value : JSON.stringify(value);
const secretParts = (value: ConfigurationValue): string[] => {
  if (Array.isArray(value)) {
    return [textOf(value), ...value.flatMap((item: ConfigurationValue) => secretParts(item))];
  }
  if (isRecord(value)) {
    return [
      textOf(value),
      ...Object.values(value).flatMap((item) => secretParts(configurationValue(item))),
    ];
  }
  return [textOf(value)];
};

const resolveValue = (
  field: ConfigurationField,
  supplied: unknown,
  env: ConfigurationInput["env"],
): ConfigurationValue | undefined => {
  let value: unknown = supplied === undefined ? field.schema["default"] : supplied;
  if (isRecord(value) && Object.keys(value).length === 1 && typeof value["env"] === "string") {
    if (!identifier.test(value["env"])) {
      fail("invalid environment reference");
    }
    const fromEnv = env[value["env"]];
    if (fromEnv === undefined) {
      return fail("referenced environment variable is unavailable");
    }
    value = fromEnv;
    if (field.schema["type"] !== "string") {
      try {
        value = JSON.parse(fromEnv) as unknown;
      } catch {
        fail("environment value has the wrong type");
      }
    }
  } else if (field.sensitive && value !== undefined) {
    fail("sensitive values must use an environment reference");
  }
  if (value === undefined) {
    if (field.required) {
      fail("required configuration value is missing");
    }
    return undefined;
  }
  const valid = validateValue(field.schema, value);
  if (field.required && (valid === "" || (Array.isArray(valid) && valid.length === 0))) {
    fail("required configuration value is empty");
  }
  return valid;
};

const validateOptions = (options: unknown): void => {
  if (!isRecord(options)) {
    fail("options must be an object");
    return;
  }
  for (const key of ["userConfig", "variables"]) {
    if (options[key] !== undefined && !isRecord(options[key])) {
      fail("supplied configuration must be an object");
    }
  }
  if (options["publicVariables"] !== undefined && !isStringArray(options["publicVariables"])) {
    fail("publicVariables must be an array of names");
  }
  const aliases = options["modelAliases"];
  if (
    aliases !== undefined &&
    (!isRecord(aliases) || Object.values(aliases).some((value) => typeof value !== "string"))
  ) {
    fail("modelAliases must map names to strings");
  }
};

const captureConfiguration = (input: ConfigurationInput): ConfigurationSnapshot => {
  const { format } = input;
  if (input.options !== undefined) {
    validateOptions(input.options);
  }
  const options = input.options ?? {};
  const fields = fieldsFor(input);
  const supplied = (format === "claude" ? options.userConfig : options.variables) ?? {};
  if (
    Object.keys(supplied).some((name) => !fields.has(name)) ||
    options.publicVariables?.some((name) => !fields.has(name))
  ) {
    fail("undeclared configuration value");
  }
  const resolved = new Map<string, ConfigurationValue>();
  const publicValues: Record<string, ConfigurationValue> = {};
  const secretStrings: string[] = [];
  for (const [name, field] of fields) {
    const valid = resolveValue(field, supplied[name], input.env);
    if (valid === undefined) {
      continue;
    }
    resolved.set(name, valid);
    if (field.sensitive) {
      secretStrings.push(...secretParts(valid));
    } else {
      publicValues[name] = structuredClone(valid);
    }
  }
  if (
    Object.values(publicValues).some((value) =>
      secretStrings.some((secret) => secret !== "" && textOf(value).includes(secret)),
    )
  ) {
    fail("public configuration overlaps a sensitive value");
  }
  return { fields, format, publicValues: Object.freeze(publicValues), resolved, secretStrings };
};

const assertBody = (snapshot: ConfigurationSnapshot, pattern: RegExp, text: string): void => {
  if (snapshot.secretStrings.some((secret) => secret !== "" && text.includes(secret))) {
    fail("sensitive value in model body is forbidden");
  }
  for (const match of text.matchAll(pattern)) {
    const name = match.groups?.["name"];
    if (name !== undefined && snapshot.fields.get(name)?.sensitive === true) {
      fail("sensitive configuration reference in model body is forbidden");
    }
  }
};

const expandToken = (
  snapshot: ConfigurationSnapshot,
  token: string,
  groups: unknown,
  body: boolean,
): string => {
  const name = isRecord(groups) ? groups["name"] : undefined;
  if (typeof name !== "string") {
    return token;
  }
  const field = snapshot.fields.get(name);
  if (field === undefined) {
    if (snapshot.format === "claude") {
      fail("reference to undeclared configuration");
    }
    return token;
  }
  if (body && field.sensitive) {
    fail("sensitive configuration reference in model body is forbidden");
  }
  if (isRecord(groups) && groups["fallback"] !== undefined) {
    fail("configuration reference fallbacks are unsupported; declare a default");
  }
  const value = snapshot.resolved.get(name);
  if (value === undefined) {
    return fail("referenced configuration value is missing");
  }
  return textOf(value);
};

const resolveConfiguration = (input: ConfigurationInput): ResolvedConfiguration => {
  const snapshot = captureConfiguration(structuredClone(input));
  const pattern =
    snapshot.format === "claude"
      ? /\$\{user_config\.(?<name>[A-Za-z_][A-Za-z0-9_]*)(?::-(?<fallback>[^}]*))?\}/gu
      : /\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)(?::-(?<fallback>[^}]*))?\}/gu;
  const assertContent = (text: string): void => {
    assertBody(snapshot, pattern, text);
  };
  const expand = (text: string, body: boolean): string => {
    const output = text.replace(pattern, (token: string, ...args: unknown[]) =>
      expandToken(snapshot, token, args.at(-1), body),
    );
    if (body) {
      assertContent(output);
    }
    return output;
  };
  return {
    assertContent,
    expand: (text) => expand(text, false),
    expandContent: (text) => expand(text, true),
    hookEnvironment: () =>
      Object.fromEntries(
        [...snapshot.resolved].map(([name, value]) => [
          snapshot.format === "claude" ? `CLAUDE_PLUGIN_OPTION_${name.toUpperCase()}` : name,
          textOf(value),
        ]),
      ),
    values: snapshot.publicValues,
  };
};

const resolveModelAlias = (
  model: string | undefined,
  aliases: Readonly<Record<string, string>> = {},
): string | undefined => {
  if (model === undefined || model === "inherit") {
    return undefined;
  }
  const resolved = Object.hasOwn(aliases, model) ? aliases[model] : model;
  if (typeof resolved !== "string" || !/^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/u.test(resolved)) {
    return fail("model alias needs an explicit provider/model reference");
  }
  return resolved;
};

export type {
  ConfigurationInput,
  EnvironmentReference,
  PluginConfigurationOptions,
  ResolvedConfiguration,
};
export type { ConfigurationValue } from "#src/vendor/configuration-schema.ts";
export { resolveConfiguration, resolveModelAlias };
