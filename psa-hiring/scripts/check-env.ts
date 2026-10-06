import { parseServerEnv, ServerEnvError } from "../src/config/env-schema";
import { parseAuthEnv } from "../src/modules/identity-access/infrastructure/auth-env";

// Validates the developer's environment with the same schemas the
// application uses (runtime + authentication). Prints only variable names
// and rules, never values.

try {
  const env = parseServerEnv(process.env);
  const auth = parseAuthEnv(process.env);
  console.log(
    `Configuration valid (APP_ENV=${env.APP_ENV}, PROVIDER_MODE=${env.PROVIDER_MODE}, auth origins=${auth.AUTH_TRUSTED_ORIGINS.length})`,
  );
} catch (error) {
  if (error instanceof ServerEnvError) {
    console.error(error.message);
    console.error(
      "Fix the variables above in .env.local (see .env.example for safe local values).",
    );
    process.exit(1);
  }
  throw error;
}
