import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

import viteTsconfigPaths from "vite-tsconfig-paths";
import svgrPlugin from "vite-plugin-svgr";
import browserslistToEsbuild from "browserslist-to-esbuild";
import { viteSingleFile } from "vite-plugin-singlefile";
import { compressHtml } from "./vite-plugin-compress-html.mts";

// Unified Vite config for both development and production builds.
// - Development: Standard HMR server without single-file bundling.
// - Production: Self-contained single HTML file with all assets inlined.
// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  const isDev = command === "serve";

  return {
    plugins: [
      react(),
      viteTsconfigPaths(),
      svgrPlugin(),
      vanillaExtractPlugin(),
      // Single-file bundling and compression only for production builds.
      ...(!isDev ? [viteSingleFile(), compressHtml()] : []),
    ],
    server: {
      port: 3000,
      hmr: { port: 1025 },
    },
    build: {
      outDir: "build",
      target: browserslistToEsbuild(),
      // Inline all assets including fonts and images for single-file output.
      assetsInlineLimit: 100000000,
      // Disable code splitting to ensure single file output.
      rollupOptions: {
        output: {
          codeSplitting: false,
        },
      },
    },
    worker: {
      format: "es",
      // Workers need react plugin for JSX in production.
      ...(!isDev && { plugins: () => [react()] }),
      rollupOptions: {
        output: {
          codeSplitting: false,
        },
      },
    },
    // Exclude libultrahdr WASM from optimization (required for @monogrid/gainmap-js).
    optimizeDeps: {
      exclude: ["@monogrid/gainmap-js/libultrahdr"],
    },
  };
});
