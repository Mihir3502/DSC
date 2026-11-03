import "server-only";
import { getServerEnv } from "@/config/server-env";

// Candidate-facing contact details from validated server configuration. Unset
// values stay null, so the portal shows no contact details instead of inventing
// them.

export type HelpConfig = Readonly<{
  agencyName: string | null;
  email: string | null;
  phone: string | null;
}>;

export function candidateHelpConfig(): HelpConfig {
  const env = getServerEnv();
  return {
    agencyName: env.AGENCY_DISPLAY_NAME ?? null,
    email: env.CANDIDATE_HELP_EMAIL ?? null,
    phone: env.CANDIDATE_HELP_PHONE ?? null,
  };
}
