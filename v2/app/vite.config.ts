import { fileURLToPath } from "url";
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const browserMode = process.env.VITE_BROWSER_MODE === "true";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: browserMode
    ? {
        alias: {
          "@tauri-apps/api/core": path.resolve(
            __dirname,
            "src/shims/tauri-core.ts",
          ),
          "@tauri-apps/plugin-opener": path.resolve(
            __dirname,
            "src/shims/tauri-opener.ts",
          ),
          "@tauri-apps/plugin-notification": path.resolve(
            __dirname,
            "src/shims/tauri-notification.ts",
          ),
        },
      }
    : {},

  build: {
    rollupOptions: {
      output: {
        // Split Tiptap + ProseMirror into a dedicated chunk. They're
        // heavy (~700KB pre-gzip) and only used by the editor + the
        // read-only MarkdownView in PersonProfile. Pulling them out
        // of the main bundle keeps cold-start to Home/Tasks snappy
        // even though the Tiptap chunk still loads when needed.
        manualChunks(id: string) {
          if (id.includes("node_modules")) {
            if (
              id.includes("@tiptap/") ||
              id.includes("prosemirror-") ||
              id.includes("tiptap-markdown") ||
              id.includes("orderedmap") ||
              id.includes("rope-sequence") ||
              id.includes("w3c-keyname")
            ) {
              return "tiptap";
            }
          }
          return undefined;
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: browserMode ? 1422 : 1420,
    strictPort: !browserMode,
    host: host || browserMode || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // Proxy bridge API calls through the Vite server so the iPad only needs
    // to reach port 1422. Vite forwards /invoke and /health to the axum
    // server on loopback, bypassing the LAN firewall on port 1423.
    proxy: browserMode ? {
      "/invoke": "http://127.0.0.1:1423",
      "/health": "http://127.0.0.1:1423",
    } : {},
  },
}));
