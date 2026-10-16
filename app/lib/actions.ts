import { useCallback, useMemo } from "react";
import type { Meta, Session } from "../../shared/types";
import { post, postStatus } from "./api";
import { copyText } from "./copy";
import { useFleet } from "./fleet";
import { money, tokenWord, toks } from "./format";
import { useI18n } from "./i18n";
import { appOpens, approvalHolder, approvalWhere, openable } from "./session";

const isLive = (s: Session) => s.proc?.mode === "pty" && (s.proc.status === "running" || s.proc.status === "starting");

export function useActions() {
  const { t, locale } = useI18n();
  const { data, reload, showToast, setPref, sessionById, openDrawer, watchJob } = useFleet();
  const label = useCallback(
    (id: string | null | undefined) => (data?.openTargets || []).find((x) => x.id === id)?.label || "",
    [data],
  );

  const run = useCallback(
    async <T>(fn: () => Promise<T>, ok: (r: T) => string, failPrefix: string) => {
      try {
        const r = await fn();
        showToast(ok(r));
        // Started in Fleet's own window: show it right away.
        const proc = (r as { proc?: unknown } | null)?.proc;
        if (typeof proc === "string") openDrawer({ id: proc, title: t("Neue Session", "New session"), focus: true });
        return r;
      } catch (e) {
        showToast(`${failPrefix}: ${e instanceof Error ? e.message : e}`);
        return null;
      } finally {
        reload(true);
      }
    },
    [showToast, reload, openDrawer, t],
  );

  /** Continue a session in Fleet's window; if it may still run elsewhere, the drawer asks first. */
  const openFleet = useCallback(
    async (s: Session, force = false, focus = false) => {
      const title = String(s.title || s.project || "");
      // Never a branch out of an approval held elsewhere (live 16.10.2026): it cannot answer it and showed the call as
      // "Interrupted". Every way into Fleet's terminal (Enter, →, i, the drawer, the palette, a question's owner)
      // comes through here. In Fleet's own terminal the prompt stands in it, so that one opens.
      const holder = approvalHolder(s, data?.decisions);
      if (holder && holder !== "terminal") {
        if (holder === "app" && appOpens(s, data)) {
          await run(
            () => post("/api/open", { id: s.id, target: "desktop" }),
            (r) =>
              (r as { demo?: boolean })?.demo
                ? t("Demo: würde in der Claude-App öffnen", "Demo: would open in the Claude app")
                : t("Öffnet in der Claude-App – dort freigeben", "Opening in the Claude app: approve it there"),
            t("Öffnen fehlgeschlagen", "Opening failed"),
          );
          return;
        }
        showToast(approvalWhere(holder, t, false, s.waits === "question"), true);
        return;
      }
      try {
        const r = await postStatus("/api/term/resume", { id: s.id, force });
        if (r.ok && typeof r.json.id === "string") {
          openDrawer({ id: r.json.id, title, focus });
          showToast(
            r.json.forked
              ? t(
                  `${title}: läuft noch woanders (z. B. Desktop-App) – hier als eigener Zweig fortgesetzt, das Original bleibt`,
                  `${title}: still runs elsewhere (e.g. the desktop app); continued here as a branch of its own, the original stays`,
                )
              : t(`${title}: im Fleet-Terminal`, `${title}: in the Fleet terminal`),
          );
        } else if (r.status === 409 && r.json.elsewhere)
          openDrawer({ id: s.id, title, confirm: { session: s.id, text: String(r.json.error || "") } });
        else showToast(`${t("Terminal ging nicht", "Terminal did not work")}: ${String(r.json.error || r.status)}`);
      } catch (e) {
        showToast(`${t("Terminal ging nicht", "Terminal did not work")}: ${e instanceof Error ? e.message : e}`);
      }
      reload(true);
    },
    [data, openDrawer, showToast, reload, run, t],
  );

  /**
   * Into a session's terminal from anywhere (release 6, plan R8): a session already running in Fleet's window opens
   * at once, without waiting for the server; any other local one is resumed there. The terminal fills the screen and
   * takes the keys; Esc leads back. A replaced session leads to its successor, a cloud one to its page.
   */
  const jump = useCallback(
    (s: Session) => {
      if (s.source === "cloud" || s.source === "cowork") {
        if (s.url && /^https:\/\//.test(s.url)) window.open(s.url, "_blank", "noopener,noreferrer");
        else showToast(t("Läuft in der Cloud – kein Terminal", "Runs in the cloud: no terminal"));
        return;
      }
      const next = s.next ? sessionById.get(s.next.id) : undefined;
      const target = next || s;
      if (isLive(target)) {
        openDrawer({ id: target.id, title: String(target.title || target.project || ""), focus: true });
        return;
      }
      if (data?.terminal?.available && openable(target, !!data?.demo)) {
        openFleet(target, false, true);
        return;
      }
      showToast(
        `${t("Terminal im Fenster nicht verfügbar", "Terminal in the window not available")}${data?.terminal?.why ? `: ${data.terminal.why}` : ""}`,
      );
    },
    [data, openDrawer, openFleet, sessionById, showToast, t],
  );

  return useMemo(
    () => ({
      label,
      jump,
      copy: async (text: string, what: string) => {
        await copyText(text);
        showToast(t(`${what} kopiert`, `${what} copied`));
      },
      openFleet,
      /** Release 6 (plan R7): a new project folder under the projects folder, and Claude in it, full screen. */
      newFolder: (name: string, prompt: string) =>
        run(
          // `proc` makes run() open the terminal at once.
          () =>
            post<{ id?: string; folder?: string; created?: boolean }>("/api/term/new-folder", { name, prompt }).then(
              (r) => ({ ...r, proc: r.id }),
            ),
          (r) =>
            r.created
              ? t(
                  `Neuer Ordner ${String(r.folder || name)}: Claude startet`,
                  `New folder ${String(r.folder || name)}: Claude starts`,
                )
              : t(
                  `${String(r.folder || name)} gab es schon: Claude startet dort`,
                  `${String(r.folder || name)} existed: Claude starts there`,
                ),
          t("Neue Session ging nicht", "New session did not work"),
        ),
      /** `fleet` typed in a folder: Claude there, full screen (server/core/here.ts). */
      startHere: (dir: string, prompt: string) =>
        run(
          () => post<{ id?: string }>("/api/term/here", { dir, prompt }).then((r) => ({ ...r, proc: r.id })),
          () => t(`Claude startet in ${dir}`, `Claude starts in ${dir}`),
          t("Neue Session ging nicht", "New session did not work"),
        ),
      /**
       * A new session in a repo, in Fleet's window, with an optional task. `worktree` (`:wt`) asks for a worktree of
       * its own; the server gives one anyway when another session already works or waits in the repo's folder.
       */
      newSession: (root: string, prompt: string, worktree = false) =>
        run(
          () =>
            post<{
              id?: string;
              worktree?: { name: string; branch: string; setup: string | null };
              worktreeError?: string;
            }>("/api/term/new", { root, prompt, ...(worktree ? { worktree: true } : {}) }),
          (r) =>
            r.worktree
              ? t(
                  `Worktree ${r.worktree.branch} angelegt${r.worktree.setup ? ` (${r.worktree.setup} läuft)` : ""}: Claude startet dort`,
                  `Worktree ${r.worktree.branch} created${r.worktree.setup ? ` (${r.worktree.setup} running)` : ""}: Claude starts there`,
                )
              : r.worktreeError
                ? t(
                    `Kein Worktree (${r.worktreeError}): Claude startet im Repo-Ordner`,
                    `No worktree (${r.worktreeError}): Claude starts in the repo folder`,
                  )
                : t("Neue Session im Fleet-Terminal", "New session in the Fleet terminal"),
          t("Neue Session ging nicht", "New session did not work"),
        ).then((r) => {
          if (r && typeof r.id === "string")
            openDrawer({ id: r.id, title: prompt || t("Neue Session", "New session"), focus: true });
          return r;
        }),
      /**
       * `:cleanup`, second question (plan T1.4): Fleet's own worktrees whose branch is merged, with nothing
       * uncommitted and no session in them. Removing cannot be undone, so the question says so.
       */
      cleanWorktrees: async (roots: string[], ask: (text: string, run: () => void) => void) => {
        type W = { dir: string; branch: string };
        const found: { root: string; wts: W[] }[] = [];
        const seen = new Set<string>();
        for (const root of roots) {
          const r = await post<{ main?: string; candidates?: W[] }>("/api/worktrees", { root }).catch(() => null);
          // Worktrees of one repo share one list: ask once per main folder, count each worktree once.
          if (!r?.main || seen.has(r.main)) continue;
          seen.add(r.main);
          if (r.candidates?.length) found.push({ root, wts: r.candidates });
        }
        const n = found.reduce((k, f) => k + f.wts.length, 0);
        if (!n) return;
        ask(
          t(
            `${n} erledigte Worktrees entfernen (Branch gemergt, nichts offen, keine Session)? u holt sie nicht zurück. y/n`,
            `Remove ${n} finished worktrees (branch merged, nothing open, no session)? u cannot bring them back. y/n`,
          ),
          () =>
            void run(
              async () => {
                let removed = 0;
                const failed: string[] = [];
                for (const f of found) {
                  const r = await post<{ removed?: string[]; failed?: { dir: string; error: string }[] }>(
                    "/api/worktrees",
                    { root: f.root, remove: f.wts.map((w) => w.dir) },
                  );
                  removed += r.removed?.length || 0;
                  for (const x of r.failed || []) failed.push(x.error);
                }
                return { removed, failed };
              },
              (r) =>
                r.failed.length
                  ? t(
                      `${r.removed} Worktrees entfernt, ${r.failed.length} blieben: ${r.failed[0]}`,
                      `${r.removed} worktrees removed, ${r.failed.length} stayed: ${r.failed[0]}`,
                    )
                  : t(`${r.removed} Worktrees entfernt`, `${r.removed} worktrees removed`),
              t("Worktrees entfernen ging nicht", "Removing worktrees did not work"),
            ),
        );
      },
      /** Fleet writes the handoff now, headless; the exact tokens come to the status line when it is done. */
      handoffJob: (s: Session) =>
        run(
          () => post<{ id?: string }>("/api/job", { kind: "handoff", id: s.id }),
          (r) => {
            if (!r.demo && typeof r.id === "string")
              watchJob(r.id, (res) =>
                res.ok
                  ? t(
                      `${s.project}: Übergabe geschrieben${res.tokens ? ` – ${toks(res.tokens.input + res.tokens.output + res.tokens.cacheRead + res.tokens.cacheWrite, locale)} ${tokenWord(locale)}` : ""}${res.costUsd !== null && data?.billing === "api" ? `, ${money(res.costUsd, locale)}` : ""}`,
                      `${s.project}: handoff written${res.tokens ? `: ${toks(res.tokens.input + res.tokens.output + res.tokens.cacheRead + res.tokens.cacheWrite, locale)} tokens` : ""}${res.costUsd !== null && data?.billing === "api" ? `, ${money(res.costUsd, locale)}` : ""}`,
                    )
                  : t(
                      `${s.project}: Übergabe-Job fehlgeschlagen (${res.error || "?"})`,
                      `${s.project}: handoff job failed (${res.error || "?"})`,
                    ),
              );
            return r.demo
              ? t(
                  "Demo: würde die Übergabe im Hintergrund schreiben",
                  "Demo: would write the handoff in the background",
                )
              : t(
                  `${s.project}: schreibt die Übergabe im Hintergrund …`,
                  `${s.project}: writing the handoff in the background …`,
                );
          },
          t("Übergabe ging nicht", "Handoff did not work"),
        ),
      /** Opens the session (or its successor, if there is one) in a program, or in Fleet's own window. */
      openIn: (s: Session, target: string, remember = true) => {
        // A key like `o` opens once somewhere else; only a choice in the menu changes the preferred target.
        if (remember) setPref("openTarget", target);
        if (target === "fleet") {
          const next = s.next ? sessionById.get(s.next.id) : undefined;
          return openFleet(next || s);
        }
        const id = s.next && sessionById.has(s.next.id) ? s.next.id : s.id;
        return run(
          () => post("/api/open", { id, target }),
          (r) =>
            r.demo
              ? t(`Demo: würde in ${label(target)} öffnen`, `Demo: would open in ${label(target)}`)
              : t(`Öffnet in ${label(target)} …`, `Opening in ${label(target)} …`),
          t("Öffnen fehlgeschlagen", "Opening failed"),
        );
      },
      fresh: (s: Session, target: string | null) =>
        run(
          () =>
            post<{ mode?: "turn-end" | "background" | "ask"; target?: string | null }>("/api/fresh", {
              id: s.id,
              target,
            }),
          (r) => {
            const where =
              r.target || target ? t(` in ${label(r.target || target)}`, ` in ${label(r.target || target)}`) : "";
            if (r.demo) return t(`Demo: würde frisch starten${where}`, `Demo: would start fresh${where}`);
            if (r.mode === "background")
              return t(
                `${s.project}: fasst im Hintergrund zusammen, dann öffnet sich die neue Session${where}`,
                `${s.project}: summarising in the background, then the new session opens${where}`,
              );
            if (r.mode === "ask")
              return t(
                `${s.project}: Schick der Session kurz „Übergabe“ – sie fasst zusammen, dann öffnet Fleet die neue${where}`,
                `${s.project}: send the session a quick "handoff"; it summarises, then Fleet opens the new one${where}`,
              );
            return t(
              `${s.project}: am Ende des Turns Übergabe, dann neue Session${where}`,
              `${s.project}: handoff at the end of the turn, then a new session${where}`,
            );
          },
          t("Ging nicht", "Did not work"),
        ),
      freshOff: (s: Session) =>
        run(
          () => post("/api/fresh", { id: s.id, on: false }),
          () => t("Zurückgenommen", "Withdrawn"),
          t("Ging nicht", "Did not work"),
        ),
      merge: (s: Session, force = false) => {
        const n = s.ci?.pr?.number;
        return run(
          () => post("/api/merge", { id: s.id, force }),
          (r) =>
            r.demo
              ? t(`Demo: würde PR #${n} mergen`, `Demo: would merge PR #${n}`)
              : t(`PR #${n} gemergt`, `PR #${n} merged`),
          t("Mergen fehlgeschlagen", "Merge failed"),
        );
      },
      mergePr: (root: string, number: number, force = false) =>
        run(
          () => post("/api/merge-pr", { root, number, force }),
          (r) =>
            r.demo
              ? t(`Demo: würde PR #${number} mergen`, `Demo: would merge PR #${number}`)
              : t(`PR #${number} gemergt`, `PR #${number} merged`),
          t("Mergen fehlgeschlagen", "Merge failed"),
        ),
      decide: (id: string, answer: string, answerLabel: string) =>
        run(
          () => post("/api/decision", { id, answer }),
          (r) =>
            r.demo
              ? t(
                  `Demo: „${answerLabel}“ ginge jetzt an die Session`,
                  `Demo: "${answerLabel}" would go to the session now`,
                )
              : t(`„${answerLabel}“ geht an die Session`, `"${answerLabel}" goes to the session`),
          t("Senden fehlgeschlagen", "Sending failed"),
        ),
      meta: async (id: string, patch: Meta, quiet = true) => {
        try {
          await post("/api/meta", { id, ...patch });
          if (!quiet) showToast("note" in patch ? t("Notiz gespeichert", "Note saved") : t("Gespeichert", "Saved"));
        } catch (e) {
          showToast(`${t("Speichern fehlgeschlagen", "Saving failed")}: ${e instanceof Error ? e.message : e}`);
        }
        reload(true);
      },
      continueIn: (root: string, target: string) =>
        run(
          () => post("/api/continue", { root, target }),
          (r) =>
            r.demo
              ? t(
                  `Demo: würde in ${label(target)} eine neue Session öffnen`,
                  `Demo: would open a new session in ${label(target)}`,
                )
              : t(
                  `Neue Session in ${label(target)} – Auftrag ist vorausgefüllt`,
                  `New session in ${label(target)}, the prompt is pre-filled`,
                ),
          t("Öffnen fehlgeschlagen", "Opening failed"),
        ),
      mergeSessions: (root: string, target: string) =>
        run(
          () => post<{ target?: string }>("/api/merge-sessions", { root, target }),
          (r) =>
            r.demo
              ? t(
                  `Demo: würde zusammenfassen und in ${label(r.target)} öffnen`,
                  `Demo: would merge and open in ${label(r.target)}`,
                )
              : t(
                  `Zusammengefasst – neue Session in ${label(r.target)} geöffnet, mit Enter abschicken`,
                  `Merged: new session opened in ${label(r.target)}, send it with Enter`,
                ),
          t("Zusammenfassen ging nicht", "Merging did not work"),
        ),
      runAction: (root: string, id: number, action: "rerun" | "cancel" | "fix", target?: string) =>
        run(
          () => post("/api/run", { root, id, action, target }),
          (r) => {
            const done = {
              rerun: t("Fehlgeschlagene Jobs neu gestartet", "Failed jobs restarted"),
              cancel: t("Lauf abgebrochen", "Run cancelled"),
              fix: t(
                "Fix-Session geöffnet – Auftrag ist vorausgefüllt",
                "Fix session opened, the prompt is pre-filled",
              ),
            }[action];
            return r.demo ? `Demo: ${done}` : done;
          },
          t("Ging nicht", "Did not work"),
        ),
      projectBrief: (id: string, target: string) =>
        run(
          () => post("/api/project-brief", { id, target }),
          (r) =>
            r.demo
              ? t(
                  `Demo: würde in ${label(target)} ein Projekt-Briefing öffnen`,
                  `Demo: would open a project briefing in ${label(target)}`,
                )
              : t(
                  `Projekt-Briefing in ${label(target)} – Auftrag ist vorausgefüllt`,
                  `Project briefing in ${label(target)}, the prompt is pre-filled`,
                ),
          t("Öffnen fehlgeschlagen", "Opening failed"),
        ),
    }),
    [
      label,
      run,
      setPref,
      sessionById,
      showToast,
      t,
      reload,
      openFleet,
      openDrawer,
      watchJob,
      locale,
      data?.billing,
      jump,
    ],
  );
}
