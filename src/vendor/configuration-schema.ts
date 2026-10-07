import { isRecord, isStringArray } from "#src/json.ts";

type ConfigurationValue =
  | string
  | number
  | boolean
  | readonly ConfigurationValue[]
  | { readonly [key: string]: ConfigurationValue };

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

const validateObjectSchema = (
  value: Record<string, unknown>,
  validate: (field: unknown) => Record<string, unknown>,
): void => {
  const { properties, required } = value;
  if (!isRecord(properties)) {
    return fail("object schema needs properties");
  }
  for (const [name, field] of Object.entries(properties)) {
    if (!identifier.test(name)) {
      fail("invalid configuration identifier");
    }
    validate(field);
  }
  if (
    required !== undefined &&
    (!isStringArray(required) || required.some((name) => !Object.hasOwn(properties, name)))
  ) {
    fail("invalid required list");
  }
};

function validateSchema(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || typeof value["type"] !== "string" || !types.has(value["type"])) {
    return fail("unsupported or missing schema type");
  }
  if (Object.keys(value).some((key) => !schemaKeys.has(key))) {
    return fail("unsupported schema keyword");
  }
  validateMetadata(value);
  if (value["type"] === "object") {
    validateObjectSchema(value, validateSchema);
  } else if (value["properties"] !== undefined || value["required"] !== undefined) {
    fail("object keywords require an object");
  }
  if (value["type"] === "array") {
    validateSchema(value["items"]);
  } else if (value["items"] !== undefined) {
    fail("items requires an array");
  }
  return value;
}

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

const validateObjectValue = (
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
  validate: (schema: Readonly<Record<string, unknown>>, value: unknown) => ConfigurationValue,
): void => {
  if (!isRecord(value) || !isRecord(schema["properties"])) {
    return fail("value has the wrong type");
  }
  const { properties } = schema;
  for (const [key, item] of Object.entries(value)) {
    const property = properties[key];
    if (!isRecord(property)) {
      return fail("undeclared configuration value");
    }
    validate(property, item);
  }
  if (
    isStringArray(schema["required"]) &&
    schema["required"].some((key) => !Object.hasOwn(value, key))
  ) {
    fail("required configuration value is missing");
  }
};

function validateValue(
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
): ConfigurationValue {
  const { type } = schema;
  if (type === "array") {
    if (!Array.isArray(value) || !isRecord(schema["items"])) {
      return fail("value has the wrong type");
    }
    for (const item of value) {
      validateValue(schema["items"], item);
    }
  } else if (type === "object") {
    validateObjectValue(schema, value, validateValue);
  } else if (type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      fail("value has the wrong type");
    }
  } else if (typeof value !== type || (typeof value === "number" && !Number.isFinite(value))) {
    fail("value has the wrong type");
  }
  validateConstraints(schema, value);
  return configurationValue(value);
}

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

export type { ConfigurationValue };
export { configurationValue, fail, identifier, validateDefaults, validateSchema, validateValue };
