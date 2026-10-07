import { isRecord, isStringArray } from "#src/json.ts";
import {
  fail,
  identifier,
  validateDefaults,
  validateSchema,
  validateValue,
} from "#src/vendor/configuration-schema.ts";
import type { ConfigurationInput } from "#src/vendor/configuration.ts";

interface ConfigurationField {
  readonly schema: Readonly<Record<string, unknown>>;
  readonly sensitive: boolean;
  readonly required: boolean;
}
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

const validateClaudeField = (name: string, field: unknown): Record<string, unknown> => {
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
  if (
    typeof type !== "string" ||
    !["string", "number", "boolean", "directory", "file"].includes(type)
  ) {
    fail("unsupported userConfig type");
  }
  if (field["multiple"] === true && type !== "string") {
    fail("multiple requires string type");
  }
  return field;
};

const claudeSchema = (field: Record<string, unknown>): Record<string, unknown> => {
  const { type } = field;
  const schema: Record<string, unknown> = {
    type: type === "directory" || type === "file" ? "string" : type,
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
  return schema;
};

const claudeFields = (raw: unknown): Map<string, ConfigurationField> => {
  if (!isRecord(raw)) {
    return fail("userConfig must be an object");
  }
  return new Map(
    Object.entries(raw).map(([name, rawField]) => {
      const field = validateClaudeField(name, rawField);
      return [
        name,
        {
          required: field["required"] === true,
          schema: claudeSchema(field),
          sensitive: field["sensitive"] === true,
        },
      ];
    }),
  );
};

const cursorFields = (
  raw: unknown,
  publicVariables: readonly string[] = [],
): Map<string, ConfigurationField> => {
  const schema = validateSchema(raw);
  validateDefaults(schema);
  const { properties } = schema;
  if (schema["type"] !== "object" || !isRecord(properties)) {
    return fail("variables must be an object schema");
  }
  const required = isStringArray(schema["required"]) ? schema["required"] : [];
  return new Map(
    Object.entries(properties).map(([name, rawField]) => {
      const field = validateSchema(rawField);
      const sensitive = !publicVariables.includes(name);
      if (sensitive && Object.hasOwn(field, "default")) {
        fail("sensitive defaults are forbidden; use an environment reference");
      }
      return [name, { required: required.includes(name), schema: field, sensitive }];
    }),
  );
};

const fieldsFor = (input: ConfigurationInput): Map<string, ConfigurationField> => {
  if (input.format === "claude" && input.manifest["userConfig"] !== undefined) {
    return claudeFields(input.manifest["userConfig"]);
  }
  if (input.format === "cursor" && input.manifest["variables"] !== undefined) {
    return cursorFields(input.manifest["variables"], input.options?.publicVariables);
  }
  return new Map();
};

export type { ConfigurationField };
export { fieldsFor };
