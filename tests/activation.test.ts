import { describe, expect, it } from "vitest";

import { pluginActivation } from "#src/vendor/activation.ts";

const report = (diagnostic: unknown) => {
  throw new Error(JSON.stringify(diagnostic));
};

describe("explicit plugin activation", () => {
  it("preserves default-disabled plugins until explicitly enabled", () => {
    expect(pluginActivation("p", { defaultEnabled: false }, {}, report)).toEqual({
      enabled: false,
      reason: "manifest defaultEnabled is false",
    });
    expect(pluginActivation("p", { defaultEnabled: false }, { p: true }, report)).toEqual({
      enabled: true,
    });
  });

  it("cannot override a marketplace NOT_AVAILABLE policy", () => {
    expect(
      pluginActivation("p", { policy: { installation: "NOT_AVAILABLE" } }, { p: true }, report),
    ).toEqual({
      enabled: false,
      reason: "marketplace installation policy is NOT_AVAILABLE",
    });
  });

  it("disables plugins explicitly regardless of host defaults", () => {
    expect(pluginActivation("p", {}, { p: false }, report)).toEqual({
      enabled: false,
      reason: "disabled by pluginSettings",
    });
  });
});
