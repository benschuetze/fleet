import { useEffect, useRef, useState } from "react";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";
import { useKeys } from "~/lib/keyboard";
import { hit } from "~/lib/keymap";
import { sendInput } from "~/lib/terminal";
import type { Session } from "../../../shared/types";

/**
 * `r`: a one-line answer right under the session (spec, "Inline antworten"). Enter sends it to the session's
 * terminal in Fleet, Escape drops it; the selection goes back to the row either way.
 */
export function ReplyLine({ s }: { s: Session }) {
  const { t } = useI18n();
  const { showToast } = useFleet();
  const { setReplying } = useKeys();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const title = String(s.title || s.project || "");
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await sendInput(s.id, `${text}\r`);
      showToast(t(`Antwort an ${title} gesendet`, `Reply sent to ${title}`));
      setReplying(null);
    } catch (e) {
      showToast(`${t("Senden fehlgeschlagen", "Sending failed")}: ${e instanceof Error ? e.message : e}`);
      setBusy(false);
    }
  };
  return (
    <div className="reply-line">
      <span className="hint" aria-hidden="true">
        ↳
      </span>
      <input
        ref={input}
        type="text"
        maxLength={4000}
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        aria-label={t(`Antwort an ${title}`, `Reply to ${title}`)}
        placeholder={t("Antwort – Enter sendet, Esc verwirft", "Reply: Enter sends, Esc drops it")}
        autoComplete="off"
        onKeyDown={(e) => {
          if (hit(e.nativeEvent, "run", "standard", "input")) send();
          else if (hit(e.nativeEvent, "close")) setReplying(null);
          else return;
          e.preventDefault();
        }}
      />
    </div>
  );
}
