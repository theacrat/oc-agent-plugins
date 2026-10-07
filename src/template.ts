import type { PluginCommand } from "#src/types.ts";

// Splits arguments like Claude Code and OpenCode: quotes group words and are removed.
const splitArguments = (input: string): string[] =>
  [...input.matchAll(/"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<bare>\S+)/gu)].map(
    (match) => match.groups?.["double"] ?? match.groups?.["single"] ?? match.groups?.["bare"] ?? "",
  );

// Shell injections are matched in the template only, before arguments are substituted, so text the
// user passes as an argument can never become a command.
const INJECTION = String.raw`!\x60(?<shell>[^\x60\n]+)\x60`;

// Replaces every match in a single pass; substituted text is never rescanned.
const splice = (
  text: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => string,
): string => {
  let output = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    output += text.slice(last, match.index) + replace(match);
    last = match.index + match[0].length;
  }
  return output + text.slice(last);
};

interface Rendered {
  readonly text: string;
  // Shell commands from the template, in order; `text` holds a `\u0000N\u0000` marker for each.
  readonly shell: readonly string[];
}

const marker = (index: number) => `\u0000${index}\u0000`;

// OpenCode Markdown commands: `$ARGUMENTS`, and 1-based `$N` where the highest consumes the rest.
// No placeholder appends the arguments after a blank line.
const renderPlain = (template: string, input: string): string => {
  const args = splitArguments(input);
  const trimmed = input.trim();
  const indices = [...template.matchAll(/\$(?<index>[1-9])/gu)].map((match) =>
    Number(match.groups?.["index"]),
  );
  const highest = Math.max(0, ...indices);
  if (!template.includes("$ARGUMENTS") && highest === 0) {
    return trimmed === "" ? template : `${template}\n\n${trimmed}`;
  }
  const at = (index: number) =>
    index === highest ? args.slice(index - 1).join(" ") : (args[index - 1] ?? "");
  return splice(template, /\$ARGUMENTS|\$(?<index>[1-9])/gu, (match) => {
    const index = match.groups?.["index"];
    return index === undefined ? trimmed : at(Number(index));
  });
};

const escapeRegExp = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

// Claude Code: `$ARGUMENTS`, `$ARGUMENTS[N]` and `$N` are 0-based; named arguments map to positions.
// An indexed placeholder with no argument stays literal. With no placeholder receiving an argument,
// Claude Code appends `ARGUMENTS: <input>`.
const renderClaude = (template: string, input: string, names: readonly string[]): Rendered => {
  const args = splitArguments(input);
  const trimmed = input.trim();
  // Longest names first so `$system_name` wins over `$system`.
  const named = names
    .filter((name) => /^[A-Za-z_]\w*$/u.test(name))
    .toSorted((left, right) => right.length - left.length)
    .map((name) => escapeRegExp(name));
  const pattern = new RegExp(
    [
      INJECTION,
      String.raw`\$ARGUMENTS\[(?<bracket>\d+)\]`,
      String.raw`\$ARGUMENTS`,
      String.raw`\$(?<short>\d+)(?!\d)`,
      ...(named.length === 0 ? [] : [String.raw`\$(?<named>${named.join("|")})(?!\w)`]),
    ].join("|"),
    "gu",
  );
  const shell: string[] = [];
  let received = false;
  const resolve = (match: RegExpExecArray): string => {
    const { bracket, named: name, shell: command, short } = match.groups ?? {};
    if (command !== undefined) {
      shell.push(command);
      return marker(shell.length - 1);
    }
    if (name !== undefined) {
      received = true;
      return args[names.indexOf(name)] ?? "";
    }
    const index = bracket ?? short;
    if (index === undefined) {
      received ||= trimmed !== "";
      return trimmed;
    }
    const value = args[Number(index)];
    if (value === undefined) {
      return match[0];
    }
    received = true;
    return value;
  };
  const output = splice(template, pattern, resolve);
  return {
    shell,
    text: !received && trimmed !== "" ? `${output}\n\nARGUMENTS: ${trimmed}` : output,
  };
};

// NUL never appears in typed arguments; dropping it means arguments can't forge a shell marker.
const renderCommand = (command: PluginCommand, input: string): Rendered => {
  const clean = input.replaceAll("\u0000", "");
  return command.syntax === "claude"
    ? renderClaude(command.template, clean, command.arguments)
    : { shell: [], text: renderPlain(command.template, clean) };
};

// NUL delimits markers because arguments can't contain it (renderCommand strips it).
// oxlint-disable-next-line no-control-regex -- matching the NUL-delimited marker is the point
const MARKER = /\u0000(?<index>\d+)\u0000/gu;

// Puts each shell command's result back where its marker is.
const fillShell = (rendered: Rendered, results: readonly string[]): string =>
  splice(rendered.text, MARKER, (match) => {
    const index = Number(match.groups?.["index"]);
    return results[index] ?? "";
  });

export type { Rendered };
export { fillShell, renderCommand, splitArguments };
