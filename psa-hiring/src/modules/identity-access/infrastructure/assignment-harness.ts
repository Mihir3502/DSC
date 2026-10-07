// Bootstrap gate for role-assignment commands (packet M1.4 §9.3, §13.3,
// ADR-0005). The very first assignments in a test database need an actor
// before any account holds role_assignment.* permissions.
//
// - RefusingAssignmentHarness is the runtime default everywhere, including
//   the running web application: a BOOTSTRAP actor is never accepted.
// - NonproductionAssignmentHarness exists for deterministic integration
//   tests only. Its constructor throws unless APP_ENV is exactly "test", so
//   it cannot run locally against shared data, in staging, or in
//   production, and it can never act as a production approver.
//
// Even with the harness, every invariant except actor authorization still
// applies: distinct real creator/approver accounts, reason codes, scope
// resolution, overlap rejection, and database constraints.

export interface AssignmentHarnessGate {
  readonly mode: "refuse" | "test-harness";
  allowsBootstrap(): boolean;
}

export class RefusingAssignmentHarness implements AssignmentHarnessGate {
  readonly mode = "refuse" as const;
  allowsBootstrap(): boolean {
    return false;
  }
}

export class NonproductionAssignmentHarness implements AssignmentHarnessGate {
  readonly mode = "test-harness" as const;

  constructor(appEnv: string | undefined) {
    if (appEnv !== "test") {
      throw new Error(
        "the role-assignment test harness is available only when APP_ENV is test",
      );
    }
  }

  allowsBootstrap(): boolean {
    return true;
  }
}
