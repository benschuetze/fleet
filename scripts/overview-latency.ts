/**
 * Profiles the overview build: a cold build, then one build after each invented hook state change, with the time
 * of every data source. Default: the invented load fixture (tests/helpers/fleet-fixture.ts, ~150 sessions).
 * `--real` reads your own ~/.claude and ~/.claude-fleet instead (read only; nothing is written or printed but
 * timings).
 *   pnpm overview-latency [--real] [runs]
 */
import fs from "node:fs";
import { makeFleetFixture } from "../tests/helpers/fleet-fixture";

const real = process.argv.includes("--real");
const runs = Math.max(5, Number(process.argv.find((a) => /^\d+$/.test(a))) || 20);
const fx = real ? null : makeFleetFixture();
if (fx) {
  process.env.CLAUDE_CONFIG_DIR = fx.claudeHome;
  process.env.CLAUDE_FLEET_HOME = fx.fleetHome;
  process.env.CLAUDE_DESKTOP_SESSIONS_DIR = "";
  process.env.CLAUDE_DESKTOP_CONFIG = "";
}
// After the environment: the modules read their folders when loaded.
const { loadConfig } = await import("../server/core/config");
const { buildOverview, realSources } = await import("../server/core/overview");

type Fn = (...a: unknown[]) => unknown;
const times: Record<string, number[]> = {};
const sources: Record<string, Fn> = {};
for (const [k, v] of Object.entries(realSources) as [string, Fn][])
  sources[k] = (...a) => {
    const t0 = performance.now();
    const r = v(...a);
    const done = () => {
      const list = times[k] || [];
      list.push(performance.now() - t0);
      times[k] = list;
    };
    if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(done, done);
    else done();
    return r;
  };

async function once(label: string) {
  for (const k of Object.keys(times)) times[k] = [];
  const t0 = performance.now();
  const o = await buildOverview(loadConfig(), { version: "profile", sources });
  const ms = performance.now() - t0;
  const parts = Object.entries(times)
    .map(([k, v]) => [k, Math.max(0, ...v), v.length] as const)
    .filter(([, m]) => m >= 5)
    .sort((a, b) => b[1] - a[1])
    .map(([k, m, n]) => `${k} ${m.toFixed(0)} ms${n > 1 ? ` (×${n})` : ""}`);
  console.log(
    `${label}: ${ms.toFixed(0)} ms, ${o.sessions.length} sessions, ${o.repos.length} repos | ${parts.join(", ")}`,
  );
  return ms;
}

await once("cold");
const ms: number[] = [];
for (let i = 0; i < runs; i++) {
  if (fx) fx.writeHook(fx.ids[fx.ids.length - 1 - (i % 20)] as string, i % 2 ? "working" : "needs_input", "Bash");
  ms.push(await once(`change ${i + 1}`));
  await new Promise((r) => setTimeout(r, 500));
}
ms.sort((a, b) => a - b);
const q = (p: number) => (ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] ?? 0).toFixed(0);
console.log(`after a change, ${runs} builds: median ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${q(1)} ms`);
if (fx) fs.rmSync(fx.root, { recursive: true, force: true });
process.exit(0);
