import "server-only";
import { randomUUID } from "node:crypto";
import {
  authorizationDependencies,
  authorizeInTransaction,
  type AuthorizationDependencies,
  type AuthorizationRequest,
  resolveCurrentStaff,
  type Principal,
} from "@/modules/identity-access";
import {
  withAuditedTransaction,
  type AuditFacts,
  type EffectiveAuthority,
} from "@/modules/audit";
import { pgErrorCode } from "@/shared/database/errors";
import type { ConfigurationRefusal } from "../domain/lifecycle";
import { isUuid } from "../domain/values";
import {
  findReceipt,
  insertReceipt,
  type Executor,
} from "../infrastructure/organization-repository";
import {
  nextPublicPositionInvalidator,
  type PublicPositionInvalidator,
} from "../infrastructure/public-position-cache";

// Shared command runner for organization configuration (packet M2.1 §15,
// §20, §21; ADR-0013). Every command:
//
// 1. is called with the server-resolved actor (never a client claim);
// 2. validates exact bounded input before this runner (the command);
// 3–4. authorizes through the M1 service inside its own transaction, with
//    scope re-resolved from server-owned hierarchy rows;
// 5–6. locks the aggregate, checks the expected version, applies domain
//    invariants (the command body);
// 7. persists the change, its M1.6 audit event(s), and the command-key
//    receipt in that one transaction — any failure rolls all of it back;
// 8. invalidates public caches only after commit;
// 9. returns a closed result the delivery maps to an exact view.
//
// A retried command key returns the recorded result and changes nothing.

export type ConfigurationActor =
  | Readonly<{ kind: "ACCOUNT"; principal: Principal }>
  /** Test harness only; refused unless the bootstrap gate allows it. */
  | Readonly<{ kind: "BOOTSTRAP"; reason: "TEST_HARNESS"; accountId: string }>;

/** Nonproduction bootstrap gate (the M1.4 assignment harness shape). */
export type BootstrapGate = Readonly<{ allowsBootstrap(): boolean }>;

/** The production default: the bootstrap actor is always refused. */
export const refusingBootstrap: BootstrapGate = Object.freeze({
  allowsBootstrap: () => false,
});

export type ConfigurationDependencies = AuthorizationDependencies &
  Readonly<{
    bootstrap: BootstrapGate;
    invalidator: PublicPositionInvalidator;
  }>;

export function configurationDependencies(
  overrides: Partial<ConfigurationDependencies> = {},
): ConfigurationDependencies {
  return Object.freeze({
    ...authorizationDependencies(),
    bootstrap: refusingBootstrap,
    invalidator: nextPublicPositionInvalidator,
    ...overrides,
  });
}

export type CommandOutcome =
  | Readonly<{
      kind: "DONE";
      targetId: string;
      version: number;
      /** True when a retried command key returned the recorded result. */
      replayed: boolean;
    }>
  | Readonly<{ kind: "REFUSED"; reason: ConfigurationRefusal }>;

export class Refusal extends Error {
  constructor(readonly reason: ConfigurationRefusal) {
    super(reason);
  }
}

export const refuse = (reason: ConfigurationRefusal): never => {
  throw new Refusal(reason);
};

class Replay extends Error {
  constructor(
    readonly targetId: string,
    readonly version: number,
  ) {
    super("replay");
  }
}

export type CommandContext = {
  readonly tx: Executor;
  readonly now: Date;
  readonly actorId: string;
  effective: EffectiveAuthority | null;
  readonly events: AuditFacts[];
  readonly tags: Set<string>;
};

type CommandSpec = Readonly<{
  /** Stable snake_case command name recorded with the command key. */
  name: string;
  commandKey: string | undefined;
}>;

function actorId(actor: ConfigurationActor): string {
  return actor.kind === "ACCOUNT" ? actor.principal.accountId : actor.accountId;
}

function actorFacts(actor: ConfigurationActor) {
  return actor.kind === "ACCOUNT"
    ? ({ actorRef: actor.principal.accountId } as const)
    : ({ systemActor: "TEST_HARNESS" } as const);
}

/**
 * Authorizes the actor for one permission on a resource inside the
 * command transaction (M1 central service: role, scope, sensitivity,
 * recent authentication, reason). Records the effective authority used.
 */
export async function authorizeConfiguration(
  ctx: CommandContext,
  actor: ConfigurationActor,
  deps: ConfigurationDependencies,
  permission: string,
  resource: AuthorizationRequest["resource"],
  reasonCode?: string,
): Promise<void> {
  if (actor.kind === "BOOTSTRAP") {
    if (
      actor.reason !== "TEST_HARNESS" ||
      !deps.bootstrap.allowsBootstrap() ||
      !isUuid(actor.accountId)
    ) {
      refuse("NOT_AUTHORIZED");
    }
    return;
  }
  const decision = await authorizeInTransaction(
    ctx.tx,
    {
      principal: {
        accountId: actor.principal.accountId,
        accountType: actor.principal.accountType,
        sessionId: actor.principal.sessionId,
      },
      permission,
      operation: "CONFIGURE",
      resource,
      ...(reasonCode ? { reasonCode } : {}),
    },
    deps,
  );
  if (decision.decision !== "ALLOW") {
    refuse(
      decision.reasonCode === "RECENT_AUTH_REQUIRED"
        ? "REAUTHENTICATION_REQUIRED"
        : decision.reasonCode === "UNAUTHENTICATED"
          ? "UNAUTHENTICATED"
          : "NOT_AUTHORIZED",
    );
    return;
  }
  ctx.effective = {
    roleCode: decision.effectiveRoleCode,
    assignmentId: decision.effectiveAssignmentId,
    scopeType: decision.effectiveScopeType,
    scopeReferenceId: decision.effectiveScopeReferenceId,
  };
}

/** Maps a database error to a closed refusal, or rethrows it. */
function refusalForDatabaseError(error: unknown): ConfigurationRefusal {
  const code = pgErrorCode(error);
  if (code === "40001" || code === "40P01") return "STALE_VERSION";
  if (code === "23505") return "DUPLICATE_CODE";
  // Integrity triggers (OG002–OG005) and other constraint violations.
  if (code?.startsWith("23") || code?.startsWith("OG")) {
    return "INVALID_TRANSITION";
  }
  throw error;
}

const receiptConstraint = "organization_command_receipt_key_unique";

function isReceiptConflict(error: unknown): boolean {
  return (
    pgErrorCode(error) === "23505" &&
    typeof error === "object" &&
    error !== null &&
    ((error as { constraint?: string }).constraint === receiptConstraint ||
      (error as { cause?: { constraint?: string } }).cause?.constraint ===
        receiptConstraint)
  );
}

/**
 * Runs one configuration command. `body` returns the target and its new
 * version; the runner appends the queued audit events with the actor's
 * effective authority and records the command-key receipt.
 */
export async function runConfigurationCommand(
  deps: ConfigurationDependencies,
  actor: ConfigurationActor,
  spec: CommandSpec,
  body: (
    ctx: CommandContext,
  ) => Promise<Readonly<{ targetId: string; version: number }>>,
): Promise<CommandOutcome> {
  if (spec.commandKey !== undefined && !isUuid(spec.commandKey)) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" };
  }
  if (actor.kind === "ACCOUNT" && spec.commandKey === undefined) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" };
  }
  const actorAccountId = actorId(actor);
  let tags = new Set<string>();
  try {
    const result = await withAuditedTransaction(deps, async (tx, audit) => {
      const ctx: CommandContext = {
        tx: tx as unknown as Executor,
        now: deps.clock(),
        actorId: actorAccountId,
        effective: null,
        events: [],
        tags: new Set(),
      };
      if (spec.commandKey) {
        const prior = await findReceipt(
          ctx.tx,
          actorAccountId,
          spec.commandKey,
        );
        if (prior) {
          if (prior.commandName !== spec.name) refuse("COMMAND_KEY_CONFLICT");
          throw new Replay(prior.targetId, prior.resultVersion);
        }
      }
      const outcome = await body(ctx);
      for (const event of ctx.events) {
        await audit.append({
          ...event,
          ...actorFacts(actor),
          ...(ctx.effective ? { effective: ctx.effective } : {}),
        });
      }
      if (spec.commandKey) {
        await insertReceipt(ctx.tx, {
          actorAccountId,
          commandKey: spec.commandKey,
          commandName: spec.name,
          targetId: outcome.targetId,
          resultVersion: outcome.version,
        });
      }
      tags = ctx.tags;
      return outcome;
    });
    // Only after commit: a rolled-back command never invalidates.
    if (tags.size > 0) await deps.invalidator.invalidate([...tags]);
    return { kind: "DONE", ...result, replayed: false };
  } catch (error) {
    if (error instanceof Replay) {
      return {
        kind: "DONE",
        targetId: error.targetId,
        version: error.version,
        replayed: true,
      };
    }
    if (error instanceof Refusal) {
      return { kind: "REFUSED", reason: error.reason };
    }
    if (spec.commandKey && isReceiptConflict(error)) {
      // A concurrent request with the same key committed first.
      const prior = await findReceipt(
        deps.db as unknown as Executor,
        actorAccountId,
        spec.commandKey,
      );
      if (prior && prior.commandName === spec.name) {
        return {
          kind: "DONE",
          targetId: prior.targetId,
          version: prior.resultVersion,
          replayed: true,
        };
      }
      return { kind: "REFUSED", reason: "COMMAND_KEY_CONFLICT" };
    }
    const reason = refusalForDatabaseError(error);
    deps.logger.warn("organization.command_refused", {
      module: "organization",
      action: spec.name,
      resultCode: reason.toLowerCase(),
    });
    return { kind: "REFUSED", reason };
  }
}

/** The request's MFA-complete staff principal as an actor, or null. */
export async function staffActor(
  headers: Headers,
): Promise<ConfigurationActor | null> {
  const principal = await resolveCurrentStaff(headers);
  return principal ? { kind: "ACCOUNT", principal } : null;
}

/** A fresh server-generated command key for a rendered form. */
export function newCommandKey(): string {
  return randomUUID();
}
