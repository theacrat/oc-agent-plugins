const errorOutput = (argv: readonly string[], error: unknown): string => {
  const message = error instanceof Error ? error.message : "command failed";
  return argv.includes("--json")
    ? JSON.stringify({ error: message, exitCode: 1 })
    : `oc-agent-plugins: ${message}`;
};

export { errorOutput };
