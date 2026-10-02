import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      ".output",
      ".vinxi",
      "public/wordle/vendor",
      "public/wordle/data",
      "android",
      "ios",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // The game itself: plain browser scripts in public/wordle (no build step).
    files: ["public/wordle/js/**/*.js", "public/wordle/sw.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        module: "readonly",
        Peer: "readonly",
        VALID_WORDS: "readonly",
        ANSWER_WORDS: "readonly",
        Rules: "readonly",
        Store: "readonly",
        Stats: "readonly",
        UI: "readonly",
        Keyboard: "readonly",
        Game: "readonly",
        LAN: "readonly",
        LocalNet: "readonly",
        FX: "readonly",
        LanUI: "readonly",
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { caughtErrors: "none" }],
      "no-control-regex": "off",
    },
  },
  eslintPluginPrettier,
);
