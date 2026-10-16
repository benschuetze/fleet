import type { Advice, LoopSignal, SessionStats } from "../../shared/types";
import { locale, tr } from "./lang";
import { costOf, priceFor } from "./usage";

/**
 * Efficiency advisor: does the model fit the session's work, is a handoff to a new session due, and does
 * the prompt cache cost money for nothing?
 *
 * Deliberately simple, explainable rules instead of a model: every recommendation names its reason and,
 * where possible, the estimated effect in dollars for exactly this session. The basis is the work profile
 * from the transcript (prompts, tool calls, errors) and the token counts.
 */

export interface AdviceInput {
  model: string | null | undefined;
  stats: SessionStats | null | undefined;
  usage:
    | {
        cost: number;
        n?: number;
        i?: number;
        o?: number;
        cw?: number;
        cr?: number;
        mn?: number;
        mo?: number;
        rebuilds?: number;
        rebuildCost?: number;
        cacheRate?: number | null;
      }
    | null
    | undefined;
  context: { tokens: number; size: number; pct: number } | null | undefined;
  compactions?: number;
  loop?: LoopSignal | null;
}

const MODELS = {
  haiku: { id: "claude-haiku-5-5", name: "Haiku 5.5", how: "/model haiku" },
  sonnet: { id: "claude-sonnet-5-5", name: "Sonnet 5.5", how: "/model sonnet" },
  opus: { id: "claude-opus-5-5", name: "Opus 5.5", how: "/model opus" },
} as const;

export function tierOf(model: unknown): "fable" | "opus" | "sonnet" | "haiku" | null {
  const m = String(model || "").toLowerCase();
  if (/fable|mythos/.test(m)) return "fable";
  if (/opus/.test(m)) return "opus";
  if (/sonnet/.test(m)) return "sonnet";
  if (/haiku/.test(m)) return "haiku";
  return null;
}

const money = (v: number) => `${v.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
function toks(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toLocaleString(locale(), { maximumFractionDigits: 1 })} ${tr("Mio.", "M")}`;
  if (v >= 1e3) return `${Math.round(v / 1e3).toLocaleString(locale())} ${tr("Tsd.", "k")}`;
  return String(Math.round(v));
}

/**
 * What kind of work does the session do? Agents often change files through the shell instead of
 * Edit/Write, so tool calls per prompt that do more than read count most.
 */
function profile(st: SessionStats, u: AdviceInput["usage"], loop: AdviceInput["loop"]) {
  const prompts = Math.max(st.prompts, 1);
  const work = st.tools - st.reads;
  const outPerReply = u?.mn ? (u.mo || 0) / u.mn : 0;
  const errRate = st.tools ? st.errors / st.tools : 0;
  const struggling = !!loop || (st.tools >= 10 && errRate >= 0.3);
  const heavy = struggling || st.edits >= 8 || work / prompts >= 10;
  const light =
    !heavy && st.edits === 0 && st.tools / prompts <= 2 && outPerReply < 1500 && st.promptChars / prompts < 800;
  const explore = !heavy && !light && st.tools >= 15 && st.reads / st.tools >= 0.7 && st.edits <= 2;
  return { heavy, light, explore, struggling, errRate };
}

/**
 * Cost of the session's tokens with another model (rough estimate, same token count assumed). Computed per
 * average call, because price tiers (Haiku 5.5 above 100k) apply per call.
 */
function costWith(u: NonNullable<AdviceInput["usage"]>, model: string): number {
  const n = Math.max(1, u.n || u.mn || 1);
  return costOf({ i: (u.i || 0) / n, o: (u.o || 0) / n, cw: (u.cw || 0) / n, cr: (u.cr || 0) / n }, model) * n;
}

function modelAdvice(s: AdviceInput): Advice | null {
  const tier = tierOf(s.model);
  const st = s.stats;
  const u = s.usage;
  if (!tier || !st || st.prompts < 1 || (u && !u.mn)) return null;
  const p = profile(st, u, s.loop);
  const suggest = (to: keyof typeof MODELS, level: "info" | "warn", title: string, why: string): Advice => {
    const m = MODELS[to];
    const saving = u ? Math.round((costWith(u, String(s.model)) - costWith(u, m.id)) * 100) / 100 : undefined;
    const effect =
      saving === undefined
        ? ""
        : saving >= 0.01
          ? tr(
              ` Für diese Session wären das etwa ${money(saving)} weniger.`,
              ` For this session that would be about ${money(saving)} less.`,
            )
          : saving <= -0.01
            ? tr(
                ` Kostet für diese Session etwa ${money(-saving)} mehr, spart aber Fehlversuche.`,
                ` Costs about ${money(-saving)} more for this session but saves failed attempts.`,
              )
            : "";
    return { kind: "model", level, title, text: why + effect, model: m.id, how: m.how, saving };
  };
  const errs = tr(
    `${Math.round(p.errRate * 100)} % der Werkzeugaufrufe schlagen fehl`,
    `${Math.round(p.errRate * 100)} % of tool calls fail`,
  );
  const stuck = s.loop ? tr("Schleife erkannt", "loop detected") : errs;
  if (tier === "fable" && !p.heavy) {
    return suggest(
      "opus",
      "info",
      tr("Opus 5.5 reicht", "Opus 5.5 is enough"),
      tr(
        "Fable lohnt sich für die schwersten, langen Aufgaben. Diese Session arbeitet in normalem Umfang.",
        "Fable pays off for the hardest, longest tasks. This session works at a normal scale.",
      ),
    );
  }
  if ((tier === "opus" || tier === "fable") && p.light) {
    return suggest(
      "haiku",
      "info",
      tr("Haiku 5.5 reicht", "Haiku 5.5 is enough"),
      tr(
        "Kurze Fragen ohne Codeänderungen und mit wenigen Werkzeugaufrufen beantwortet Haiku 5.5 genauso gut.",
        "Short questions without code changes and with few tool calls are answered just as well by Haiku 5.5.",
      ),
    );
  }
  if (tier === "opus" && p.explore) {
    return suggest(
      "sonnet",
      "info",
      tr("Sonnet 5.5 reicht", "Sonnet 5.5 is enough"),
      tr(
        "Die Session liest und sucht überwiegend und ändert kaum etwas. Dafür genügt Sonnet 5.5, oder ein Explore-Subagent.",
        "The session mostly reads and searches and changes little. Sonnet 5.5 or an Explore subagent is enough for that.",
      ),
    );
  }
  if (tier === "sonnet" && p.light) {
    return suggest(
      "haiku",
      "info",
      tr("Haiku 5.5 reicht", "Haiku 5.5 is enough"),
      tr(
        "Kurze Fragen ohne Codeänderungen beantwortet Haiku 5.5 genauso gut.",
        "Short questions without code changes are answered just as well by Haiku 5.5.",
      ),
    );
  }
  if (tier === "sonnet" && p.struggling) {
    return suggest(
      "opus",
      "warn",
      tr("Opus 5.5 versuchen", "Try Opus 5.5"),
      tr(
        `Die Session kommt nicht voran (${stuck}). Ein stärkeres Modell löst so etwas oft in weniger Anläufen.`,
        `The session is not making progress (${stuck}). A stronger model often solves this in fewer attempts.`,
      ),
    );
  }
  if (tier === "haiku" && p.heavy) {
    return p.struggling
      ? suggest(
          "opus",
          "warn",
          tr("Opus 5.5 versuchen", "Try Opus 5.5"),
          tr(
            `Umfangreiche Arbeit, und die Session kommt nicht voran (${stuck}). Haiku ist dafür zu schwach.`,
            `Extensive work and the session is not making progress (${stuck}). Haiku is too weak for this.`,
          ),
        )
      : suggest(
          "sonnet",
          "info",
          tr("Sonnet 5.5 erwägen", "Consider Sonnet 5.5"),
          tr(
            "Viele Änderungen und Werkzeugaufrufe je Auftrag: Sonnet 5.5 macht hier meist weniger Fehler als Haiku.",
            "Many changes and tool calls per prompt: Sonnet 5.5 usually makes fewer mistakes here than Haiku.",
          ),
        );
  }
  const kind = p.heavy
    ? tr("Umfangreiche Arbeit mit vielen Werkzeugaufrufen", "Extensive work with many tool calls")
    : p.light
      ? tr("Kurze Fragen", "Short questions")
      : p.explore
        ? tr("Lesen und Suchen", "Reading and searching")
        : tr("Gemischte Arbeit", "Mixed work");
  return {
    kind: "model",
    level: "ok",
    title: tr("Modell passt", "Model fits"),
    text: tr(`${kind} – dafür ist das gewählte Modell angemessen.`, `${kind}: the chosen model is appropriate.`),
  };
}

function handoffAdvice(s: AdviceInput): Advice | null {
  const reasons: string[] = [];
  let level: "info" | "warn" = "info";
  const c = s.context;
  const full = (pct: number, tokens: number, size: number) =>
    tr(
      `Der Kontext ist zu ${Math.round(pct)} % voll (${toks(tokens)} von ${toks(size)} Tokens)`,
      `The context is ${Math.round(pct)} % full (${toks(tokens)} of ${toks(size)} tokens)`,
    );
  if (c?.size && c.pct >= 85) {
    level = "warn";
    reasons.push(
      full(c.pct, c.tokens, c.size) +
        tr(
          "; bald wird automatisch komprimiert und Details gehen verloren",
          "; it will be compacted soon and details get lost",
        ),
    );
  } else if (c?.size && c.pct >= 60) reasons.push(full(c.pct, c.tokens, c.size));
  if (c && c.tokens >= 300000) {
    const perCall = (c.tokens * priceFor(s.model).cr) / 1e6;
    reasons.push(
      tr(
        `Jeder Aufruf liest ${toks(c.tokens)} Tokens aus dem Cache (≈ ${money(perCall)} pro Aufruf, auch für kleine Schritte)`,
        `Every call reads ${toks(c.tokens)} tokens from the cache (≈ ${money(perCall)} per call, even for small steps)`,
      ),
    );
  }
  if (s.compactions)
    reasons.push(
      tr(
        `Schon ${s.compactions}× komprimiert; jede Zusammenfassung verliert Einzelheiten`,
        `Compacted ${s.compactions}× already; every summary loses details`,
      ),
    );
  if (s.stats && s.stats.prompts >= 25)
    reasons.push(
      tr(
        `${s.stats.prompts} Aufträge in einer Session; eine Session pro Aufgabe hält den Kontext klein`,
        `${s.stats.prompts} prompts in one session; one session per task keeps the context small`,
      ),
    );
  if (!reasons.length) return null;
  return {
    kind: "handoff",
    level,
    title: level === "warn" ? tr("Jetzt übergeben", "Hand over now") : tr("Übergabe vorbereiten", "Prepare a handoff"),
    text: `${reasons.join(". ")}. ${tr("Eine Übergabe-Notiz und eine frische Session sind meist günstiger und genauer.", "A handoff note and a fresh session are usually cheaper and more precise.")}`,
  };
}

function cacheAdvice(s: AdviceInput): Advice | null {
  const u = s.usage;
  if (!u) return null;
  const n = u.rebuilds || 0;
  if (n >= 3) {
    const big = (u.rebuildCost || 0) >= Math.max(5, (u.cost || 0) * 0.1);
    return {
      kind: "cache",
      level: big ? "warn" : "info",
      title: tr("Cache verfällt in Pausen", "Cache expires during breaks"),
      text: tr(
        `Der Kontext wurde ${n}× komplett neu in den Cache geschrieben (≈ ${money(u.rebuildCost || 0)}). Das passiert nach Pausen, die länger sind als der Cache hält, oder nach einem Modellwechsel mitten in der Session. Lange Pausen lieber mit Übergabe und neuer Session überbrücken.`,
        `The context was written to the cache from scratch ${n}× (≈ ${money(u.rebuildCost || 0)}). That happens after breaks longer than the cache lasts, or after switching models mid-session. Bridge long breaks with a handoff and a new session instead.`,
      ),
    };
  }
  if (typeof u.cacheRate === "number" && u.cacheRate < 0.6 && (u.mn || 0) >= 20) {
    return {
      kind: "cache",
      level: "info",
      title: tr("Wenig Cache-Treffer", "Few cache hits"),
      text: tr(
        `Nur ${Math.round(u.cacheRate * 100)} % der Prompt-Tokens kommen aus dem Cache. Häufig wechselnde Modelle, Werkzeuge oder ein geänderter Anfang des Kontexts verhindern Treffer.`,
        `Only ${Math.round(u.cacheRate * 100)} % of prompt tokens come from the cache. Frequently changing models or tools, or a changed start of the context, prevent hits.`,
      ),
    };
  }
  return null;
}

/** All recommendations for a session, most important first. */
export function advise(s: AdviceInput): Advice[] {
  const rank = { warn: 0, info: 1, ok: 2 };
  return [modelAdvice(s), handoffAdvice(s), cacheAdvice(s)]
    .filter((a): a is Advice => !!a)
    .sort((a, b) => rank[a.level] - rank[b.level]);
}

/** Text to copy: the old session writes its handoff for a new one with it. */
export const handoffPrompt = () =>
  tr(
    `Wir wechseln gleich in eine neue Session. Schreib eine Übergabe, die eine neue Session ohne dieses Gespräch versteht, als Markdown:
1. Ziel und Auftrag in zwei Sätzen
2. Was erledigt ist (Dateien, Commits, PRs)
3. Was offen ist und die nächsten Schritte, in Reihenfolge
4. Entscheidungen und Stolperfallen, die man kennen muss
5. Befehle, mit denen man den Stand prüft
Nur was die neue Session braucht. Speichere sie als HANDOFF.md im Projekt.`,
    `We are about to switch to a new session. Write a handoff that a new session understands without this conversation, as Markdown:
1. Goal and task in two sentences
2. What is done (files, commits, PRs)
3. What is open and the next steps, in order
4. Decisions and pitfalls one has to know
5. Commands to check the state
Only what the new session needs. Save it as HANDOFF.md in the project.`,
  );
