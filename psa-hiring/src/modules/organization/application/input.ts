import { checkText, normalizeCode, type TextRule } from "../domain/values";
import { refuse } from "./configuration-runtime";

// Exact command input parsing (packet M2.1 §15 step 2, §23). Commands
// receive raw strings from the delivery boundary; every value is
// re-validated here, and any problem refuses the whole command before a
// transaction starts. Field problems are reported as closed codes keyed
// by input name, never echoed values.

export type FieldProblems = Record<string, string>;

export class InputProblems extends Error {
  constructor(readonly fields: FieldProblems) {
    super("invalid input");
  }
}

export class FieldCollector {
  readonly problems: FieldProblems = {};

  text(name: string, value: unknown, rule: TextRule): string | null {
    const result = checkText(value, rule);
    if (!result.ok) {
      this.problems[name] = result.problem;
      return null;
    }
    return result.value;
  }

  code(name: string, value: unknown): string {
    const code = normalizeCode(value);
    if (!code) this.problems[name] = "INVALID_CODE";
    return code ?? "";
  }

  add(name: string, problem: string) {
    this.problems[name] = problem;
  }

  /** Throws when any field failed. */
  finish(): void {
    if (Object.keys(this.problems).length > 0) {
      throw new InputProblems({ ...this.problems });
    }
  }
}

/** A positive optimistic version submitted with the form. */
export function expectedVersion(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,8}$/.test(value)) {
    return refuse("INVALID_INPUT");
  }
  return Number(value);
}
