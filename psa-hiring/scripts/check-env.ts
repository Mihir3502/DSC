import { parseServerEnv, ServerEnvError } from "../src/config/env-schema";

// Validates the developer's environment with the same schema the application
// uses. Prints only variable names and rules, never values.

try {
  const env = parseServerEnv(process.env);
  console.log(
    `Configuration valid (APP_ENV=${env.APP_ENV}, PROVIDER_MODE=${env.PROVIDER_MODE})`,
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
