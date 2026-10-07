import { isRecord, isStringArray, isStringRecord } from "#src/json.ts";
import type { Report } from "#src/types.ts";
import type {
  ConfigurationValue,
  EnvironmentReference,
  PluginConfigurationOptions,
} from "#src/vendor/configuration.ts";

const validValue = (value: unknown): value is ConfigurationValue | EnvironmentReference => {
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => validValue(item));
  }
  return isRecord(value) && Object.values(value).every((item) => validValue(item));
};

const configMap = (raw: unknown): Record<string, ConfigurationValue | EnvironmentReference> => {
  const result: Record<string, ConfigurationValue | EnvironmentReference> = {};
  if (raw === undefined) {
    return result;
  }
  if (!isRecord(raw)) {
    throw new Error("configuration maps must be objects");
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!validValue(value)) {
      throw new Error("configuration values must be JSON values or environment references");
    }
    result[key] = value;
  }
  return result;
};

const parseConfigurationOptions = (
  value: unknown,
  report: Report,
): Record<string, PluginConfigurationOptions> => {
  if (value === undefined) {
    return {};
  }
  const output: Record<string, PluginConfigurationOptions> = {};
  if (!isRecord(value)) {
    report({
      message: "configuration must map plugin names to configuration objects",
      severity: "error",
      source: "options",
    });
    return output;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      report({
        message: `configuration.${name} must be an object`,
        severity: "error",
        source: "options",
      });
      continue;
    }
    if (entry["publicVariables"] !== undefined && !isStringArray(entry["publicVariables"])) {
      throw new Error("publicVariables must be an array of strings");
    }
    if (entry["modelAliases"] !== undefined && !isStringRecord(entry["modelAliases"])) {
      throw new Error("modelAliases must map strings to provider/model references");
    }
    output[name] = {
      userConfig: configMap(entry["userConfig"]),
      variables: configMap(entry["variables"]),
      ...(isStringArray(entry["publicVariables"])
        ? { publicVariables: entry["publicVariables"] }
        : {}),
      ...(isStringRecord(entry["modelAliases"]) ? { modelAliases: entry["modelAliases"] } : {}),
    };
  }
  return output;
};

export { parseConfigurationOptions };
