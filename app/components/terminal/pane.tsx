import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { hit } from "~/lib/keymap";
import { exitCode, fromBase64, sendInput, sendKill, sendResize, streamUrl } from "~/lib/terminal";
import type { ProcStatus } from "../../../shared/types";
import { monoFont, xtermTheme } from "./theme";

type Conn = "connecting" | "running" | "ended" | "lost" | "gone";

/**
 * One Claude session in xterm.js: the output from the server's buffer and then live, keystrokes back in batches
 * of 8 ms, the size follows the drawer. The DOM renderer keeps the text readable for screen readers and tests.
 * Escape belongs to Claude while the terminal has the focus; Ctrl+← leaves it (spec, keyboard map).
 */
export function TerminalPane({
  id,
  status,
  exit = null,
  onLeave,
  onExit,
  onResume,
  focusRef,
  autoFocus = false,
}: {
  id: string;
  /** The process status from the overview (interrupted, exited …), when Fleet knows it. */
  status: ProcStatus | null;
  /** The exit code the overview knows for an ended process. */
  exit?: number | null;
  onLeave: () => void;
  /** Esc: out of the terminal back to the overview; the session runs on. */
  onExit: () => void;
  onResume: (() => void) | null;
  focusRef: { current: (() => void) | null };
  /** Take the keys at once: the user jumped in to type (release 6, plan R8). */
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const [code, setCode] = useState<number | null>(null);
  const [armed, setArmed] = useState(false);
  const leave = useRef(onLeave);
  leave.current = onLeave;
  const { showToast } = useFleet();
  const noteRef = useRef(() =>
    showToast(
      t(
        "Im Terminal führt Esc zurück zur Übersicht – Claudes Esc ist Ctrl+[",
        "In the terminal Esc leads back to the overview; Claude's Esc is Ctrl+[",
      ),
    ),
  );
  const focusNow = useRef(autoFocus);
  focusNow.current = autoFocus;
  const quit = useRef(onExit);
  quit.current = onExit;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const term = new Terminal({
      rows: 24,
      fontFamily: monoFont(),
      fontSize: 12.5,
      cursorBlink: !reduced,
      screenReaderMode: true,
      scrollback: 5000,
      theme: xtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const refit = () => {
      try {
        fit.fit();
      } catch {
        // not laid out yet
      }
    };
    refit();
    focusRef.current = () => term.focus();
    if (focusNow.current) term.focus();
    // Once per browser: Claude's own screen says "esc to interrupt", but here Esc leads back (release 6).
    try {
      if (!localStorage.getItem("fleet.termEscNote")) {
        localStorage.setItem("fleet.termEscNote", "1");
        noteRef.current();
      }
    } catch {
      // no storage: the footer says it too
    }
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && hit(e, "termBack")) {
        leave.current();
        return false;
      }
      // Esc belongs to Fleet (back to the overview); Ctrl+[ still reaches Claude as Esc, xterm sends it by itself.
      if (hit(e, "termExit")) {
        if (e.type === "keydown") quit.current();
        return false;
      }
      return true;
    });

    let pending = "";
    let inputTimer: ReturnType<typeof setTimeout> | undefined;
    const typed = term.onData((d) => {
      pending += d;
      inputTimer ??= setTimeout(() => {
        const out = pending;
        pending = "";
        inputTimer = undefined;
        sendInput(id, out).catch(() => setConn("gone"));
      }, 8);
    });

    let sizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resized = new ResizeObserver(() => {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(() => {
        refit();
        sendResize(id, term.cols, term.rows).catch(() => {});
      }, 150);
    });
    resized.observe(el);

    // Theme switch while the terminal is open: new colours, same content.
    const retheme = () => {
      term.options.theme = xtermTheme();
    };
    const themeWatch = new MutationObserver(retheme);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", retheme);

    // Every (re)connect replays the whole buffer, so the screen starts over each time.
    const es = new EventSource(streamUrl(id));
    let fresh = true;
    es.onopen = () => {
      fresh = true;
    };
    es.addEventListener("out", (ev) => {
      if (fresh) {
        term.reset();
        fresh = false;
      }
      const b = fromBase64((ev as MessageEvent).data);
      if (b) term.write(b);
      setConn("running");
    });
    es.addEventListener("exit", (ev) => {
      setCode(exitCode((ev as MessageEvent).data));
      setConn("ended");
      es.close();
    });
    es.onerror = () => setConn(es.readyState === EventSource.CLOSED ? "gone" : "lost");

    return () => {
      es.close();
      typed.dispose();
      resized.disconnect();
      themeWatch.disconnect();
      mq.removeEventListener("change", retheme);
      clearTimeout(inputTimer);
      clearTimeout(sizeTimer);
      focusRef.current = null;
      term.dispose();
    };
  }, [id, focusRef]);

  // The overview knows an ended process too (B15): its exit event can be lost (a reconnect, a stream the browser
  // holds back), and the line must not say "running" for a process that is gone.
  const over = conn !== "ended" && (status === "exited" || status === "failed");
  const ended = conn === "ended" || conn === "gone" || over;
  const state =
    status === "interrupted"
      ? t("unterbrochen – Fortsetzen", "interrupted: continue")
      : over
        ? t(`beendet (Code ${exit ?? "?"})`, `ended (code ${exit ?? "?"})`)
        : conn === "lost"
          ? t("Verbindung weg, verbinde neu …", "Connection lost, reconnecting …")
          : conn === "connecting"
            ? t("verbinde …", "connecting …")
            : conn === "gone"
              ? t("kein laufender Prozess", "no running process")
              : conn === "ended"
                ? t(`beendet (Code ${code ?? "?"})`, `ended (code ${code ?? "?"})`)
                : // The process, not the session's state: that stands in the drawer's head ("wartet", round 6).
                  t("Prozess läuft", "process running");

  return (
    <div className="term">
      <div className="term-box" ref={box} />
      <div className="term-foot">
        <span className="term-state" role="status">
          {state}
        </span>
        <span className="m-hide">
          {t(
            "Esc zurück zur Übersicht · Ctrl+[ schickt Esc an Claude · Ctrl+← zur Liste",
            "Esc back to the overview · Ctrl+[ sends Esc to Claude · Ctrl+← to the list",
          )}
        </span>
        {!ended && status !== "interrupted" ? (
          <>
            {/* Named like the status line's key ("abbrechen"): read beside "Beenden" it looked like Ctrl+C ends. */}
            <button type="button" className="act-link" onClick={() => sendInput(id, "\x03").catch(() => {})}>
              Ctrl+C {t("abbrechen", "interrupt")}
            </button>{" "}
            ·
            <button
              type="button"
              className={`act-link ${armed ? "danger" : ""}`}
              onClick={() => {
                if (!armed) return setArmed(true);
                setArmed(false);
                sendKill(id, "term").catch(() => {});
              }}
              onBlur={() => setArmed(false)}
            >
              {armed ? t("Wirklich beenden?", "Really end it?") : t("Beenden", "End")}
            </button>
          </>
        ) : (
          onResume && (
            <button type="button" className="act-link" onClick={onResume}>
              {t("Fortsetzen", "Continue")}
            </button>
          )
        )}
      </div>
    </div>
  );
}
