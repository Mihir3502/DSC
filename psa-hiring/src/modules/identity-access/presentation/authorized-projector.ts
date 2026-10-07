import type { z } from "zod";
import {
  evaluateFieldRule,
  findNeverReturnKeys,
  isValidFieldRule,
  neverReturnKeys,
  type FieldOutcome,
  type FieldPolicyContext,
  type FieldRule,
  type ProjectionAudience,
  type ProjectionPurpose,
} from "./field-policy";

// Explicit, purpose- and audience-specific response projection (packet
// M1.5 §12.2, ADR-0011). Pure.
//
// - A contract maps the output field by field from a typed source. There
//   is no spread, no "copy the rest", and no client-selected field list:
//   a source property the contract does not name can never reach output.
// - Each field's rule is evaluated against server-owned context; MASK and
//   STATUS_ONLY use server-defined functions, OMIT drops the key, and
//   DENY_RESOURCE refuses the whole representation.
// - The final object must pass the contract's exact (strict) schema and
//   carry no never-return key at any depth, otherwise the projection is
//   refused (fail closed). Callers treat a refusal as a safe denial or a
//   system error, never as a partially redacted success.

export type FieldSpec<S, V> = Readonly<{
  rule: FieldRule;
  /** The approved full value (INCLUDE). */
  value?: (source: S) => V;
  /** Server-generated, nonreversible masked representation (MASK). */
  mask?: (source: S) => V;
  /** Approved state/summary only, never the underlying value. */
  status?: (source: S) => V;
}>;

export type ProjectionContract<S, O extends object> = Readonly<{
  /** Stable reviewed name, referenced by the route manifest. */
  name: string;
  audience: ProjectionAudience;
  purpose: ProjectionPurpose;
  fields: { readonly [K in keyof O]-?: FieldSpec<S, O[K]> };
  /** Exact schema: unknown keys are rejected (z.strictObject). */
  schema: z.ZodType<O>;
}>;

export type ProjectionRefusal =
  | "AUDIENCE_MISMATCH"
  | "PURPOSE_MISMATCH"
  | "FIELD_DENIED"
  | "CONTRACT_INVALID"
  | "NEVER_RETURN_FIELD"
  | "SCHEMA_MISMATCH";

export type ProjectionResult<O> =
  | Readonly<{ kind: "PROJECTED"; value: O }>
  | Readonly<{ kind: "REFUSED"; reason: ProjectionRefusal }>;

const neverReturn = new Set(neverReturnKeys.map((k) => k.toLowerCase()));

/**
 * Validates a contract once, at definition. A contract that names a
 * never-return field, uses an invalid rule, or lacks the function for an
 * outcome its rule can produce is a programming error.
 */
export function defineProjection<S, O extends object>(
  contract: ProjectionContract<S, O>,
): ProjectionContract<S, O> {
  for (const [key, raw] of Object.entries(contract.fields)) {
    const spec = raw as FieldSpec<S, unknown>;
    if (neverReturn.has(key.toLowerCase())) {
      throw new Error(`projection ${contract.name}: never-return field`);
    }
    if (!isValidFieldRule(spec.rule)) {
      throw new Error(`projection ${contract.name}: invalid rule`);
    }
    const reachable = new Set<FieldOutcome>([spec.rule.otherwise]);
    if (spec.rule.includeWith) reachable.add("INCLUDE");
    if (spec.rule.maskWith) reachable.add("MASK");
    if (spec.rule.statusWith) reachable.add("STATUS_ONLY");
    if (
      (reachable.has("INCLUDE") && !spec.value) ||
      (reachable.has("MASK") && !spec.mask) ||
      (reachable.has("STATUS_ONLY") && !spec.status)
    ) {
      throw new Error(`projection ${contract.name}: missing field function`);
    }
  }
  return Object.freeze({
    ...contract,
    fields: Object.freeze({ ...contract.fields }),
  });
}

export function project<S, O extends object>(
  contract: ProjectionContract<S, O>,
  source: S,
  context: FieldPolicyContext,
): ProjectionResult<O> {
  const refuse = (reason: ProjectionRefusal): ProjectionResult<O> =>
    Object.freeze({ kind: "REFUSED", reason });
  if (context.audience !== contract.audience) {
    return refuse("AUDIENCE_MISMATCH");
  }
  if (context.purpose !== contract.purpose) return refuse("PURPOSE_MISMATCH");

  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(contract.fields)) {
    const spec = raw as FieldSpec<S, unknown>;
    const outcome = evaluateFieldRule(spec.rule, context);
    switch (outcome) {
      case "INCLUDE":
        if (!spec.value) return refuse("CONTRACT_INVALID");
        output[key] = spec.value(source);
        break;
      case "MASK":
        if (!spec.mask) return refuse("CONTRACT_INVALID");
        output[key] = spec.mask(source);
        break;
      case "STATUS_ONLY":
        if (!spec.status) return refuse("CONTRACT_INVALID");
        output[key] = spec.status(source);
        break;
      case "OMIT":
        break;
      case "DENY_RESOURCE":
        return refuse("FIELD_DENIED");
    }
  }

  if (findNeverReturnKeys(output).length > 0) {
    return refuse("NEVER_RETURN_FIELD");
  }
  const parsed = contract.schema.safeParse(output);
  if (!parsed.success) return refuse("SCHEMA_MISMATCH");
  return Object.freeze({ kind: "PROJECTED", value: parsed.data });
}

/** Projects each row of a list with the same contract and context. */
export function projectAll<S, O extends object>(
  contract: ProjectionContract<S, O>,
  sources: readonly S[],
  context: FieldPolicyContext,
): ProjectionResult<O[]> {
  const values: O[] = [];
  for (const source of sources) {
    const result = project(contract, source, context);
    if (result.kind === "REFUSED") return result;
    values.push(result.value);
  }
  return Object.freeze({ kind: "PROJECTED", value: values });
}
