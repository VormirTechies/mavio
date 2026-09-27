import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "docs/m0/**",
      "testing/fixtures/**",
    ],
  },
  {
    files: ["packages/**/*.{ts,mts,cts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ["scripts/**/*.{js,mjs}", "**/tests/runtime/**/*.mjs", "*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["packages/**/tests/types/**/*.{ts,mts,cts}"],
    rules: {
      // Compile-only tests intentionally contain unused type assertions.
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
  prettier,
);
