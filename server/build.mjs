// Bundles the hosted server (and the shared app code it imports) into
// build/hosted/index.mjs. `react-router build` wipes build/server, hence build/hosted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outdir = path.join(root, "build/hosted");

// Native or runtime-resolved packages stay external and are installed next to
// the bundle (see the generated package.json below and the Dockerfile).
const EXTERNALS = ["sharp"];

fs.rmSync(outdir, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: ["server/index.ts"],
  outfile: path.join(outdir, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  tsconfig: "tsconfig.server.json",
  alias: { "~": path.join(root, "app") },
  external: EXTERNALS,
  // Shared app code may read Vite's import.meta.env; give it production values.
  define: {
    "import.meta.env": JSON.stringify({ MODE: "production", DEV: false, PROD: true, SSR: true }),
  },
  // Bundled CommonJS dependencies may call require() for Node builtins.
  banner: {
    js: "import { createRequire as __prismixCreateRequire } from 'node:module'; const require = __prismixCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

// A minimal manifest pinning the externals to the versions installed here, so a
// runtime image can `npm install` just those.
const dependencies = Object.fromEntries(
  EXTERNALS.map((name) => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")
    );
    return [name, manifest.version];
  })
);
fs.writeFileSync(
  path.join(outdir, "package.json"),
  JSON.stringify({ name: "prismix-hosted", private: true, type: "module", dependencies }, null, 2) +
    "\n"
);
