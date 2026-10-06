import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_CONTINUATION,
  isContinuationKey,
  type ContinuationKey,
  type RegistrationIntent,
} from "../domain/candidate-registration-policy";

// Registration-intent contract (packet M1.2 §6.2, ADR-0003). There are no
// M2 records here: no position, person, or candidacy. Two forms exist:
//
// PUBLIC_POSITION — a server-signed state (HMAC-SHA256 with the auth secret,
//   purpose-bound to "registration-intent.v1", issued/expiry times, closed
//   continuation key). It grants nothing on its own, so it is not persisted.
//
// CANDIDATE_INVITATION — a random 256-bit capability persisted in
//   auth.verification under the "registration-intent:" namespace. Better
//   Auth stores the identifier hashed (verification.storeIdentifier), the
//   value holds the source, normalized bound email, and continuation key,
//   and consumption is atomic and single-use (consumeVerificationValue).
//   The namespace cannot collide with "reset-password:" or the email-OTP
//   identifiers.

export const INVITATION_NAMESPACE = "registration-intent:";
const PUBLIC_PURPOSE = "registration-intent.v1";
const tokenShape = /^[A-Za-z0-9_-]{16,700}(\.[A-Za-z0-9_-]{16,128})?$/;

/** The subset of Better Auth's internal adapter this repository uses. */
export interface VerificationStore {
  createVerificationValue(data: {
    identifier: string;
    value: string;
    expiresAt: Date;
  }): Promise<unknown>;
  findVerificationValue(
    identifier: string,
  ): Promise<{ value: string; expiresAt: Date } | null | undefined>;
  consumeVerificationValue(
    identifier: string,
  ): Promise<{ value: string } | null | undefined>;
}

type PublicPayload = {
  v: 1;
  src: "PUBLIC_POSITION";
  ck: ContinuationKey;
  iat: number;
  exp: number;
  n: string;
};

type InvitationValue = {
  source: "CANDIDATE_INVITATION";
  boundEmail: string;
  continuationKey: ContinuationKey;
};

export type RegistrationIntentSettings = Readonly<{
  secret: string;
  publicTtlSeconds: number;
  invitationTtlSeconds: number;
}>;

export class RegistrationIntentRepository {
  constructor(
    private readonly settings: RegistrationIntentSettings,
    private readonly store: () => Promise<VerificationStore>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  #sign(payloadPart: string): string {
    return createHmac("sha256", this.settings.secret)
      .update(`${PUBLIC_PURPOSE}.${payloadPart}`)
      .digest("base64url");
  }

  /** Signed public intent with the generic candidate continuation. */
  issuePublic(continuationKey: ContinuationKey = DEFAULT_CONTINUATION): string {
    const iat = Math.floor(this.now().getTime() / 1000);
    const payload: PublicPayload = {
      v: 1,
      src: "PUBLIC_POSITION",
      ck: continuationKey,
      iat,
      exp: iat + this.settings.publicTtlSeconds,
      n: randomBytes(9).toString("base64url"),
    };
    const part = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${part}.${this.#sign(part)}`;
  }

  /**
   * Persists a single-use invitation bound to a normalized email and returns
   * the raw capability (shown once; only its hash is stored).
   */
  async issueInvitation(
    normalizedEmail: string,
    continuationKey: ContinuationKey = DEFAULT_CONTINUATION,
  ): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const value: InvitationValue = {
      source: "CANDIDATE_INVITATION",
      boundEmail: normalizedEmail,
      continuationKey,
    };
    await (
      await this.store()
    ).createVerificationValue({
      identifier: `${INVITATION_NAMESPACE}${token}`,
      value: JSON.stringify(value),
      expiresAt: new Date(
        this.now().getTime() + this.settings.invitationTtlSeconds * 1000,
      ),
    });
    return token;
  }

  /** Validates an intent without consuming it. Null for anything invalid. */
  async peek(token: unknown): Promise<RegistrationIntent | null> {
    if (typeof token !== "string" || !tokenShape.test(token)) return null;
    return token.includes(".")
      ? this.#verifyPublic(token)
      : this.#findInvitation(token);
  }

  /**
   * Consumes an intent. Public intents carry no capability and are not
   * persisted, so they always succeed; invitations succeed exactly once.
   */
  async consume(token: string): Promise<boolean> {
    if (token.includes(".")) return this.#verifyPublic(token) !== null;
    if (!tokenShape.test(token)) return false;
    const row = await (
      await this.store()
    ).consumeVerificationValue(`${INVITATION_NAMESPACE}${token}`);
    return Boolean(row && parseInvitation(row.value));
  }

  #verifyPublic(token: string): RegistrationIntent | null {
    const [part, signature] = token.split(".");
    const expected = Buffer.from(this.#sign(part));
    const given = Buffer.from(signature ?? "");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      return null;
    }
    let payload: Partial<PublicPayload>;
    try {
      payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (
      payload.v !== 1 ||
      payload.src !== "PUBLIC_POSITION" ||
      !isContinuationKey(payload.ck) ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.iat > nowSeconds + 60 ||
      payload.exp <= nowSeconds
    ) {
      return null;
    }
    return Object.freeze({
      source: "PUBLIC_POSITION",
      continuationKey: payload.ck,
      expiresAt: new Date(payload.exp * 1000),
    });
  }

  async #findInvitation(token: string): Promise<RegistrationIntent | null> {
    const row = await (
      await this.store()
    ).findVerificationValue(`${INVITATION_NAMESPACE}${token}`);
    if (!row || new Date(row.expiresAt).getTime() <= this.now().getTime()) {
      return null;
    }
    const value = parseInvitation(row.value);
    if (!value) return null;
    return Object.freeze({
      source: "CANDIDATE_INVITATION",
      continuationKey: value.continuationKey,
      boundEmail: value.boundEmail,
      expiresAt: new Date(row.expiresAt),
    });
  }
}

function parseInvitation(raw: string): InvitationValue | null {
  try {
    const value = JSON.parse(raw) as Partial<InvitationValue>;
    if (
      value.source === "CANDIDATE_INVITATION" &&
      typeof value.boundEmail === "string" &&
      isContinuationKey(value.continuationKey)
    ) {
      return value as InvitationValue;
    }
  } catch {
    // fall through
  }
  return null;
}
