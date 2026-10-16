import type { ReactNode } from "react";
import { safeUrl } from "~/lib/format";
import type { Tone } from "~/lib/session";

/** A pixel-type label; a link when it has a safe URL. */
export function Tag({
  children,
  tone = "",
  title,
  mono = false,
  href,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
  mono?: boolean;
  href?: string | null;
}) {
  const cls = `tag ${tone} ${mono ? "mono" : ""}`;
  const url = href ? safeUrl(href) : null;
  return url ? (
    <a className={cls} href={url} target="_blank" rel="noopener noreferrer" title={title}>
      {children}
    </a>
  ) : (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

/** An external link that only renders as a link for http(s) URLs. */
export function ExtLink({
  href,
  className,
  title,
  children,
}: {
  href: string | null | undefined;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const url = safeUrl(href);
  return url ? (
    <a className={className} href={url} target="_blank" rel="noopener noreferrer" title={title}>
      {children}
    </a>
  ) : (
    <span className={className} title={title}>
      {children}
    </span>
  );
}
