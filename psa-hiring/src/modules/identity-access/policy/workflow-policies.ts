import type { WorkflowPolicyCode } from "../domain/authorization-vocabulary";

// Closed workflow-policy registry (packet M1.4 §12). A permission may name
// a workflow policy; the owning domain (M2+) registers an evaluator with
// its closed state vocabulary. A permission no policy names, or one its
// policy doesn't list, denies. Policies are code, never executable data.

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

/** What each candidacy state permits. Later work items add their own. */
const candidacyPermissions: Readonly<Record<string, readonly string[]>> = {
  // M2.4: editing a draft. application.assist still has no role grant.
  APPLICATION_INCOMPLETE: ["application.own.edit", "application.assist"],
};

export const candidacyWorkflowPolicy: WorkflowPolicy = Object.freeze({
  code: "CANDIDACY_WORKFLOW",
  states: Object.freeze(["PROSPECT", "APPLICATION_INCOMPLETE", "CLOSED"]),
  permits: (permissionCode: string, state: string) =>
    candidacyPermissions[state]?.includes(permissionCode) === true,
});

/** Only domains that exist register a policy; everything else denies. */
export const productionWorkflowPolicies: WorkflowPolicyRegistry = new Map([
  ["CANDIDACY_WORKFLOW", candidacyWorkflowPolicy],
]);
