import { isRecord } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import type { Report } from "#src/types.ts";

interface Activation {
  readonly enabled: boolean;
  readonly reason?: string;
}

// Adapter-specific settings are explicit. Merely finding a plugin on disk does not import the
// other application's trust decision. Marketplace NOT_AVAILABLE is a deny, not a default.
const pluginActivation = (
  name: string,
  raw: JsonRecord,
  choices: Readonly<Record<string, boolean>>,
  report: Report,
): Activation => {
  const { policy } = raw;
  if (isRecord(policy) && policy["installation"] === "NOT_AVAILABLE") {
    return { enabled: false, reason: "marketplace installation policy is NOT_AVAILABLE" };
  }
  const choice = choices[name];
  if (choice !== undefined) {
    return { enabled: choice, ...(choice ? {} : { reason: "disabled by pluginSettings" }) };
  }
  if (raw["defaultEnabled"] === false) {
    return { enabled: false, reason: "manifest defaultEnabled is false" };
  }
  if (raw["dependencies"] !== undefined) {
    report({
      message:
        "plugin dependency activation is not inferred from another application's settings; dependencies must be explicitly loaded and enabled",
      severity: "warning",
      source: "plugin.json#dependencies",
    });
  }
  return { enabled: true };
};

export type { Activation };
export { pluginActivation };
