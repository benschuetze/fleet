import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useActions } from "~/lib/actions";
import { conflictSentence, fetchConflict, fetchHunks } from "~/lib/conflict";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { conflictTree, type TreeDir, type TreeFile } from "../../../shared/conflict";
import type { ConflictHunks, ConflictSide, ConflictView } from "../../../shared/types";
import { MergePr } from "../repos/open-prs";
import { OpenButton } from "../session/open";

/**
 * Two sessions or PRs of one repo (spec, Konflikt-Visualisierung): A left, B right, one folder tree of what either
 * changed in the middle. Only folders with a file both changed are open; a file opens both sides' hunks next to
 * each other. Below, the ways out: open B to pause it, merge A first, or start a rebase session.
 */
export function ConflictPanel({ root, a, b }: { root: string; a: string; b: string }) {
  const { t } = useI18n();
  const [view, setView] = useState<ConflictView | { error: string } | null>(null);
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setView(null);
    setFile(null);
    fetchConflict(root, a, b)
      .then((v) => live && setView(v))
      .catch(() => live && setView({ error: t("Server nicht erreichbar", "Server not reachable") }));
    return () => {
      live = false;
    };
  }, [root, a, b, t]);
  const tree = useMemo(
    () => (view && "a" in view ? conflictTree(view.a.files, view.b.files, view.conflicts || []) : null),
    [view],
  );
  if (!view) return <p className="hint">{t("Lade …", "Loading …")}</p>;
  if ("error" in view) return <p className="hint">{view.error}</p>;
  return (
    <>
      <p className="c-sum">{conflictSentence(view, t)}</p>
      {view.why && <p className="hint">{view.why}</p>}
      <div className="c-cols">
        <SideHead x={view.a} n="A" />
        <SideHead x={view.b} n="B" />
      </div>
      {tree && (tree.dirs.length || tree.files.length) ? (
        <ul className="c-tree" aria-label={t("Geänderte Dateien", "Changed files")}>
          <Dir d={tree} depth={0} file={file} onFile={setFile} root />
        </ul>
      ) : (
        <p className="hint">{t("Keine geänderten Dateien bekannt.", "No changed files known.")}</p>
      )}
      {file && <Hunks root={root} a={a} b={b} file={file} />}
      <Ways view={view} />
    </>
  );
}

function SideHead({ x, n }: { x: ConflictSide; n: "A" | "B" }) {
  const { t } = useI18n();
  return (
    <div className="c-side">
      <span className="c-tag">{n}</span>
      <span className="c-label" title={x.label}>
        {x.label}
      </span>
      <span className="mono hint" title={x.branch || ""}>
        {x.branch || t("ohne Branch", "no branch")}
        {" · "}
        {x.files.length === 1 ? t("1 Datei", "1 file") : t(`${x.files.length} Dateien`, `${x.files.length} files`)}
      </span>
    </div>
  );
}

function Dir({
  d,
  depth,
  file,
  onFile,
  root = false,
}: {
  d: TreeDir;
  depth: number;
  file: string | null;
  onFile: (f: string) => void;
  root?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(d.open);
  const inner = (
    <>
      {d.dirs.map((x) => (
        <Dir key={x.path} d={x} depth={root ? depth : depth + 1} file={file} onFile={onFile} />
      ))}
      {d.files.map((f) => (
        <File key={f.path} f={f} depth={root ? depth : depth + 1} chosen={file === f.path} onFile={onFile} />
      ))}
    </>
  );
  if (root) return inner;
  return (
    <li>
      <div className="c-row" style={{ "--d": depth } as CSSProperties}>
        <span className="c-m" />
        <button type="button" className="c-dir link" aria-expanded={open} onClick={() => setOpen(!open)}>
          {d.name}/{" "}
          <span className="hint">
            {d.both ? t(`${d.count} · ${d.both} von beiden`, `${d.count} · ${d.both} by both`) : String(d.count)}
          </span>
        </button>
        <span className="c-m" />
      </div>
      {open && <ul>{inner}</ul>}
    </li>
  );
}

function File({
  f,
  depth,
  chosen,
  onFile,
}: {
  f: TreeFile;
  depth: number;
  chosen: boolean;
  onFile: (f: string) => void;
}) {
  const { t } = useI18n();
  const who = f.a && f.b ? t("beide", "both") : f.a ? t("nur A", "only A") : f.b ? t("nur B", "only B") : "";
  const state = f.conflict ? `${who ? `${who}, ` : ""}${t("Merge-Konflikt", "merge conflict")}` : who;
  return (
    <li>
      <div className={`c-row c-file${f.a && f.b ? " both" : ""}`} style={{ "--d": depth } as CSSProperties}>
        <span className="c-m">{f.a ? "A" : ""}</span>
        <button
          type="button"
          className="link"
          aria-pressed={chosen}
          aria-label={`${f.name}: ${state}`}
          title={f.path}
          onClick={() => onFile(f.path)}
        >
          {f.name}
          {f.conflict && <span className="sig crit">{t("Konflikt", "Conflict")}</span>}
        </button>
        <span className="c-m">{f.b ? "B" : ""}</span>
      </div>
    </li>
  );
}

function Hunks({ root, a, b, file }: { root: string; a: string; b: string; file: string }) {
  const { t } = useI18n();
  const [h, setH] = useState<ConflictHunks | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    setH(null);
    fetchHunks(root, a, b, file)
      .then((x) => live && setH(x))
      .catch(() => live && setH({ error: t("Server nicht erreichbar", "Server not reachable") }));
    return () => {
      live = false;
    };
  }, [root, a, b, file, t]);
  return (
    <section className="c-hunks" aria-label={t(`Änderungen in ${file}`, `Changes in ${file}`)}>
      <h3 className="mono" title={file}>
        {file}
      </h3>
      {!h ? (
        <p className="hint">{t("Lade …", "Loading …")}</p>
      ) : "error" in h ? (
        <p className="hint">{h.error}</p>
      ) : (
        <div className="c-two">
          <Diff n="A" text={h.a} />
          <Diff n="B" text={h.b} />
          {h.truncated && <p className="hint">{t("… gekürzt", "… cut")}</p>}
        </div>
      )}
    </section>
  );
}

function Diff({ n, text }: { n: "A" | "B"; text: string | null }) {
  const { t } = useI18n();
  if (!text)
    return (
      <p className="hint">
        {t(`${n}: keine Änderung an dieser Datei sichtbar`, `${n}: no change to this file visible`)}
      </p>
    );
  // Header lines of git diff say nothing here; the hunks start at "@@".
  const lines = text.split("\n");
  const from = Math.max(
    0,
    lines.findIndex((l) => l.startsWith("@@")),
  );
  // Plain text: + and - say what changed (text before colour), mono keeps the columns.
  return (
    <section className="c-diff-box" aria-label={t(`Seite ${n}`, `Side ${n}`)}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling block must be reachable by keyboard (WCAG 2.1.1) */}
      <pre className="c-diff" tabIndex={0}>
        {lines.slice(from).join("\n")}
      </pre>
    </section>
  );
}

/** Spec: "Session B pausieren, A zuerst mergen, oder Rebase-Session starten" – each only where it can work. */
function Ways({ view }: { view: ConflictView }) {
  const { t } = useI18n();
  const { data, sessionById } = useFleet();
  const act = useActions();
  const prOf = (x: ConflictSide) =>
    x.kind === "pr"
      ? data?.repos.find((r) => r.root === view.root)?.prs?.prs?.find((p) => `pr:${p.number}` === x.ref) || null
      : null;
  const sessionOf = (x: ConflictSide) => (x.kind === "session" ? sessionById.get(x.ref.slice(2)) || null : null);
  const pa = prOf(view.a);
  const sb = sessionOf(view.b);
  const files = [...new Set([...(view.conflicts || []), ...view.shared])].slice(0, 8);
  const rebase = !!data?.terminal?.available && !!view.a.branch && !!view.b.branch && view.a.branch !== view.b.branch;
  if (!pa && !sb && !rebase) return null;
  return (
    <fieldset className="c-ways" aria-label={t("Auswege", "Ways out")}>
      {sb && (
        <OpenButton
          s={sb}
          label={t("B öffnen und anhalten", "Open B and pause it")}
          hint={t(
            "Session B öffnen, um sie anzuhalten, bis A fertig ist",
            "Open session B to pause it until A is done",
          )}
        />
      )}
      {pa && (
        <span className="c-way">
          <span className="hint">{t(`A zuerst: #${pa.number}`, `A first: #${pa.number}`)}</span>
          <MergePr root={view.root} p={pa} />
        </span>
      )}
      {rebase && (
        <button
          type="button"
          className="act-link"
          title={t(
            "Startet eine Session im Fleet-Terminal (kostet Tokens)",
            "Starts a session in the Fleet terminal (costs tokens)",
          )}
          onClick={() =>
            act.newSession(
              view.root,
              t(
                `Bringe den Branch ${view.b.branch} per Rebase auf den Stand von ${view.a.branch} und löse die Konflikte${files.length ? ` in: ${files.join(", ")}` : ""}. Danach die Tests laufen lassen.`,
                `Rebase the branch ${view.b.branch} onto ${view.a.branch} and resolve the conflicts${files.length ? ` in: ${files.join(", ")}` : ""}. Run the tests afterwards.`,
              ),
            )
          }
        >
          {t("Rebase-Session starten", "Start a rebase session")}
        </button>
      )}
    </fieldset>
  );
}
