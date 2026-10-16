/**
 * Bundles everything that runs outside the browser into single files in dist/: the CLI and server
 * (fleet.cjs), the hook, the status line and the detached launcher. Each file uses Node built-ins only, so a
 * release runs with `node dist/fleet.cjs` and no node_modules. The dashboard itself is built by React Router.
 */
import { builtinModules } from "node:module";
import { build } from "esbuild";

const entries = {
  fleet: "server/cli/index.ts",
  hook: "hooks/hook.ts",
  statusline: "hooks/statusline.ts",
  "launch-run": "hooks/launch-run.ts",
};

await build({
  entryPoints: entries,
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  minify: false,
  legalComments: "none",
  // Anything that is not a Node built-in must be bundled; failing here keeps the "no runtime dependencies" promise honest.
  // The one exception, the optional pty module for the terminal in the window, is never imported statically:
  // server/process/pty.ts loads it at run time through createRequire, and without it Fleet runs as before.
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  define: { "process.env.FLEET_BUNDLED": '"1"', "import.meta.url": "__fleetUrl" },
  banner: { js: "const __fleetUrl = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: "warning",
});
console.log("dist/: fleet.cjs, hook.cjs, statusline.cjs, launch-run.cjs");
