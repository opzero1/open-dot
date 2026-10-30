import { defineConfig } from "vite-plus";

// The renderer: React from app/, built into app/build/renderer for the app:// protocol. Every
// grammar, font and KaTeX asset is bundled; nothing is loaded from the network.
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  build: {
    outDir: "build/renderer",
    emptyOutDir: true,
    target: "chrome140",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
  },
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
});
