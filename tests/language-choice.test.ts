// The dashboard's language choice is Fleet's (practical test round 5): a German dashboard on an English server
// showed "Approval for Bash", "Tipp: Sonnet 5.5 is enough", "Fleet terminal" next to German words.
import assert from "node:assert";
import http from "node:http";
import { afterAll, beforeAll, test } from "vitest";
import type { Overview } from "../shared/types";
import { startServer } from "./helpers/server";

let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  srv = await startServer({ args: ["--demo"], env: { FLEET_LANG: "", LANG: "en_GB.UTF-8", LC_ALL: "" } });
});
afterAll(() => srv.stop());

const overview = async () => JSON.parse((await srv.request("/api/overview")).body) as Overview;
const choose = (lang: string) =>
  srv.request("/api/language", {
    method: "POST",
    body: JSON.stringify({ lang }),
    headers: { "Content-Type": "application/json", "X-Fleet": "1" },
  });

test("choosing German in the dashboard makes the server's texts German, and back", async () => {
  const before = await overview();
  assert.strictEqual(before.language, "en");
  const de = await choose("de");
  assert.strictEqual(de.status, 200);
  const after = await overview();
  assert.strictEqual(after.language, "de");
  assert.ok(
    after.events.some((e) => /^Freigabe für/.test(e.detail || "")),
    "the history's approvals in German",
  );
  assert.ok(!after.events.some((e) => /^Approval for/.test(e.detail || "")), "no English approval left");
  await choose("en");
  assert.strictEqual((await overview()).language, "en");
});

test("only German or English", async () => {
  assert.strictEqual((await choose("fr")).status, 400);
});

test("open tabs hear of the switch at once (round 6: Activity kept the old words until the next view)", async () => {
  const heard = new Promise<string>((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: srv.port, path: "/api/stream", headers: { Host: `localhost:${srv.port}` } },
      (res) => {
        let all = "";
        res.on("data", (d) => {
          all += String(d);
          if (/data: change/.test(all)) {
            resolve(all);
            req.destroy();
          }
        });
      },
    );
    req.on("error", reject);
    setTimeout(() => reject(new Error("no change pushed")), 3000);
  });
  await new Promise((r) => setTimeout(r, 200));
  await choose("de");
  assert.match(await heard, /data: change/);
  await choose("en");
});
