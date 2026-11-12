import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const currentDir = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(currentDir, "../../../apps/server/public/openhuddle.mjs");

mkdirSync(dirname(outFile), { recursive: true });

await build({
  entryPoints: [resolve(currentDir, "../src/cli.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: {
    js: "#!/usr/bin/env node",
  },
  minifySyntax: true,
});
