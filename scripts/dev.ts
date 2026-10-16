/**
 * Development: the bundled API server in demo mode on 4781 and Vite with hot reload on 5181, which forwards /api.
 * Server code changes need `pnpm build` and a restart; the UI reloads by itself.
 *   pnpm dev
 */
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const run = (cmd: string, args: string[]) =>
  spawn(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

const bundle = run(process.execPath, ["--import", "tsx", "scripts/bundle.ts"]);
bundle.on("exit", (code) => {
  if (code) process.exit(code);
  const api = run(process.execPath, ["dist/fleet.cjs", "serve", "--demo", "--port", "4781", "--no-repair"]);
  const ui = run("pnpm", ["exec", "react-router", "dev"]);
  const stop = () => {
    api.kill();
    ui.kill();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  ui.on("exit", stop);
});
