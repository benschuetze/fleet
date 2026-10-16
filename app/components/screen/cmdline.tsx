import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { allConflicts } from "~/lib/conflict";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { bindingsOf, hit, shownKeys } from "~/lib/keymap";
import { mergeWay } from "~/lib/merge";
import { type PaletteData, type Suggestion, suggest } from "~/lib/palette";
import { load, save } from "~/lib/store";
import { type TileId, tileOf, useTiles } from "~/lib/tiles";
import { inbox } from "../../../shared/inbox";
import type { Overview } from "../../../shared/types";
import { isMac } from "../keys/modal";

/**
 * The command line, the last line of the screen (spec, "Ein Schirm im CLI-Look", rule 4; lnav and k9s): always
 * there, `:` or ⌘K puts the focus in it, Esc gives it back to where it came from. With `:` it takes what the palette
 * took (a session, a repo, `#11`, a function code or a command) and offers up to eight suggestions in the lines
 * right above it; arrows or Ctrl+N/Ctrl+P choose, Enter runs. With `/` it is the search: typing filters live, Enter
 * keeps the filter, Esc clears it. How often each suggestion ran is kept per browser, so the usual ones come first.
 */
export function CommandLine() {
  const { t } = useI18n();
  const { data, query, setQuery } = useFleet();
  const { command, setCommand, runCmd, mode } = useKeys();
  const vim = mode === "vim";
  const [text, setText] = useState("");
  const [i, setI] = useState(0);
  const [used] = useState<Record<string, number>>(() => {
    const v = load<Record<string, number>>("paletteUse");
    return v && typeof v === "object" ? v : {};
  });
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Where the focus was before the line took it: Esc and Enter give it back there. */
  const back = useRef<HTMLElement | null>(null);
  /**
   * The tile that element was in. A refresh may draw the element anew while the line is open (the stream's lines),
   * and the detached one no longer knows its tile; then the focus goes back to that tile (rule 4: the previous tile).
   */
  const backTile = useRef<TileId | null>(null);
  const tiles = useTiles();
  // The active tile, for when the focus had already fallen to the page (its line drawn anew before `:`).
  const activeTile = useRef(tiles.active);
  activeTile.current = tiles.active;
  const pd = useMemo(() => paletteData(data), [data]);
  const asking = command === ":";
  const list = useMemo(() => (asking ? suggest(text, pd, used, SUGGEST_ROWS) : []), [asking, text, pd, used]);
  const cur = Math.min(i, Math.max(0, list.length - 1));
  const mac = isMac();

  useEffect(() => {
    const el = input.current;
    if (!command || !el || document.activeElement === el) return;
    remember(back, backTile, document.activeElement, activeTile.current);
    el.focus();
  }, [command]);

  const leave = (restore: boolean) => {
    setText("");
    setI(0);
    setCommand(null);
    if (!restore) return;
    const b = back.current;
    const tile = backTile.current;
    back.current = null;
    backTile.current = null;
    if (b?.isConnected && b !== document.body && b !== input.current) b.focus({ preventScroll: true });
    else if (!tile || !tiles.go(tile))
      document.querySelector<HTMLElement>('[data-tile="board"] .tile-b')?.focus({ preventScroll: true });
  };
  const choose = (s: Suggestion | undefined) => {
    if (!s) return;
    if (s.fill && !s.cmd) {
      setText(s.fill);
      setI(0);
      return;
    }
    save("paletteUse", { ...used, [s.id]: (used[s.id] || 0) + 1 });
    leave(true);
    if (s.cmd) runCmd(s.cmd);
  };
  const keys = (s: Suggestion) => {
    const b = s.action ? bindingsOf(s.action)[0] : undefined;
    return b ? shownKeys(b, vim ? "vim" : "standard", mac).join(" / ") : "";
  };

  // Not focused, the line shows the search that is in force, so a filtered board says why.
  const prompt = command || (query ? "/" : ":");
  const value = command === ":" ? text : command === "/" || query ? query : "";
  return (
    <div className="cmdline">
      <span className="cmd-prompt" aria-hidden="true">
        {prompt}
      </span>
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-expanded={asking}
        aria-controls="cmd-list"
        aria-activedescendant={asking && list.length ? `cmd-${cur}` : undefined}
        aria-label={t("Befehl, Session, Repo oder #PR", "Command, session, repo or #PR")}
        placeholder={
          command === "/"
            ? t("Projekt, Branch, Auftrag, Notiz…", "Project, branch, task, note…")
            : command
              ? t("merge 8 · new shop · filter wartet · mode vim", "merge 8 · new shop · filter waiting · mode vim")
              : t("Befehl · / Suche · ? Tasten", "command · / search · ? keys")
        }
        autoComplete="off"
        spellCheck={false}
        value={value}
        onFocus={(e) => {
          if (command) return;
          remember(back, backTile, e.relatedTarget instanceof Element ? e.relatedTarget : null, activeTile.current);
          setCommand(query ? "/" : ":");
        }}
        onBlur={(e) => {
          if (listRef.current?.contains(e.relatedTarget as Node | null)) return;
          setText("");
          setI(0);
          setCommand(null);
        }}
        onChange={(e) => {
          if (command === "/") setQuery(e.target.value);
          else if (e.target.value.startsWith("/")) {
            // `/` typed after `:` (or on a phone, where the line was tapped): the search, as in lnav.
            setCommand("/");
            setQuery(e.target.value.slice(1));
            setText("");
          } else {
            setText(e.target.value);
            setI(0);
          }
        }}
        onKeyDown={(e) => {
          const ev = e.nativeEvent;
          if (hit(ev, "close")) {
            if (command === "/") setQuery("");
            leave(true);
          } else if (command === "/" && hit(ev, "run", "standard", "palette")) leave(true);
          else if (!asking) return;
          else if (hit(ev, "next", "standard", "palette")) setI(Math.min(cur + 1, list.length - 1));
          else if (hit(ev, "prev", "standard", "palette")) setI(Math.max(cur - 1, 0));
          else if (hit(ev, "run", "standard", "palette")) choose(list[cur]);
          else return;
          e.preventDefault();
        }}
      />
      <div
        id="cmd-list"
        ref={listRef}
        role="listbox"
        aria-label={t("Vorschläge", "Suggestions")}
        className="cmd-list"
        hidden={!asking}
      >
        {list.map((s, n) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the keys live on the combobox input (arrows, Enter)
          <div
            key={s.id}
            id={`cmd-${n}`}
            role="option"
            tabIndex={-1}
            aria-selected={n === cur}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(s)}
          >
            <span className="cmd-l">{t(s.de, s.en)}</span>
            {s.cmd?.kind === "later" ? (
              <span className="hint">{t(`ab Stufe ${s.cmd.stage}`, `from stage ${s.cmd.stage}`)}</span>
            ) : keys(s) ? (
              <kbd>{keys(s)}</kbd>
            ) : null}
          </div>
        ))}
        {asking && !list.length && (
          <div role="option" tabIndex={-1} aria-selected="false" aria-disabled="true" className="hint">
            {t("Nichts gefunden", "Nothing found")}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Keeps where the focus came from: the element, and its tile for when the element is drawn anew meanwhile. Outside
 * any tile (the focus already fell to the page), the tile that was active.
 */
function remember(
  back: RefObject<HTMLElement | null>,
  tile: RefObject<TileId | null>,
  el: Element | null,
  active: TileId | null,
) {
  back.current = el instanceof HTMLElement ? el : null;
  tile.current = tileOf(el) ?? (!el || el === document.body ? active : null);
}

/** Rule 4: at most eight suggestion lines (tokens.css `--suggest-rows`). */
const SUGGEST_ROWS = 8;

/** Sessions, repos and PRs as the command line needs them; what comes from the server is cut to size. */
export function paletteData(data: Overview | null): PaletteData {
  if (!data) return { sessions: [], repos: [], prs: [], conflicts: [] };
  const ib = inbox(data);
  const runOf = new Map(
    [...ib.ciRed, ...ib.ciFixing].filter((c) => c.pr && c.run?.id).map((c) => [`${c.root}#${c.pr?.number}`, c.run?.id]),
  );
  const sessions = data.sessions.filter((s) => !s.meta?.hidden);
  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      root: s.repoRoot || "",
      title: String(s.title || s.project || "").slice(0, 200),
      project: String(s.project || ""),
      branch: String(s.branch || ""),
      pty: s.proc?.mode === "pty" && (s.proc.status === "running" || s.proc.status === "starting"),
    })),
    repos: data.repos.map((r) => ({ root: r.root, name: r.name })),
    // Once per PR (round 6: worktrees of one repo listed #112 three times and pushed #14 out of the eight lines):
    // the checkout on the PR's branch, else the first that knows it.
    prs: onePerPr(data.repos).flatMap((r) =>
      (r.prs?.prs || []).map((p) => {
        const runId = runOf.get(`${r.root}#${p.number}`);
        const youngest = sessions
          .filter((s) => s.repoRoot === r.root && Number(s.ci?.pr?.number) === p.number)
          .sort((x, y) => (y.lastActivity || 0) - (x.lastActivity || 0))[0];
        return {
          root: r.root,
          repo: r.name,
          number: p.number,
          title: String(p.title || "").slice(0, 200),
          url: p.url,
          runId: typeof runId === "number" ? runId : null,
          merge: mergeWay(p),
          sessionId: youngest?.id || null,
        };
      }),
    ),
    conflicts: allConflicts(sessions, data.repos),
    projectsDir: typeof data.projectsDir === "string" ? data.projectsDir.slice(0, 500) : "",
    here: data.here?.dir || "",
  };
}

/** Each repo with only the open PRs no earlier checkout of the same remote listed; the PR's own branch first. */
function onePerPr(repos: Overview["repos"]): Overview["repos"] {
  const seen = new Set<string>();
  const key = (r: Overview["repos"][number], n: number) => `${r.remote?.path || r.root}#${n}`;
  const ordered = [...repos].sort(
    (a, b) =>
      Number((b.prs?.prs || []).some((p) => p.head === b.branch)) -
      Number((a.prs?.prs || []).some((p) => p.head === a.branch)),
  );
  const keep = new Map<string, Set<number>>();
  for (const r of ordered)
    for (const p of r.prs?.prs || []) {
      const k = key(r, p.number);
      if (seen.has(k)) continue;
      seen.add(k);
      const own = keep.get(r.root) || new Set<number>();
      own.add(p.number);
      keep.set(r.root, own);
    }
  return repos.map((r) => ({
    ...r,
    prs: r.prs ? { ...r.prs, prs: (r.prs.prs || []).filter((p) => keep.get(r.root)?.has(p.number)) } : r.prs,
  }));
}
