import type { ArchDoc } from "../../shared/types";

/**
 * Just enough Markdown for a repo's architecture notes: headings, paragraphs, lists, code blocks, inline code,
 * bold and links. The result is data that React renders as text, so HTML in the file stays text and a script
 * never runs. Links only to http(s); anything else is shown as its text.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "bold"; v: string }
  | { t: "link"; v: string; href: string };

export type Block =
  | { t: "h"; level: 1 | 2 | 3; v: Inline[] }
  | { t: "p"; v: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][] }
  | { t: "pre"; v: string };

const MAX_BLOCKS = 2000;

export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) out.push({ t: "text", v: s.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "bold", v: m[2] });
    else if (m[3] !== undefined) {
      const href = String(m[4]);
      out.push(/^https?:\/\//i.test(href) ? { t: "link", v: m[3], href } : { t: "text", v: m[3] });
    }
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ t: "text", v: s.slice(at) });
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = String(src || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  let list: { t: "ul" | "ol"; items: Inline[][] } | null = null;
  const flush = () => {
    if (para.length) out.push({ t: "p", v: inline(para.join(" ")) });
    if (list) out.push(list);
    para = [];
    list = null;
  };
  for (let i = 0; i < lines.length && out.length < MAX_BLOCKS; i++) {
    const line = lines[i] as string;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i] as string); i++) code.push(lines[i] as string);
      out.push({ t: "pre", v: code.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      out.push({ t: "h", level: Math.min(3, String(h[1]).length) as 1 | 2 | 3, v: inline(String(h[2])) });
      continue;
    }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      const kind = li[1] ? "ul" : "ol";
      if (para.length || (list && list.t !== kind)) flush();
      if (!list) list = { t: kind, items: [] };
      list.items.push(inline(String(li[3])));
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return out;
}

/** The answer of /api/architecture, checked field by field like every server answer in the browser. */
export function parseArch(raw: unknown): ArchDoc | { error: string } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (typeof o.error === "string") return { error: o.error.slice(0, 300) };
  return {
    file: typeof o.file === "string" ? o.file.slice(0, 300) : null,
    text: typeof o.text === "string" ? o.text.slice(0, 64 * 1024) : null,
    truncated: o.truncated === true,
    mappe: o.mappe === true,
  };
}

export async function fetchArch(root: string): Promise<ArchDoc | { error: string }> {
  const res = await fetch(`/api/architecture?root=${encodeURIComponent(root)}`);
  return parseArch(await res.json().catch(() => ({ error: `HTTP ${res.status}` })));
}
