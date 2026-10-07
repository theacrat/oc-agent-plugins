import { describe, expect, it } from "vitest";

import { renderCommand } from "#src/template.ts";
import type { CommandSyntax } from "#src/types.ts";

const command = (template: string, syntax: CommandSyntax, names: readonly string[] = []) => ({
  arguments: names,
  name: "x",
  syntax,
  template,
});

describe("plain (OpenCode) syntax", () => {
  it.each([
    ["Review $ARGUMENTS now.", "src/a.ts src/b.ts", "Review src/a.ts src/b.ts now."],
    ["Deploy $1 to $2.", "api stable branch", "Deploy api to stable branch."],
    [
      "Check $1. Focus on $2.",
      'src/auth.ts "error handling"',
      "Check src/auth.ts. Focus on error handling.",
    ],
    ["Deploy $1 to $2.", "api", "Deploy api to ."],
    ["Explain this.", "src/cache.ts", "Explain this.\n\nsrc/cache.ts"],
    ["Explain this.", "  ", "Explain this."],
    ["Do: $ARGUMENTS then $2", "say $1 now", "Do: say $1 now then $1 now"],
  ])("renders %j with %j", (template, input, expected) => {
    expect(renderCommand(command(template, "plain"), input)).toEqual({ shell: [], text: expected });
  });
});

describe("claude syntax", () => {
  it.each<[string, string, readonly string[], string]>([
    ["Fix issue $ARGUMENTS.", "123", [], "Fix issue 123."],
    [
      "Migrate $0 from $1 to $2.",
      "SearchBar JavaScript TypeScript",
      [],
      "Migrate SearchBar from JavaScript to TypeScript.",
    ],
    ["Migrate $ARGUMENTS[0] to $ARGUMENTS[1].", "a b", [], "Migrate a to b."],
    ["Client ID: `$1`", "only", [], "Client ID: `$1`\n\nARGUMENTS: only"],
    ["Status of $system.", "billing", ["system"], "Status of billing."],
    [
      "$system to $target_stack ($system_name)",
      "billing go",
      ["system", "target_stack"],
      "billing to go ($system_name)",
    ],
    ["Named but missing: [$system]", "", ["system"], "Named but missing: []"],
    ["No placeholders.", "extra words", [], "No placeholders.\n\nARGUMENTS: extra words"],
    ["No placeholders.", "", [], "No placeholders."],
    ["Cost is $5.", "", [], "Cost is $5."],
    ["Echo $0", "$1", [], "Echo $1"],
  ])("renders %j with %j", (template, input, names, expected) => {
    expect(renderCommand(command(template, "claude", names), input).text).toBe(expected);
  });
});
