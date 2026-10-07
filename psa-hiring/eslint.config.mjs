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
    // Pages, layouts, boundaries, and components (excluding tests and route
    // handlers, which are server-side HTTP adapters).
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/app/api/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // M1.5 (ADR-0011): redirects go only to registered destinations
          // through identity-access/delivery/route-authorization.
          paths: [
            {
              name: "next/navigation",
              importNames: ["redirect", "permanentRedirect"],
              message:
                "Use safeRedirect() from identity-access delivery; it only allows registered destinations.",
            },
          ],
          patterns: [
            ...serverOnlyModules,
            {
              group: [
                "@/modules/*/infrastructure",
                "@/modules/*/infrastructure/*",
              ],
              message:
                "UI code must use a module's public index, never its infrastructure.",
            },
          ],
        },
      ],
    },
  },
  {
    // Module domain layers (and the pure authorization policy catalog)
    // stay framework-neutral (ARCHITECTURE §5.1, ADR-0005).
    files: ["src/modules/*/domain/**/*.ts", "src/modules/*/policy/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "better-auth",
                "better-auth/*",
                "next",
                "next/*",
                "react",
                "react/*",
                "drizzle-orm",
                "drizzle-orm/*",
                "pg",
                "pino",
                "@/shared/database",
                "@/shared/database/*",
                "@/shared/http",
                "@/shared/http/*",
                "../infrastructure/*",
                "../application/*",
              ],
              message:
                "Domain code must not import frameworks, persistence, HTTP, or outer layers.",
            },
          ],
        },
      ],
    },
  },
  {
    // M1.5 field policy and projections stay framework-neutral and never
    // reach persistence or the auth library (ADR-0011).
    files: ["src/modules/*/presentation/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "better-auth",
                "better-auth/*",
                "next",
                "next/*",
                "react",
                "react/*",
                "drizzle-orm",
                "drizzle-orm/*",
                "pg",
                "pino",
                "@/shared/database",
                "@/shared/database/*",
                "../infrastructure/*",
                "../application/*",
                "../delivery/*",
              ],
              message:
                "Projections are pure: no framework, persistence, auth library, or outer layer.",
            },
          ],
        },
      ],
    },
  },
  {
    // M1.5 delivery adapters translate outcomes; they never query storage
    // or call the auth library directly (ADR-0011).
    files: ["src/modules/*/delivery/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "better-auth",
                "better-auth/*",
                "drizzle-orm",
                "drizzle-orm/*",
                "pg",
                "@/shared/database",
                "@/shared/database/*",
                "../infrastructure/*",
              ],
              message:
                "Delivery adapters call application services, never persistence or the auth library.",
            },
          ],
        },
      ],
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
