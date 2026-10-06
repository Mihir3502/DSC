// Authorization port for staff administration commands (packet M1.3 §7.3,
// §14.2, AC-M1.3-03). Roles, scopes, separation-of-duty adapters, and
// immutable audit arrive in M1.4–M1.6, so no production adapter may permit
// invitation issuance/revocation or recovery-case steps yet:
//
// - RefusingStaffAdministrationGate is the runtime default everywhere,
//   including the running web application. No route or page constructs
//   anything else.
// - NonproductionHarnessGate exists for the local bootstrap/recovery scripts
//   and tests. Its constructor throws outside APP_ENV=local/test, so it can
//   never operate in a production-like configuration.

export type StaffAdministrationActor =
  | Readonly<{ kind: "BOOTSTRAP"; reason: "LOCAL_BOOTSTRAP" | "TEST_HARNESS" }>
  /** A staff account acting through an authorized adapter (M1.4+). */
  | Readonly<{ kind: "ACCOUNT"; accountId: string }>;

export type StaffAdministrationAction =
  | "INVITATION_ISSUE"
  | "INVITATION_REVOKE"
  | "RECOVERY_START_VERIFICATION"
  | "RECOVERY_CONFIRM_IDENTITY"
  | "RECOVERY_APPROVE"
  | "RECOVERY_REJECT"
  | "RECOVERY_CANCEL"
  | "RECOVERY_COMPLETE";

export interface StaffAdministrationGate {
  readonly mode: "refuse" | "nonproduction-harness";
  allows(
    actor: StaffAdministrationActor,
    action: StaffAdministrationAction,
  ): boolean;
}

export class RefusingStaffAdministrationGate implements StaffAdministrationGate {
  readonly mode = "refuse" as const;
  allows(
    actor: StaffAdministrationActor,
    action: StaffAdministrationAction,
  ): boolean {
    void actor;
    void action;
    return false;
  }
}

export class NonproductionHarnessGate implements StaffAdministrationGate {
  readonly mode = "nonproduction-harness" as const;

  constructor(private readonly appEnv: string | undefined) {
    if (appEnv !== "local" && appEnv !== "test") {
      throw new Error(
        "the staff administration harness is available only when APP_ENV is local or test",
      );
    }
  }

  allows(
    actor: StaffAdministrationActor,
    action: StaffAdministrationAction,
  ): boolean {
    if (actor.kind === "BOOTSTRAP") {
      if (action !== "INVITATION_ISSUE" && action !== "INVITATION_REVOKE") {
        return false;
      }
      return actor.reason === "TEST_HARNESS" ? this.appEnv === "test" : true;
    }
    // Synthetic staff actors drive recovery steps in local/test only; the
    // domain still enforces self-action and verifier/approver separation.
    return action.startsWith("RECOVERY_");
  }
}
