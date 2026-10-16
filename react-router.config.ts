import type { Config } from "@react-router/dev/config";

// SPA mode: the build is plain static files. React ships inside the bundle, so the running
// dashboard needs Node and nothing from node_modules (see scripts/bundle.ts for the server side).
export default {
  ssr: false,
} satisfies Config;
