import { isRecord, parseJson } from "#src/json.ts";
import type { JsonRecord } from "#src/json.ts";
import type { Report } from "#src/types.ts";
import { loadRuntimeFiles } from "#src/vendor/runtime-files.ts";

interface PluginTheme {
  readonly name: string;
  readonly base: "dark" | "light" | "dark-daltonized" | "light-daltonized";
  readonly overrides: Readonly<Record<string, string>>;
  readonly path: string;
}

const THEME_BLOCKER =
  "Theme export only: server plugins cannot register CLI themes. Claude token names are not OpenCode theme tokens; apply an explicit reviewed token mapping in a CLI plugin rather than importing this as OpenCode config.";

const isThemeBase = (value: unknown): value is PluginTheme["base"] =>
  value === "dark" ||
  value === "light" ||
  value === "dark-daltonized" ||
  value === "light-daltonized";

const isColours = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  Object.entries(value).every(
    ([key, colour]) =>
      /^[A-Za-z][A-Za-z0-9]*$/u.test(key) &&
      typeof colour === "string" &&
      /^#[\da-f]{6}$/iu.test(colour),
  );

const parseTheme = (value: unknown, file: string, report: Report): PluginTheme | undefined => {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["name", "base", "overrides"].includes(key)) ||
    typeof value["name"] !== "string" ||
    value["name"].trim() === "" ||
    !isThemeBase(value["base"]) ||
    !isColours(value["overrides"])
  ) {
    report({
      message:
        "theme export requires name, supported base and a token-to-#RRGGBB overrides map; unsupported fields or colours are rejected",
      severity: "error",
      source: file,
    });
    return undefined;
  }
  return { base: value["base"], name: value["name"], overrides: value["overrides"], path: file };
};

const loadThemes = async (
  root: string,
  raw: JsonRecord,
  report: Report,
): Promise<PluginTheme[]> => {
  const experimental = isRecord(raw["experimental"]) ? raw["experimental"] : {};
  const files = await loadRuntimeFiles(
    root,
    experimental["themes"] ?? raw["themes"],
    "themes",
    ".json",
    report,
  );
  const themes: PluginTheme[] = [];
  for (const file of files) {
    const parsed = parseJson(file.text);
    if (!parsed.ok) {
      report({ message: parsed.error, severity: "error", source: file.path });
      continue;
    }
    const theme = parseTheme(parsed.value, file.path, report);
    if (theme !== undefined) {
      themes.push(theme);
    }
  }
  return themes;
};

const exportTheme = (theme: PluginTheme) => ({
  format: "claude-theme" as const,
  theme: { base: theme.base, name: theme.name, overrides: theme.overrides },
  unavailable: THEME_BLOCKER,
});

export type { PluginTheme };
export { exportTheme, loadThemes, parseTheme, THEME_BLOCKER };
