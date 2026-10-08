import type { ConfigurationRefusal } from "../../domain/lifecycle";
import { Refusal, type CommandOutcome } from "../configuration-runtime";
import { InputProblems, type FieldProblems } from "../input";

// Closed configuration command results (packet M2.1 §15 step 9). Delivery
// maps these to form states, safe not-found, step-up, or redirects; they
// never carry stored values, other records, or internal error detail.

export type ConfigurationResult =
  CommandOutcome | Readonly<{ kind: "INVALID_INPUT"; fields: FieldProblems }>;

export type { ConfigurationRefusal };

/** Runs input validation and the command, folding early refusals in. */
export async function validated(
  run: () => Promise<CommandOutcome>,
): Promise<ConfigurationResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InputProblems) {
      return { kind: "INVALID_INPUT", fields: error.fields };
    }
    if (error instanceof Refusal) {
      return { kind: "REFUSED", reason: error.reason };
    }
    throw error;
  }
}
