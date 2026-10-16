import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { changeStarts, parseDiffView, parseFileView, STATUS_WORD } from "~/lib/diff";
import { useI18n } from "~/lib/i18n";
import { type DiffTarget, useKeys } from "~/lib/keyboard";
import { hit } from "~/lib/keymap";
import type { DiffView as Diff, DiffFile, FileView } from "../../../shared/types";
import { Safe } from "../safe";

/**
 * The diff and files view (release 6, plan R9, R10): what a session changed, full screen above the status line,
 * like the log view. Left the files (the session's own first), right every file's diff in red and green, or one
 * file's whole text. Every key is its own here: j/k scroll, n/N the next change (or search hit), ]/[ the next file,
 * t or Enter the whole file, f the file list, / the search, Esc or q back to where it was opened.
 */
export function DiffLayer() {
  const { diff } = useKeys();
  if (!diff) return null;
  return (
    <Safe>
      <DiffPane key={diff.id} target={diff} />
    </Safe>
  );
}

type Load = { state: "loading" } | { state: "failed"; why: string } | { state: "ok"; view: Diff };

const ROW = 20;
const SIGN: Record<string, string> = { "+": "+", "-": "−", " ": " " };

function DiffPane({ target }: { target: DiffTarget }) {
  const { t } = useI18n();
  const { setDiff } = useKeys();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [cur, setCur] = useState(0);
  const [content, setContent] = useState<FileView | null | "loading">(null);
  // The status line follows the view: in the whole file `t` leads back to the changes.
  const whole = !!content && content !== "loading";
  useEffect(() => {
    if (!!target.whole !== whole) setDiff({ ...target, whole });
  }, [whole, target, setDiff]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [say, setSay] = useState("");
  const main = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const pending = useRef("");
  /** The change or hit `n` went to last; -1 before the first. */
  const at = useRef(-1);
  /** Until then a scroll is Fleet's own (a jump), not the user's: the file list keeps what the jump chose. */
  const quiet = useRef(0);

  useEffect(() => {
    let gone = false;
    fetch(`/api/diff?id=${encodeURIComponent(target.id)}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (gone) return;
        const v = r.ok ? parseDiffView(j) : null;
        setLoad(v ? { state: "ok", view: v } : { state: "failed", why: String(j?.error || `HTTP ${r.status}`) });
      })
      .catch((e) => !gone && setLoad({ state: "failed", why: e instanceof Error ? e.message : String(e) }));
    return () => {
      gone = true;
    };
  }, [target.id]);

  useEffect(() => {
    main.current?.focus({ preventScroll: true });
  }, []);

  const files = load.state === "ok" ? load.view.files : [];
  const totals = useMemo(
    () => files.reduce((a, f) => ({ add: a.add + f.add, del: a.del + f.del }), { add: 0, del: 0 }),
    [files],
  );
  const file = files[cur] as DiffFile | undefined;

  const showFile = useCallback(
    (i: number, scroll = true) => {
      if (!files.length) return;
      const n = Math.max(0, Math.min(files.length - 1, i));
      setCur(n);
      setContent(null);
      at.current = -1;
      quiet.current = Date.now() + 400;
      // The status follows the file (practical test 15 Oct: "Change 1 of 4" stood after ]), and n goes on from its
      // first change.
      setSay(t(`Datei ${n + 1} von ${files.length}`, `File ${n + 1} of ${files.length}`));
      requestAnimationFrame(() => {
        const box = main.current;
        const chg = box ? [...box.querySelectorAll<HTMLElement>("[data-chg]")] : [];
        const first = chg.findIndex((x) => Number(x.closest<HTMLElement>("[data-fi]")?.dataset.fi) >= n);
        at.current = first > 0 ? first - 1 : -1;
        const el = box?.querySelector<HTMLElement>(`[data-file="${n}"]`);
        if (scroll && el && box) box.scrollTop = el.offsetTop - box.offsetTop;
      });
      list.current?.querySelector<HTMLElement>(`[data-i="${n}"]`)?.scrollIntoView?.({ block: "nearest" });
    },
    [files.length, t],
  );

  const openContent = useCallback(async () => {
    if (!file) return;
    if (content) {
      setContent(null);
      return;
    }
    if (file.status === "D") return setSay(t("Gelöscht – nur der Diff", "Deleted: only the diff"));
    setContent("loading");
    try {
      const r = await fetch(`/api/file?id=${encodeURIComponent(target.id)}&path=${encodeURIComponent(file.path)}`, {
        cache: "no-store",
      });
      const v = r.ok ? parseFileView(await r.json()) : null;
      setContent(v || null);
      if (!v) setSay(t("Datei nicht lesbar", "File not readable"));
      requestAnimationFrame(() => main.current?.scrollTo?.(0, 0));
    } catch {
      setContent(null);
      setSay(t("Datei nicht lesbar", "File not readable"));
    }
  }, [content, file, t, target.id]);

  // Which file is at the top while scrolling the diff: the list follows.
  const onScroll = useCallback(() => {
    const el = main.current;
    if (!el || content || Date.now() < quiet.current) return;
    const heads = [...el.querySelectorAll<HTMLElement>("[data-file]")];
    let at = 0;
    for (const h of heads) if (h.offsetTop - el.offsetTop <= el.scrollTop + 4) at = Number(h.dataset.file);
    setCur(at);
  }, [content]);

  /** Lines to jump to with n/N: search hits while a search is on, else the start of every change. */
  const targets = useCallback(() => {
    const el = main.current;
    if (!el) return [];
    return [...el.querySelectorAll<HTMLElement>(query ? "[data-hit]" : "[data-chg]")];
  }, [query]);

  // A new search starts counting its hits from the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query is the trigger, not a value read here
  useEffect(() => {
    at.current = -1;
  }, [query]);

  /**
   * n and N: the next change (or hit) in order, also when the whole diff fits on the screen. The one gone to is marked
   * (`data-cur`) and brought into sight; the file list follows it.
   */
  const jump = useCallback(
    (dir: 1 | -1) => {
      const el = main.current;
      if (!el) return;
      const all = targets();
      if (!all.length) return setSay(query ? t("Kein Treffer", "No hit") : t("Keine Änderung", "No change"));
      const i = ((((at.current < 0 && dir < 0 ? 0 : at.current) + dir) % all.length) + all.length) % all.length;
      at.current = i;
      for (const x of el.querySelectorAll("[data-cur]")) x.removeAttribute("data-cur");
      const next = all[i] as HTMLElement;
      next.setAttribute("data-cur", "");
      quiet.current = Date.now() + 400;
      next.scrollIntoView?.({ block: "center" });
      const fi = Number(next.closest<HTMLElement>("[data-fi]")?.dataset.fi);
      if (Number.isInteger(fi)) setCur(fi);
      setSay(
        query
          ? t(`Treffer ${i + 1} von ${all.length}`, `Hit ${i + 1} of ${all.length}`)
          : t(`Änderung ${i + 1} von ${all.length}`, `Change ${i + 1} of ${all.length}`),
      );
    },
    [query, t, targets],
  );

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const typing = e.target === searchBox.current;
      if (typing) {
        if (e.key === "Escape") {
          e.preventDefault();
          setSearching(false);
          main.current?.focus({ preventScroll: true });
        } else if (e.key === "Enter") {
          e.preventDefault();
          setSearching(false);
          main.current?.focus({ preventScroll: true });
          requestAnimationFrame(() => jump(1));
        }
        return;
      }
      const inList = !!(e.target as HTMLElement | null)?.closest?.(".df-files");
      const el = main.current;
      const by = (dy: number) => {
        if (el) el.scrollTop += dy;
      };
      const seq = `${pending.current} ${e.key}`.trim();
      pending.current = "";
      let done = true;
      if (hit(e, "close") || (e.key === "q" && !e.ctrlKey && !e.metaKey)) {
        if (content) setContent(null);
        else setDiff(null);
      } else if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        setSearching(true);
        requestAnimationFrame(() => searchBox.current?.focus());
      } else if (hit(e, "diffFiles")) {
        if (inList) el?.focus({ preventScroll: true });
        else list.current?.querySelector<HTMLElement>(`[data-i="${cur}"]`)?.focus();
      } else if (inList && (e.key === "j" || e.key === "ArrowDown" || e.key === "k" || e.key === "ArrowUp")) {
        const i = cur + (e.key === "j" || e.key === "ArrowDown" ? 1 : -1);
        showFile(i);
        list.current?.querySelector<HTMLElement>(`[data-i="${Math.max(0, Math.min(files.length - 1, i))}"]`)?.focus();
      } else if (inList && e.key === "Enter") {
        el?.focus({ preventScroll: true });
      } else if (hit(e, "diffNext")) jump(1);
      else if (hit(e, "diffPrev")) jump(-1);
      else if (hit(e, "diffFileNext")) showFile(cur + 1);
      else if (hit(e, "diffFilePrev")) showFile(cur - 1);
      else if (hit(e, "diffContent")) openContent();
      else if (e.key === "j" || e.key === "ArrowDown") by(ROW);
      else if (e.key === "k" || e.key === "ArrowUp") by(-ROW);
      else if ((e.ctrlKey && e.key === "d") || (e.key === " " && !e.shiftKey)) by((el?.clientHeight || 400) / 2);
      else if ((e.ctrlKey && e.key === "u") || (e.key === " " && e.shiftKey)) by(-(el?.clientHeight || 400) / 2);
      else if (e.key === "PageDown") by((el?.clientHeight || 400) - ROW);
      else if (e.key === "PageUp") by(-(el?.clientHeight || 400) + ROW);
      else if (e.key === "Home" || seq === "g g") el?.scrollTo?.(0, 0);
      else if (e.key === "End" || e.key === "G") el?.scrollTo?.(0, el.scrollHeight);
      else if (e.key === "g" && !e.ctrlKey && !e.metaKey) pending.current = "g";
      else if (e.key === "Tab") done = false;
      else done = false;
      if (done) e.preventDefault();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [content, cur, files.length, jump, openContent, setDiff, showFile]);

  const q = query.trim().toLowerCase();
  const view = load.state === "ok" ? load.view : null;
  return (
    <section className="diffview" aria-label={t(`Änderungen: ${target.title}`, `Changes: ${target.title}`)}>
      <div className="df-head">
        <h2>{t("Änderungen", "Changes")}</h2>
        <span className="df-title">{target.title}</span>
        {view && (
          <span className="df-meta" data-testid="diff-summary">
            {view.branch ? `${view.branch} ` : ""}
            {t("gegen", "vs")} {view.base} · {files.length} {t("Dateien", "files")} ·{" "}
            <span className="df-add">+{totals.add}</span> <span className="df-del">−{totals.del}</span>
            {view.cut && ` · ${t("gekürzt", "cut")}`}
          </span>
        )}
        <button type="button" className="link" onClick={() => setDiff(null)}>
          {t("Zurück", "Back")}
        </button>
      </div>
      {searching && (
        <div className="df-search">
          /
          <input
            ref={searchBox}
            className="search"
            type="search"
            aria-label={t("Im Diff suchen", "Search in the diff")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </div>
      )}
      <div className="df-body">
        <nav className="df-files" aria-label={t("Dateien", "Files")}>
          <ol ref={list}>
            {files.map((f, i) => (
              <li key={f.path}>
                <button
                  type="button"
                  data-i={i}
                  aria-current={i === cur ? "true" : undefined}
                  title={`${f.path} – ${t(...STATUS_WORD[f.status])}${f.mine ? t(" · von dieser Session", " · by this session") : ""}`}
                  onClick={() => showFile(i)}
                >
                  <span className={`df-st s-${f.status}`}>{f.status}</span>
                  <span className="df-mine">{f.mine ? "●" : " "}</span>
                  <span className="df-path">{f.path}</span>
                  {f.status !== "E" && (
                    <span className="df-n">
                      <span className="df-add">+{f.add}</span> <span className="df-del">−{f.del}</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the diff scrolls by keys, so it takes the focus */}
        <div className="df-main" ref={main} tabIndex={0} onScroll={onScroll} role="document">
          {load.state === "loading" && <p className="df-empty">{t("Lade …", "Loading …")}</p>}
          {load.state === "failed" && (
            <p className="df-empty" role="alert">
              {t("Änderungen nicht lesbar", "Changes not readable")}: {load.why}
            </p>
          )}
          {view?.error && <p className="df-empty">{view.error}</p>}
          {view && !files.length && (
            <p className="df-empty">{t("Keine Änderungen gegen die Basis.", "No changes against the base.")}</p>
          )}
          {say && (
            <p className="sr" role="status">
              {say}
            </p>
          )}
          {content === "loading" ? (
            <p className="df-empty">{t("Lade Datei …", "Loading file …")}</p>
          ) : content ? (
            <FileText f={content} q={q} />
          ) : (
            files.map((f, i) => <FileDiff key={f.path} f={f} i={i} q={q} />)
          )}
        </div>
      </div>
      <div className="df-foot" data-testid="diff-say">
        {say}
      </div>
    </section>
  );
}

function FileDiff({ f, i, q }: { f: DiffFile; i: number; q: string }) {
  const { t } = useI18n();
  const starts = new Set<string>();
  f.hunks.forEach((h, hi) => {
    for (const s of changeStarts(h.lines)) starts.add(`${hi}:${s}`);
  });
  return (
    <article className="df-file" aria-label={f.path} data-fi={i}>
      <h3 data-file={i}>
        <span className={`df-st s-${f.status}`}>{f.status}</span> {f.old ? `${f.old} → ` : ""}
        {f.path}
        {f.mine && <span className="df-hint"> · {t("von dieser Session", "by this session")}</span>}
      </h3>
      {f.binary && <p className="df-empty">{t("Binärdatei", "Binary file")}</p>}
      {f.status === "E" && (
        <p className="df-empty">
          {t("Außerhalb des Repos – t zeigt den Inhalt", "Outside the repo: t shows its text")}
        </p>
      )}
      {f.hunks.map((h, hi) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hunks have no id; their order is their identity
        <div className="df-hunk" key={hi}>
          <div className="df-hh">{h.header}</div>
          {h.lines.map((l, li) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no id
              key={li}
              className={`df-l ${l.t === "+" ? "add" : l.t === "-" ? "del" : ""}`}
              data-chg={starts.has(`${hi}:${li}`) ? "" : undefined}
              data-hit={q && l.text.toLowerCase().includes(q) ? "" : undefined}
            >
              <span className="df-na">{l.a ?? ""}</span>
              <span className="df-nb">{l.b ?? ""}</span>
              <span className="df-sg">{SIGN[l.t]}</span>
              <span className="df-tx">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
      {f.cut && <p className="df-empty">{t("… gekürzt (zu lang)", "… cut (too long)")}</p>}
    </article>
  );
}

function FileText({ f, q }: { f: FileView; q: string }) {
  const { t } = useI18n();
  if (f.missing) return <p className="df-empty">{t("Datei gibt es nicht mehr", "The file is gone")}</p>;
  if (f.binary) return <p className="df-empty">{t("Binärdatei", "Binary file")}</p>;
  const lines = f.text.replace(/\n$/, "").split("\n");
  return (
    <article className="df-file" aria-label={t(`Datei ${f.path}`, `File ${f.path}`)}>
      <h3>
        {f.path}{" "}
        <span className="df-hint">· {t("ganze Datei – t zurück zum Diff", "whole file: t back to the diff")}</span>
      </h3>
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a line's number is its identity
        <div key={i} className="df-l" data-hit={q && l.toLowerCase().includes(q) ? "" : undefined}>
          <span className="df-nb">{i + 1}</span>
          <span className="df-tx">{l}</span>
        </div>
      ))}
      {f.cut && <p className="df-empty">{t("… gekürzt (über 512 KB)", "… cut (over 512 KB)")}</p>}
    </article>
  );
}
