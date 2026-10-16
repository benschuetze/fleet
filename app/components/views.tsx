import { type ReactNode, useId } from "react";
import { Safe } from "./safe";

/** A named section of a page: screen readers can jump to it by its heading, the counters in the header too. */
export function Section({
  id,
  title,
  count,
  aside,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const h = useId();
  return (
    <section className="sect" id={id} aria-labelledby={h}>
      <div className="sect-h">
        <h2 id={h} tabIndex={-1}>
          {title}
        </h2>
        {count !== undefined && <span className="c">{count}</span>}
        {aside}
      </div>
      <Safe>{children}</Safe>
    </section>
  );
}

/** A card with a heading, used on the usage and activity pages. */
export function Card({
  title,
  aside,
  children,
  className = "",
  id,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Anchor for links from elsewhere (header, alarm zone). */
  id?: string;
}) {
  const h = useId();
  return (
    <section className={`card ${className}`} aria-labelledby={h} id={id}>
      <div className="card-h">
        <h2 id={h}>{title}</h2>
        {aside}
      </div>
      <Safe>{children}</Safe>
    </section>
  );
}
