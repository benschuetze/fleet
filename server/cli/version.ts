import fs from "node:fs";
import path from "node:path";
import { APP_DIR } from "../core/paths";

/** The version from package.json next to dist/ (shipped in every release). */
export function version(): string {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}
