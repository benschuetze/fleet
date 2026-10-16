import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: { tsconfigPaths: true },
  // `pnpm dev` runs the Fleet API on its own port; the dev server forwards to it.
  server: { port: 5181, strictPort: true, proxy: { "/api": "http://127.0.0.1:4781" } },
});
