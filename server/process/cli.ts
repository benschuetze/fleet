import { execFile } from "node:child_process";
import * as launch from "../core/launch";
import { command } from "./pty";

/** The Claude CLI Fleet starts, and whether it is logged in. FLEET_TEST_CLAUDE replaces it in tests. */

export function claudeCli(): string | null {
  return process.env.FLEET_TEST_CLAUDE || launch.detect().claude;
}

let auth: { at: number; cli: string; ok: boolean } | null = null;

/** Is the CLI logged in? `claude auth status` answers in JSON; checked at most every 10 minutes. */
export function cliLoggedIn(cli: string): Promise<boolean> {
  if (auth && auth.cli === cli && Date.now() - auth.at < 10 * 60e3) return Promise.resolve(auth.ok);
  const c = command(cli, ["auth", "status"]);
  return new Promise((resolve) => {
    execFile(c.file, c.args, { timeout: 8000, windowsHide: true }, (err, stdout) => {
      let ok = false;
      try {
        ok = !err && JSON.parse(String(stdout)).loggedIn === true;
      } catch {
        ok = false;
      }
      auth = { at: Date.now(), cli, ok };
      resolve(ok);
    });
  });
}
