// "pnpm install" turns on the local pre-push gate (.githooks/pre-push), but only in Fleet's own clone:
// never in a repo around a copy without .git, and never over a hooks path the user set globally (that would
// switch their hooks off without a word).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const here = fs.realpathSync(process.cwd());
const top = git("rev-parse", "--show-toplevel");
if (!top || fs.realpathSync(top) !== here || !fs.existsSync(path.join(here, ".githooks", "pre-push"))) process.exit(0);
const global = git("config", "--global", "--get", "core.hooksPath");
if (global) {
  console.log(`hooks-path: global core.hooksPath (${global}) kept; the pre-push gate is off (see CLAUDE.md)`);
  process.exit(0);
}
git("config", "core.hooksPath", ".githooks");
