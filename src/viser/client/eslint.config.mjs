// ESLint flat config for the viser client (ESLint 10).
// Same effective surface as the previous .eslintrc.js:
//   eslint:recommended + @typescript-eslint/recommended + the project's
//   rule tweaks, react-hooks/rules-of-hooks, react-refresh.
// eslint-plugin-react is incompatible with ESLint 10 (it relies on removed
// context.getFilename APIs); the react/* checks that still mattered are
// covered by TypeScript itself (undefined JSX identifiers, duplicate props)
// plus the minimal @eslint-react rule subset below (jsx-key equivalent).
import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintReact from "@eslint-react/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default defineConfig([
  globalIgnores(["build/", "src/vendor/"]),
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: {
      "@eslint-react":
        eslintReact.configs["recommended-typescript"].plugins["@eslint-react"],
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    rules: {
      "no-constant-condition": "off",
      // New in eslint:recommended as of v10; flags `let x = []` initializers
      // that every branch overwrites. Off to keep the previous rule surface
      // (2 hits in mesh/BatchedMeshBase.tsx if enabled).
      "no-useless-assignment": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // typescript-eslint 8 flags unused catch parameters by default
      // (caughtErrors: "all"); keep the v7 behavior.
      "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }],
      // typescript-eslint 8 recommended newly enables this; the codebase uses
      // `x !== null && x()` short-circuit calls, which v7 accepted.
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowShortCircuit: true, allowTernary: true },
      ],
      // jsx-key equivalent (eslint-plugin-react's most valuable check here).
      "@eslint-react/no-missing-key": "error",
      "@eslint-react/jsx-no-comment-textnodes": "warn",
      "react-refresh/only-export-components": "warn",
      // ``rules-of-hooks`` catches structural hook violations (conditional
      // calls, calls outside components) with near-zero false positives.
      // ``exhaustive-deps`` was tried and removed: this codebase's patterns
      // (Zustand selectors, mutable scene-tree refs, cleanup-only effects,
      // mount-only subscriptions, identity-stable per-node components)
      // produce a high false-positive rate, and the rule's "add this dep"
      // suggestions were wrong often enough to be a source of subtle
      // regressions rather than guidance.
      "react-hooks/rules-of-hooks": "error",
    },
  },
]);
