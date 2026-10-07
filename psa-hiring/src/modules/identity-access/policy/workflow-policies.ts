import type { WorkflowPolicyCode } from "../domain/authorization-vocabulary";

// Closed workflow-policy registry (packet M1.4 §12). A permission may name
// a workflow policy; the owning domain (M2+) registers an evaluator with
// its closed state vocabulary. Until then the production registry is
// empty, so every workflow-gated permission denies POLICY_UNAVAILABLE.
// Policies are code, never executable data.

export interface WorkflowPolicy {
  readonly code: WorkflowPolicyCode;
  /** Every state value the owning domain may supply. */
  readonly states: readonly string[];
  /** May `permissionCode` run in `state` (optionally for `transition`)? */
  permits(
    permissionCode: string,
    state: string,
    transition: string | undefined,
  ): boolean;
}

export type WorkflowPolicyRegistry = ReadonlyMap<
  WorkflowPolicyCode,
  WorkflowPolicy
>;

/** No workflow policy is registered before the owning domains exist. */
export const productionWorkflowPolicies: WorkflowPolicyRegistry = new Map();
