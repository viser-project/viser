import { defineConfig } from "vitest/config";

// Unit tests for pure client-side logic. Kept separate from the app's
// production vite config (vite.config.mts) so the singlefile/compress plugins
// don't run during tests. Runs in a Node environment -- the targeted modules
// are DOM-free pure functions.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
