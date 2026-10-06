import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Module-boundary and sensitive-logging rules (ARCHITECTURE.md §5, §12, §15;
// docs/OPERATIONS.md). Enforced by `pnpm lint` locally and in CI.

const serverOnlyModules = [
  {
    group: [
      "@/shared/database",
      "@/shared/database/*",
      "pg",
      "drizzle-orm",
      "drizzle-orm/*",
    ],
    message:
      "UI code must not access the database; call an application use case on the server.",
  },
  {
    // Everything under @/shared/logging except the pure correlation module.
    regex: "^(?:@/shared/logging(?:/(?!correlation$).*)?|pino)$",
    message:
      "UI code must not import the server logger; only @/shared/logging/correlation is client-safe.",
  },
  {
    group: ["@/shared/http", "@/shared/http/*"],
    message: "HTTP delivery adapters are server-only.",
  },
  {
    group: ["@/config/server-env", "@/config/env-schema"],
    message: "Server configuration must never reach UI code.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Operational output goes through the allowlisted logger, never console.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}"],
    rules: { "no-console": "error" },
  },
  {
    // Pages, layouts, boundaries, and components (excluding tests).
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: serverOnlyModules }],
    },
  },
  {
    // Shared error primitives stay framework-neutral.
    files: ["src/shared/errors/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "next",
                "next/*",
                "react",
                "react/*",
                "pino",
                "drizzle-orm",
                "drizzle-orm/*",
                "pg",
                "@/*",
              ],
              message:
                "Shared errors must not import framework, logger, ORM, or application modules.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated test artifacts.
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
