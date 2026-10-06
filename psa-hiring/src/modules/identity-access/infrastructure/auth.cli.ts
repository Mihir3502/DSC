import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import * as authSchema from "./auth-schema";
import {
  AUTH_SCHEMA_NAME,
  staffTwoFactorPlugin,
  staticAuthOptions,
} from "./auth-options";

// Configuration used ONLY by the pinned Better Auth CLI (`pnpm
// auth:schema:check`). It shares the runtime's static options and the
// committed Drizzle schema, uses a mock Drizzle handle (no connection), and a
// fixed non-secret value because the CLI never signs anything. It is never
// imported by application code.

export const auth = betterAuth({
  ...staticAuthOptions,
  secret: "cli-schema-check-only-not-a-secret-0000000000",
  baseURL: "http://127.0.0.1:3000",
  database: drizzleAdapter(drizzle.mock({ schema: authSchema }), {
    provider: "pg",
    schemaName: AUTH_SCHEMA_NAME,
    schema: authSchema,
  }),
  plugins: [staffTwoFactorPlugin()],
});
