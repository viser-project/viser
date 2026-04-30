module.exports = {
  settings: {
    react: {
      version: "detect", // React version. "detect" automatically picks the version you have installed.
      // You can also use `16.0`, `16.3`, etc, if you want to override the detected value.
      // It will default to "latest" and warn if missing, and to "detect" in the future
    },
  },
  env: {
    browser: true,
    es2021: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:react/recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  overrides: [],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: ["react", "react-hooks", "@typescript-eslint", "react-refresh"],
  ignorePatterns: ["build/", ".eslintrc.js", "src/csm", "src/vendor"],
  rules: {
    // https://github.com/jsx-eslint/eslint-plugin-react/issues/3423
    "react/no-unknown-property": "off",
    "no-constant-condition": "off",
    // Suppress errors for missing 'import React' in files.
    "react/react-in-jsx-scope": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "react/prop-types": [
      "error",
      {
        skipUndeclared: true,
      },
    ],
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
};
