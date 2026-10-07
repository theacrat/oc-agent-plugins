import { componentsForPlugin } from "#src/options.ts";
import type { Options } from "#src/options.ts";
import type { StyleSelection } from "#src/runtime/styles.ts";
import type { LoadResult } from "#src/types.ts";

// Default selection is validated against the active, scoped inventory before touching session state.
const defaultStyle = (options: Options, result: LoadResult): StyleSelection | undefined => {
  const active = result.plugins.filter(
    (plugin) =>
      componentsForPlugin(options, plugin.manifest.name).has("styles") &&
      options.pluginSettings[plugin.manifest.name] !== false,
  );
  const overrides = active.flatMap((plugin) => {
    const selected = options.componentOverrides[plugin.manifest.name]?.outputStyle;
    return selected === undefined ? [] : [{ name: selected, plugin: plugin.manifest.name }];
  });
  if (overrides.length > 1) {
    throw new Error("Only one active plugin may configure a selected output style");
  }
  const [override] = overrides;
  let value = options.outputStyle;
  if (override !== undefined) {
    value = override.name.includes(":") ? override.name : `${override.plugin}:${override.name}`;
  }
  if (value === undefined) {
    return undefined;
  }
  const [plugin, ...names] = value.split(":");
  if (plugin === undefined || names.length === 0) {
    throw new Error("Selected output style must be plugin:name");
  }
  const name = names.join(":");
  const owner = active.find((entry) => entry.manifest.name === plugin);
  // A disabled component does not activate a retained selection.
  if (
    !componentsForPlugin(options, plugin).has("styles") ||
    options.pluginSettings[plugin] === false
  ) {
    return undefined;
  }
  if (owner === undefined || !owner.styles?.some((style) => style.name === name)) {
    throw new Error("Selected output style does not exist in an active plugin");
  }
  return { name, plugin };
};

export { defaultStyle };
