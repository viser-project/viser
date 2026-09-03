import { defineConfig, searchForWorkspaceRoot, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";

import viteTsconfigPaths from "vite-tsconfig-paths";
import svgrPlugin from "vite-plugin-svgr";
import browserslistToEsbuild from "browserslist-to-esbuild";
import { viteSingleFile } from "vite-plugin-singlefile";
import { compressHtml } from "./vite-plugin-compress-html.mts";

// R3F's <Canvas> calls `extend(THREE)` with the entire three namespace,
// which retains every three export and defeats tree-shaking (~35 KB of the
// compressed build). viser registers the classes it actually renders in
// src/r3f-extend.ts instead, so production builds patch the call out. The
// dev server keeps the automatic catalogue (its prebundled deps skip this
// transform); src/threeCatalogue.test.ts pins the pattern below so a fiber
// upgrade that changes it fails loudly instead of silently regrowing the
// bundle.
function fiberNoAutoExtend(): Plugin {
  const pattern = "React.useMemo(() => extend(THREE), [])";
  return {
    name: "fiber-no-auto-extend",
    transform(code, id) {
      if (!id.includes("react-three-fiber") || !code.includes(pattern)) return;
      return code.replace(pattern, "React.useMemo(() => undefined, [])");
    },
  };
}

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
      ...(!isDev
        ? [fiberNoAutoExtend(), viteSingleFile(), compressHtml()]
        : []),
    ],
    server: {
      port: 3000,
      hmr: { port: 1025 },
      fs: {
        // The default env map is imported from the Python package's HDRI
        // preset directory (single copy in the repo), which sits outside the
        // client root; allow the dev server to serve it.
        allow: [
          searchForWorkspaceRoot(process.cwd()),
          fileURLToPath(new URL("../_assets", import.meta.url)),
        ],
      },
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
