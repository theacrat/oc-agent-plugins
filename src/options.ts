import path from "node:path";

import { normaliseSettings } from "#src/settings-layout.ts";
import { COMPONENTS, FORMATS } from "#src/types.ts";
import type { Component, Format, Report } from "#src/types.ts";
import type { AppEndpoint } from "#src/vendor/bridges.ts";
import type { PluginConfigurationOptions } from "#src/vendor/configuration.ts";

interface Options {
  readonly componentOverrides: Readonly<Record<string, ComponentOverride>>;
  readonly pluginAppEndpoints: Readonly<Record<string, Readonly<Record<string, AppEndpoint>>>>;
  readonly configuration: Readonly<Record<string, PluginConfigurationOptions>>;
  readonly trustedHooks: readonly string[];
  readonly trustedMonitors: readonly string[];
  readonly outputStyle?: string;
  readonly allowSystemReplacement: boolean;
  readonly pluginSettings: Readonly<Record<string, boolean>>;
  readonly appEndpoints: Readonly<Record<string, AppEndpoint>>;
  readonly searchPaths: readonly string[];
  readonly dataRoot: string;
  readonly formats: ReadonlySet<Format>;
  readonly components: ReadonlySet<Component>;
  // Run `!`cmd`` injections in Claude commands when the user invokes them.
  readonly shellInjection: boolean;
}

interface ComponentOverride {
  readonly enabled: Readonly<Partial<Record<Component, boolean>>>;
  readonly shellInjection?: boolean;
  readonly outputStyle?: string;
  readonly allowSystemReplacement?: boolean;
}

interface OptionsInput {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly project: string;
  readonly home: string;
  readonly dataHome: string;
  readonly configHome?: string;
}

const expandHome = (value: string, home: string) => value.replace(/^~(?=\/|$)/u, home);

const parseOptions = (input: OptionsInput, report: Report): Options => {
  const { home, project } = input;
  const settings = normaliseSettings(input.raw, report);
  return {
    allowSystemReplacement: settings.allowSystemReplacement === true,
    appEndpoints: {},
    componentOverrides: settings.componentOverrides,
    configuration: settings.configuration,
    pluginAppEndpoints: settings.pluginAppEndpoints,
    pluginSettings: settings.pluginSettings,
    trustedHooks: settings.trustedHooks,
    trustedMonitors: settings.trustedMonitors,
    ...(settings.outputStyle === undefined ? {} : { outputStyle: settings.outputStyle }),
    components: new Set(COMPONENTS.filter((component) => settings.components[component] !== false)),
    dataRoot:
      settings.dataDir === undefined
        ? path.join(input.dataHome, "opencode", "agent-plugins")
        : path.resolve(project, expandHome(settings.dataDir, home)),
    formats: new Set(FORMATS.filter((format) => settings.formats[format] !== false)),
    searchPaths: [
      path.join(home, ".agents", "plugins"),
      path.join(input.configHome ?? path.join(home, ".config"), "opencode", "agent-plugins"),
      path.join(project, ".agents", "plugins"),
      path.join(project, ".opencode", "agent-plugins"),
      ...(settings.paths ?? []).map((entry) => path.resolve(project, expandHome(entry, home))),
    ],
    shellInjection: settings.shellInjection !== false,
  };
};

const componentsForPlugin = (options: Options, name: string): ReadonlySet<Component> => {
  const overrides = options.componentOverrides[name]?.enabled;
  return new Set(
    COMPONENTS.filter((component) => overrides?.[component] ?? options.components.has(component)),
  );
};

const commandInjectionForPlugin = (options: Options, name: string) =>
  options.componentOverrides[name]?.shellInjection ?? options.shellInjection;

export type { ComponentOverride, Options, OptionsInput };
export { commandInjectionForPlugin, componentsForPlugin, parseOptions };
