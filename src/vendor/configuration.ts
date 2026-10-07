import { isRecord, isStringArray } from "#src/json.ts";

type ConfigurationValue =
  | string
  | number
  | boolean
  | readonly ConfigurationValue[]
  | { readonly [key: string]: ConfigurationValue };
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

const fail = (reason: string): never => {
  throw new Error(`Plugin configuration: ${reason}`);
};
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const schemaKeys = new Set([
  "type",
  "title",
  "description",
  "default",
  "enum",
  "const",
  "properties",
  "required",
  "items",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
]);
const claudeKeys = new Set([
  "type",
  "title",
  "description",
  "required",
  "default",
  "options",
  "multiple",
  "sensitive",
  "min",
  "max",
]);
const types = new Set(["string", "number", "integer", "boolean", "array", "object"]);

const validateMetadata = (value: Record<string, unknown>): void => {
  for (const key of ["title", "description"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      fail("invalid schema metadata");
    }
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) < 0)) {
      fail("invalid length constraint");
    }
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]))
    ) {
      fail("invalid numeric constraint");
    }
  }
  if (
    value["enum"] !== undefined &&
    (!Array.isArray(value["enum"]) || value["enum"].length === 0)
  ) {
    fail("invalid enum");
  }
};

const validateSchema = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value) || typeof value["type"] !== "string" || !types.has(value["type"])) {
    return fail("unsupported or missing schema type");
  }
  if (Object.keys(value).some((key) => !schemaKeys.has(key))) {
    return fail("unsupported schema keyword");
  }
  validateMetadata(value);
  if (value["type"] === "object") {
    const { properties } = value;
    if (!isRecord(properties)) {
      return fail("object schema needs properties");
    }
    for (const [name, field] of Object.entries(properties)) {
      if (!identifier.test(name)) {
        fail("invalid configuration identifier");
      }
      validateSchema(field);
    }
    const { required } = value;
    if (
      required !== undefined &&
      (!isStringArray(required) || required.some((name) => !Object.hasOwn(properties, name)))
    ) {
      fail("invalid required list");
    }
  } else if (value["properties"] !== undefined || value["required"] !== undefined) {
    fail("object keywords require an object");
  }
  if (value["type"] === "array") {
    validateSchema(value["items"]);
  } else if (value["items"] !== undefined) {
    fail("items requires an array");
  }
  return value;
};

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const validateConstraints = (schema: Readonly<Record<string, unknown>>, value: unknown): void => {
  if (Array.isArray(schema["enum"]) && !schema["enum"].some((item) => same(item, value))) {
    fail("value is not an allowed option");
  }
  if (Object.hasOwn(schema, "const") && !same(schema["const"], value)) {
    fail("value does not match const");
  }
  let size: number | undefined;
  // JSON Schema lengths count Unicode code points, not grapheme clusters.
  if (typeof value === "string") {
    // oxlint-disable-next-line typescript/no-misused-spread
    size = [...value].length;
  }
  if (Array.isArray(value)) {
    size = value.length;
  }
  const minSize = schema[typeof value === "string" ? "minLength" : "minItems"];
  const maxSize = schema[typeof value === "string" ? "maxLength" : "maxItems"];
  if (
    size !== undefined &&
    ((typeof minSize === "number" && size < minSize) ||
      (typeof maxSize === "number" && size > maxSize))
  ) {
    fail("value violates length constraint");
  }
  if (typeof value === "number") {
    for (const [key, invalid] of [
      ["minimum", (bound: number) => value < bound],
      ["maximum", (bound: number) => value > bound],
      ["exclusiveMinimum", (bound: number) => value <= bound],
      ["exclusiveMaximum", (bound: number) => value >= bound],
    ] as const) {
      const bound = schema[key];
      if (typeof bound === "number" && invalid(bound)) {
        fail("value violates numeric constraint");
      }
    }
  }
};
const configurationValue = (value: unknown): ConfigurationValue => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => configurationValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, configurationValue(item)]),
    );
  }
  return fail("value has the wrong type");
};
const validateValue = (
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
): ConfigurationValue => {
  const { type } = schema;
  if (type === "array") {
    if (!Array.isArray(value) || !isRecord(schema["items"])) {
      return fail("value has the wrong type");
    }
    for (const item of value) {
      validateValue(schema["items"], item);
    }
  } else if (type === "object") {
    if (!isRecord(value) || !isRecord(schema["properties"])) {
      return fail("value has the wrong type");
    }
    const { properties } = schema;
    for (const [key, item] of Object.entries(value)) {
      const property = properties[key];
      if (!isRecord(property)) {
        return fail("undeclared configuration value");
      }
      validateValue(property, item);
    }
    if (
      isStringArray(schema["required"]) &&
      schema["required"].some((key) => !Object.hasOwn(value, key))
    ) {
      fail("required configuration value is missing");
    }
  } else if (type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      fail("value has the wrong type");
    }
  } else if (typeof value !== type || (typeof value === "number" && !Number.isFinite(value))) {
    fail("value has the wrong type");
  }
  validateConstraints(schema, value);
  return configurationValue(value);
};

const validateDefaults = (schema: Readonly<Record<string, unknown>>): void => {
  if (Object.hasOwn(schema, "default")) {
    validateValue(schema, schema["default"]);
  }
  if (isRecord(schema["properties"])) {
    for (const property of Object.values(schema["properties"])) {
      validateDefaults(validateSchema(property));
    }
  }
  if (isRecord(schema["items"])) {
    validateDefaults(schema["items"]);
  }
};

interface Field {
  readonly schema: Readonly<Record<string, unknown>>;
  readonly sensitive: boolean;
  readonly required: boolean;
}
const applyOptions = (field: Record<string, unknown>, schema: Record<string, unknown>): void => {
  const { options, type } = field;
  if (options === undefined) {
    return;
  }
  if (
    type !== "string" ||
    field["multiple"] === true ||
    field["sensitive"] === true ||
    !isStringArray(options) ||
    options.length === 0 ||
    options.some((item) => item.length === 0 || item.length > 64)
  ) {
    fail("invalid userConfig options");
  }
  if (field["default"] === undefined && field["required"] !== true) {
    fail("options requires a default or required flag");
  }
  schema["enum"] = options;
};
const claudeFields = (raw: unknown): Map<string, Field> => {
  if (!isRecord(raw)) {
    return fail("userConfig must be an object");
  }
  return new Map(
    Object.entries(raw).map(([name, field]) => {
      if (
        !identifier.test(name) ||
        !isRecord(field) ||
        Object.keys(field).some((key) => !claudeKeys.has(key))
      ) {
        return fail("invalid userConfig declaration");
      }
      if (typeof field["title"] !== "string" || typeof field["description"] !== "string") {
        fail("userConfig needs title and description");
      }
      for (const key of ["required", "sensitive", "multiple"]) {
        if (field[key] !== undefined && typeof field[key] !== "boolean") {
          fail("invalid userConfig flag");
        }
      }
      const { type } = field;
      if (!["string", "number", "boolean", "directory", "file"].includes(String(type))) {
        fail("unsupported userConfig type");
      }
      if (field["multiple"] === true && type !== "string") {
        fail("multiple requires string type");
      }
      const schema: Record<string, unknown> = {
        type: ["directory", "file"].includes(String(type)) ? "string" : type,
      };
      if (field["multiple"] === true) {
        schema["type"] = "array";
        schema["items"] = { type: "string" };
      }
      applyOptions(field, schema);
      for (const [source, target] of [
        ["min", "minimum"],
        ["max", "maximum"],
      ] as const) {
        if (field[source] !== undefined) {
          if (type !== "number") {
            fail("bounds require number type");
          }
          schema[target] = field[source];
        }
      }
      if (Object.hasOwn(field, "default")) {
        if (field["sensitive"] === true) {
          fail("sensitive defaults are forbidden; use an environment reference");
        }
        schema["default"] = field["default"];
      }
      validateSchema(schema);
      if (Object.hasOwn(schema, "default")) {
        validateValue(schema, schema["default"]);
      }
      return [
        name,
        {
          required: field["required"] === true,
          schema,
          sensitive: field["sensitive"] === true,
        },
      ];
    }),
  );
};

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
const fieldsFor = (input: ConfigurationInput): Map<string, Field> => {
  const options = input.options ?? {};
  let fields = new Map<string, Field>();
  if (input.format === "claude" && input.manifest["userConfig"] !== undefined) {
    fields = claudeFields(input.manifest["userConfig"]);
  }
  if (input.format === "cursor" && input.manifest["variables"] !== undefined) {
    const schema = validateSchema(input.manifest["variables"]);
    validateDefaults(schema);
    const { properties } = schema;
    if (schema["type"] !== "object" || !isRecord(properties)) {
      return fail("variables must be an object schema");
    }
    const required = isStringArray(schema["required"]) ? schema["required"] : [];
    fields = new Map(
      Object.entries(properties).map(([name, field]) => [
        name,
        {
          required: required.includes(name),
          schema: validateSchema(field),
          sensitive: !options.publicVariables?.includes(name),
        },
      ]),
    );
    for (const field of fields.values()) {
      if (field.sensitive && Object.hasOwn(field.schema, "default")) {
        fail("sensitive defaults are forbidden; use an environment reference");
      }
    }
  }
  return fields;
};
const resolveValue = (
  field: Field,
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
const resolveConfiguration = (input: ConfigurationInput): ResolvedConfiguration => {
  const { format } = input;
  const options = input.options ?? {};
  const fields = fieldsFor(structuredClone(input));
  const supplied = (input.format === "claude" ? options.userConfig : options.variables) ?? {};
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
    resolved.set(name, structuredClone(valid));
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
  const pattern =
    format === "claude"
      ? /\$\{user_config\.(?<name>[A-Za-z_][A-Za-z0-9_]*)(?::-(?<fallback>[^}]*))?\}/gu
      : /\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)(?::-(?<fallback>[^}]*))?\}/gu;
  const assertContent = (text: string): void => {
    if (secretStrings.some((secret) => secret !== "" && text.includes(secret))) {
      fail("sensitive value in model body is forbidden");
    }
    for (const match of text.matchAll(pattern)) {
      const name = match.groups?.["name"];
      if (name !== undefined && fields.get(name)?.sensitive === true) {
        fail("sensitive configuration reference in model body is forbidden");
      }
    }
  };
  const expand = (text: string, body: boolean): string => {
    const output = text.replace(pattern, (token: string, ...args: unknown[]) => {
      const groups = args.at(-1);
      const name = isRecord(groups) ? groups["name"] : undefined;
      if (typeof name !== "string") {
        return token;
      }
      const field = fields.get(name);
      if (field === undefined) {
        if (format === "claude") {
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
      const value = resolved.get(name);
      if (value === undefined) {
        return fail("referenced configuration value is missing");
      }
      return textOf(value);
    });
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
        [...resolved].map(([name, value]) => [
          format === "claude" ? `CLAUDE_PLUGIN_OPTION_${name.toUpperCase()}` : name,
          textOf(value),
        ]),
      ),
    values: Object.freeze(publicValues),
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
  if (resolved === undefined || !/^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/u.test(resolved)) {
    return fail("model alias needs an explicit provider/model reference");
  }
  return resolved;
};

export type {
  ConfigurationInput,
  ConfigurationValue,
  EnvironmentReference,
  PluginConfigurationOptions,
  ResolvedConfiguration,
};
export { resolveConfiguration, resolveModelAlias };
