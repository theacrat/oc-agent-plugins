const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  format: "esm",
  minify: false,
  outdir: "dist",
  packages: "bundle",
  target: "node",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  throw new Error("CLI build failed");
}
