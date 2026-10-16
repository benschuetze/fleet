import type { Block, Inline } from "~/lib/markdown";
import { ExtLink } from "../tag";

/** Architecture notes as text elements only; headings start below the drawer's own h2. */
export function Markdown({ blocks }: { blocks: Block[] }) {
  return (
    <div className="md">
      {blocks.map((b, i) => {
        // Blocks have no id; the position in the file is their identity.
        const k = i;
        if (b.t === "h") {
          const H = (["h3", "h4", "h5"] as const)[b.level - 1] || "h5";
          return (
            <H key={k}>
              <Text v={b.v} />
            </H>
          );
        }
        if (b.t === "pre")
          return (
            <pre key={k} className="mono">
              {b.v}
            </pre>
          );
        if (b.t === "p")
          return (
            <p key={k}>
              <Text v={b.v} />
            </p>
          );
        const L = b.t;
        return (
          <L key={k}>
            {b.items.map((it, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: list items have no id either
              <li key={j}>
                <Text v={it} />
              </li>
            ))}
          </L>
        );
      })}
    </div>
  );
}

function Text({ v }: { v: Inline[] }) {
  return (
    <>
      {v.map((x, i) => {
        // Inline parts have no id; the position is their identity.
        const k = i;
        if (x.t === "code")
          return (
            <code key={k} className="mono">
              {x.v}
            </code>
          );
        if (x.t === "bold") return <strong key={k}>{x.v}</strong>;
        if (x.t === "link")
          return (
            <ExtLink key={k} href={x.href} className="link">
              {x.v}
            </ExtLink>
          );
        return <span key={k}>{x.v}</span>;
      })}
    </>
  );
}
