import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { Route } from "./+types/root";
import "./app.css";
// After app.css: the other views and the drawer, then the one screen; later sheets win in the same layer.
import "./views.css";
import "./drawer.css";
import "./keys.css";
import "./log.css";
import "./diff.css";
// Last: the one-screen grid (stage 12) overrides the page layout of the sheets before it.
import "./screen.css";
import "./rows.css";
import "./side.css";

// Sets the theme before the first paint, so a dark dashboard never flashes white. The server allows exactly this
// inline script by its hash (server/http/static.ts, computed from the built index.html).
const THEME = `try{var t=JSON.parse(localStorage.getItem("fleet.theme"));if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export const meta: Route.MetaFunction = () => [{ title: "Claude Fleet" }];

export const links: Route.LinksFunction = () => [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed string, allowed by its CSP hash */}
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/** Shown while the static shell loads in SPA mode. */
export function HydrateFallback() {
  return <div className="empty">Claude Fleet …</div>;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const text = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Error";
  return (
    <main className="wrap">
      <h1 className="pagehead">Claude Fleet</h1>
      <p role="alert" className="warn">
        {text}
      </p>
      <a className="link" href="/">
        Dashboard
      </a>
    </main>
  );
}
