import "server-only";
import { createHash } from "node:crypto";
import {
  actionRateLimiter,
  authorizationDependencies,
  authorizeInTransaction,
  resolveCurrentCandidate,
  resolveCurrentStaff,
  type ActionRateLimiter,
  type AuthorizationDependencies,
  type AuthorizationRequest,
  type Principal,
} from "@/modules/identity-access";
import {
  withAuditedTransaction,
  type AuditFacts,
  type EffectiveAuthority,
} from "@/modules/audit";
import { pgErrorCode } from "@/shared/database/errors";
import {
  findReceipt,
  insertReceipt,
  type Executor,
} from "../infrastructure/candidates-repository";

// Command runner for the candidates module (packet M2.2 §17, §21). Every
// command runs in one audited transaction with an idempotency receipt
// that stores a SHA-256 fingerprint of the canonical request:
// - same key + same fingerprint → the recorded outcome, no new effect;
// - same key + different fingerprint (or command) → COMMAND_KEY_CONFLICT.
// The fingerprint is computed from canonical, already-normalized values;
// it is a one-way hash and never stored or logged in clear.

export type CandidateActor =
  | Readonly<{ kind: "CANDIDATE"; principal: Principal }>
  | Readonly<{ kind: "STAFF"; principal: Principal }>
  /** Test harness only; refused unless the bootstrap gate allows it. */
  | Readonly<{ kind: "BOOTSTRAP"; reason: "TEST_HARNESS"; accountId: string }>;

export type BootstrapGate = Readonly<{ allowsBootstrap(): boolean }>;

/** Production default: the bootstrap actor is always refused. */
export const refusingBootstrap: BootstrapGate = Object.freeze({
  allowsBootstrap: () => false,
});

export type CandidateDependencies = AuthorizationDependencies &
  Readonly<{ bootstrap: BootstrapGate; limiter: ActionRateLimiter }>;

export function candidateDependencies(
  overrides: Partial<CandidateDependencies> = {},
): CandidateDependencies {
  return Object.freeze({
    ...authorizationDependencies(),
    bootstrap: refusingBootstrap,
    limiter: actionRateLimiter(),
    ...overrides,
  });
}

export const candidateRefusals = [
  "UNAUTHENTICATED",
  "NOT_AUTHORIZED",
  "REAUTHENTICATION_REQUIRED",
  "NOT_FOUND",
  "INVALID_INPUT",
  "STALE_VERSION",
  "INVALID_TRANSITION",
  "OPENING_UNAVAILABLE",
  "OWNER_NOT_ELIGIBLE",
  "COMMAND_KEY_CONFLICT",
  "RATE_LIMITED",
  "TEMPLATE_UNAVAILABLE",
  "BLOCKED_CASE_NOT_CONFIRMED",
  "BLOCKED_PERSON_NOT_ACTIVE",
  "BLOCKED_TWO_CANDIDATE_ACCOUNTS",
  "BLOCKED_CURRENT_CANDIDACY_COLLISION",
] as const;
export type CandidateRefusal = (typeof candidateRefusals)[number];

export class Refusal extends Error {
  constructor(readonly reason: CandidateRefusal) {
    super(reason);
  }
}

export const refuse = (reason: CandidateRefusal): never => {
  throw new Refusal(reason);
};

/** A command result that stores no business change (e.g. a warning). */
export class Unchanged extends Error {
  constructor(
    readonly outcome: string,
    readonly targetId: string | null,
  ) {
    super(outcome);
  }
}

export type CandidateOutcome =
  | Readonly<{
      kind: "DONE";
      /** CREATED, EXISTING, UPDATED, MERGED, … */
      outcome: string;
      targetId: string;
      version: number;
      replayed: boolean;
    }>
  | Readonly<{ kind: "UNCHANGED"; outcome: string; targetId: string | null }>
  | Readonly<{ kind: "REFUSED"; reason: CandidateRefusal }>;

export type CommandContext = {
  readonly tx: Executor;
  readonly now: Date;
  readonly actorId: string;
  readonly actor: CandidateActor;
  effective: EffectiveAuthority | null;
  readonly events: AuditFacts[];
};

/** SHA-256 of a canonical JSON request (stable key order). */
export function fingerprint(
  canonical: Readonly<Record<string, unknown>>,
): string {
  const ordered = Object.fromEntries(
    Object.keys(canonical)
      .sort()
      .map((k) => [k, canonical[k] ?? null]),
  );
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

function actorId(actor: CandidateActor): string {
  return actor.kind === "BOOTSTRAP"
    ? actor.accountId
    : actor.principal.accountId;
}

export function actorFacts(actor: CandidateActor) {
  return actor.kind === "BOOTSTRAP"
    ? ({ systemActor: "TEST_HARNESS" } as const)
    : ({ actorRef: actor.principal.accountId } as const);
}

/** Authorizes inside the transaction through the M1 central service. */
export async function authorizeCandidateCommand(
  ctx: CommandContext,
  deps: CandidateDependencies,
  permission: string,
  operation: AuthorizationRequest["operation"],
  resource: AuthorizationRequest["resource"],
  reasonCode?: string,
  workflow?: AuthorizationRequest["workflow"],
): Promise<void> {
  const { actor } = ctx;
  if (actor.kind === "BOOTSTRAP") {
    if (actor.reason !== "TEST_HARNESS" || !deps.bootstrap.allowsBootstrap()) {
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
      operation,
      resource,
      ...(reasonCode ? { reasonCode } : {}),
      ...(workflow ? { workflow } : {}),
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
  ctx.effective =
    decision.effectiveAssignmentId === null
      ? null
      : {
          roleCode: decision.effectiveRoleCode,
          assignmentId: decision.effectiveAssignmentId,
          scopeType: decision.effectiveScopeType,
          scopeReferenceId: decision.effectiveScopeReferenceId,
        };
}

function refusalFor(error: unknown): CandidateRefusal {
  const code = pgErrorCode(error);
  if (code === "40001" || code === "40P01") return "STALE_VERSION";
  if (code?.startsWith("23") || code?.startsWith("CN"))
    return "INVALID_TRANSITION";
  throw error;
}

const receiptConstraint = "candidate_command_receipt_key_unique";
const constraintOf = (error: unknown) =>
  (error as { constraint?: string })?.constraint ??
  (error as { cause?: { constraint?: string } })?.cause?.constraint;

export type CommandSpec = Readonly<{
  name: string;
  commandKey: string | undefined;
  fingerprint: string;
  /** A unique-violation constraint the command maps to its own outcome. */
  onConflict?: Readonly<{
    constraint: string;
    resolve: () => Promise<CandidateOutcome>;
  }>;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function runCandidateCommand(
  deps: CandidateDependencies,
  actor: CandidateActor,
  spec: CommandSpec,
  body: (
    ctx: CommandContext,
  ) => Promise<
    Readonly<{ outcome: string; targetId: string; version: number }>
  >,
): Promise<CandidateOutcome> {
  if (spec.commandKey !== undefined && !uuid.test(spec.commandKey)) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" };
  }
  if (actor.kind !== "BOOTSTRAP" && spec.commandKey === undefined) {
    return { kind: "REFUSED", reason: "INVALID_INPUT" };
  }
  const id = actorId(actor);
  const replay = (
    prior: NonNullable<Awaited<ReturnType<typeof findReceipt>>>,
  ) =>
    prior.commandName !== spec.name ||
    prior.requestFingerprint !== spec.fingerprint
      ? ({ kind: "REFUSED", reason: "COMMAND_KEY_CONFLICT" } as const)
      : ({
          kind: "DONE",
          outcome: prior.outcomeCode,
          targetId: prior.targetId,
          version: prior.resultVersion,
          replayed: true,
        } as const);
  try {
    const result = await withAuditedTransaction(deps, async (tx, audit) => {
      const ctx: CommandContext = {
        tx: tx as unknown as Executor,
        now: deps.clock(),
        actorId: id,
        actor,
        effective: null,
        events: [],
      };
      if (spec.commandKey) {
        const prior = await findReceipt(ctx.tx, id, spec.commandKey);
        if (prior) return replay(prior);
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
          actorAccountId: id,
          commandKey: spec.commandKey,
          commandName: spec.name,
          requestFingerprint: spec.fingerprint,
          targetId: outcome.targetId,
          resultVersion: outcome.version,
          outcomeCode: outcome.outcome,
        });
      }
      return { kind: "DONE", ...outcome, replayed: false } as const;
    });
    return result;
  } catch (error) {
    if (error instanceof Refusal)
      return { kind: "REFUSED", reason: error.reason };
    if (error instanceof Unchanged) {
      return {
        kind: "UNCHANGED",
        outcome: error.outcome,
        targetId: error.targetId,
      };
    }
    const constraint = constraintOf(error);
    if (
      pgErrorCode(error) === "23505" &&
      constraint === receiptConstraint &&
      spec.commandKey
    ) {
      const prior = await findReceipt(
        deps.db as unknown as Executor,
        id,
        spec.commandKey,
      );
      if (prior) return replay(prior);
    }
    const onConflict = spec.onConflict;
    if (
      onConflict !== undefined &&
      pgErrorCode(error) === "23505" &&
      onConflict.constraint === constraint
    ) {
      return onConflict.resolve();
    }
    const reason = refusalFor(error);
    deps.logger.warn("candidates.command_refused", {
      module: "candidates",
      action: spec.name,
      resultCode: reason.toLowerCase(),
    });
    return { kind: "REFUSED", reason };
  }
}

/** The request's verified candidate as an actor, or null. */
export async function candidateActorFrom(
  headers: Headers,
): Promise<CandidateActor | null> {
  const principal = await resolveCurrentCandidate(headers);
  return principal ? { kind: "CANDIDATE", principal } : null;
}

/** The request's MFA-complete staff member as an actor, or null. */
export async function staffActorFrom(
  headers: Headers,
): Promise<CandidateActor | null> {
  const principal = await resolveCurrentStaff(headers);
  return principal ? { kind: "STAFF", principal } : null;
}

export { randomUUID as newCandidateCommandKey } from "node:crypto";
