import { describe, expect, it } from "vitest";
import { createLogger } from "@/shared/logging";
import { createMemoryDestination } from "../../../../tests/fixtures/canaries";
import {
  candidateRateLimits,
  clientKeyFrom,
  FixedWindowRateLimiter,
} from "./action-rate-limiter";
import {
  AuthEmailDispatcher,
  InMemoryEmailCapture,
  renderAuthEmail,
  resetPasswordLink,
  type AuthEmailTransport,
} from "./auth-email";
import {
  LocalDenylistCompromisedPassword,
  localPasswordDenylist,
} from "./compromised-password";
import { toCookieWrites } from "./cookie-writes";
import {
  INVITATION_NAMESPACE,
  RegistrationIntentRepository,
  type VerificationStore,
} from "./registration-intent-repository";
import { LogSecurityEvents } from "./security-events";
import {
  isLoopbackSmtpHost,
  LocalSmtpEmailTransport,
} from "./smtp-auth-email-adapter";

const origin = "http://localhost:3000";
const to = "test.person@example.test";
const resetToken = "AbCdEfGhIjKlMnOpQrStUvWx";

describe("auth email templates", () => {
  it("renders the verification code with minimal content", () => {
    const email = renderAuthEmail(
      {
        template: "EMAIL_VERIFICATION_CODE",
        to,
        code: "12345678",
        expiresInMinutes: 10,
      },
      origin,
    );
    expect(email.subject).toBe("Your email verification code");
    expect(email.text).toContain("12345678");
    expect(email.text).toContain("10 minutes");
    expect(email.html).not.toMatch(/<img|<script|https?:\/\/(?!localhost)/i);
  });

  it("puts the reset token only in a fragment on the configured origin", () => {
    const email = renderAuthEmail(
      {
        template: "PASSWORD_RESET",
        to,
        token: resetToken,
        expiresInMinutes: 30,
      },
      origin,
    );
    const link = `${origin}/reset-password#token=${resetToken}`;
    expect(email.text).toContain(link);
    expect(email.html).toContain(`href="${link}"`);
    expect(email.text).not.toMatch(/[?&]token=|callbackURL|utm_/);
    expect(
      resetPasswordLink("http://localhost:3000/ignored/path", resetToken),
    ).toBe(link);
  });

  it("refuses malformed tokens and codes rather than rendering them", () => {
    expect(() => resetPasswordLink(origin, 'abc"><script>')).toThrow();
    expect(() =>
      renderAuthEmail(
        {
          template: "EMAIL_VERIFICATION_CODE",
          to,
          code: "<b>1</b>",
          expiresInMinutes: 10,
        },
        origin,
      ),
    ).toThrow();
  });

  it("escapes every dynamic value in HTML and uses no remote resources", () => {
    const email = renderAuthEmail({ template: "PASSWORD_CHANGED", to }, origin);
    expect(email.html).toContain("&#39;");
    expect(email.html).not.toMatch(/<img|<link|<script|src=|@import/i);
    expect(email.text).not.toContain(to);
  });
});

describe("AuthEmailDispatcher", () => {
  it("delivers off the request path and logs codes only", async () => {
    const logs = createMemoryDestination();
    const capture = new InMemoryEmailCapture("test");
    const dispatcher = new AuthEmailDispatcher(
      capture,
      origin,
      createLogger({ destination: logs }),
    );
    dispatcher.enqueue({ template: "PASSWORD_CHANGED", to });
    expect(capture.count).toBe(0); // not delivered synchronously
    const email = await capture.waitFor(to, "PASSWORD_CHANGED");
    await dispatcher.idle();
    expect(email.subject).toBe("Your password was changed");
    expect(logs.raw()).toContain("auth.email_dispatched");
    expect(logs.raw()).not.toContain(to);
  });

  it("logs a safe code when delivery fails", async () => {
    const logs = createMemoryDestination();
    const failing: AuthEmailTransport = {
      kind: "smtp-local",
      deliver: async () => {
        throw new Error(`smtp failed for ${to}`);
      },
    };
    const dispatcher = new AuthEmailDispatcher(
      failing,
      origin,
      createLogger({ destination: logs }),
    );
    dispatcher.enqueue({ template: "PASSWORD_CHANGED", to });
    await dispatcher.idle();
    expect(logs.raw()).toContain("auth.email_delivery_failed");
    expect(logs.raw()).not.toContain(to);
    expect(logs.raw()).not.toContain("smtp failed");
  });
});

describe("local SMTP transport", () => {
  it("accepts loopback hosts only", () => {
    expect(isLoopbackSmtpHost("127.0.0.1")).toBe(true);
    expect(isLoopbackSmtpHost("localhost")).toBe(true);
    expect(isLoopbackSmtpHost("[::1]")).toBe(true);
    expect(isLoopbackSmtpHost("smtp.example.test")).toBe(false);
    expect(
      () =>
        new LocalSmtpEmailTransport({
          host: "smtp.example.test",
          port: 25,
          from: "no-reply@example.test",
        }),
    ).toThrow(/loopback/);
  });
});

describe("compromised-password port", () => {
  it("matches the local denylist exactly and never transforms input", async () => {
    const port = new LocalDenylistCompromisedPassword();
    expect(await port.isCompromised("password1234")).toBe(true);
    expect(await port.isCompromised("TEST compromised passphrase 0001")).toBe(
      true,
    );
    expect(await port.isCompromised("PASSWORD1234")).toBe(false);
    expect(await port.isCompromised(" password1234")).toBe(false);
    expect(await port.isCompromised("TEST unique passphrase 0001")).toBe(false);
    expect(localPasswordDenylist.every((p) => p.length >= 12)).toBe(true);
  });
});

describe("FixedWindowRateLimiter", () => {
  it("allows the policy limit per window, then blocks until it resets", () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter(() => now);
    const { limit, windowMs } = candidateRateLimits.verifyPerClientEmail;
    for (let i = 0; i < limit; i += 1) {
      expect(limiter.consume("verifyPerClientEmail", "c", to)).toBe(true);
    }
    expect(limiter.consume("verifyPerClientEmail", "c", to)).toBe(false);
    // Other keys and buckets are independent.
    expect(
      limiter.consume("verifyPerClientEmail", "c", "other@example.test"),
    ).toBe(true);
    expect(limiter.consume("register", "c")).toBe(true);
    now += windowMs;
    expect(limiter.consume("verifyPerClientEmail", "c", to)).toBe(true);
  });

  it("stays bounded under many distinct keys", () => {
    const limiter = new FixedWindowRateLimiter(() => 0, 10);
    for (let i = 0; i < 100; i += 1) limiter.consume("register", `k${i}`);
    expect(limiter.consume("register", "fresh")).toBe(true);
  });

  it("derives a coarse client key from the first forwarded hop only", () => {
    expect(clientKeyFrom(new Headers())).toBe("direct");
    expect(
      clientKeyFrom(
        new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }),
      ),
    ).toBe("203.0.113.5");
  });
});

class FakeVerificationStore implements VerificationStore {
  readonly rows = new Map<string, { value: string; expiresAt: Date }>();
  async createVerificationValue(data: {
    identifier: string;
    value: string;
    expiresAt: Date;
  }) {
    this.rows.set(data.identifier, {
      value: data.value,
      expiresAt: data.expiresAt,
    });
  }
  async findVerificationValue(identifier: string) {
    return this.rows.get(identifier) ?? null;
  }
  async consumeVerificationValue(identifier: string) {
    const row = this.rows.get(identifier);
    this.rows.delete(identifier);
    return row && row.expiresAt.getTime() > now.getTime() ? row : null;
  }
}

let now = new Date("2026-10-06T12:00:00Z");
const settings = {
  secret: "0f3a9c27".repeat(8),
  publicTtlSeconds: 3600,
  invitationTtlSeconds: 7 * 24 * 3600,
};

function repository(store = new FakeVerificationStore()) {
  return {
    store,
    repo: new RegistrationIntentRepository(
      settings,
      async () => store,
      () => now,
    ),
  };
}

describe("RegistrationIntentRepository", () => {
  it("issues and validates a signed public intent with no persistence", async () => {
    const { repo, store } = repository();
    const token = repo.issuePublic();
    const intent = await repo.peek(token);
    expect(intent).toMatchObject({
      source: "PUBLIC_POSITION",
      continuationKey: "CANDIDATE_SECURITY",
    });
    expect(intent?.boundEmail).toBeUndefined();
    expect(await repo.consume(token)).toBe(true);
    expect(store.rows.size).toBe(0);
  });

  it("rejects tampered, re-signed, expired, and foreign-secret public intents", async () => {
    const { repo } = repository();
    const token = repo.issuePublic();
    const [part, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(part, "base64url").toString()),
        src: "CANDIDATE_INVITATION",
      }),
    ).toString("base64url");
    expect(await repo.peek(`${forged}.${signature}`)).toBeNull();
    expect(await repo.peek(`${part}.${signature.slice(0, -2)}AA`)).toBeNull();
    expect(await repo.peek(`${part}.`)).toBeNull();

    const other = new RegistrationIntentRepository(
      { ...settings, secret: "9b8c7d6e".repeat(8) },
      async () => new FakeVerificationStore(),
      () => now,
    );
    expect(await other.peek(token)).toBeNull();

    const saved = now;
    now = new Date(saved.getTime() + 3601_000);
    expect(await repo.peek(token)).toBeNull();
    now = saved;
  });

  it.each([undefined, "", "x", "a".repeat(2000), "abc def", "<script>"])(
    "rejects malformed tokens (%#)",
    async (token) => {
      expect(await repository().repo.peek(token)).toBeNull();
    },
  );

  it("persists invitations hashed-by-namespace, email-bound, and single use", async () => {
    const { repo, store } = repository();
    const token = await repo.issueInvitation("test.invited@example.test");
    const [identifier] = [...store.rows.keys()];
    expect(identifier).toBe(`${INVITATION_NAMESPACE}${token}`);
    expect(await repo.peek(token)).toMatchObject({
      source: "CANDIDATE_INVITATION",
      boundEmail: "test.invited@example.test",
    });
    expect(await repo.consume(token)).toBe(true);
    expect(await repo.consume(token)).toBe(false);
    expect(await repo.peek(token)).toBeNull();
  });

  it("treats expired invitations as invalid", async () => {
    const { repo } = repository();
    const token = await repo.issueInvitation("test.invited@example.test");
    const saved = now;
    now = new Date(saved.getTime() + settings.invitationTtlSeconds * 1000 + 1);
    expect(await repo.peek(token)).toBeNull();
    expect(await repo.consume(token)).toBe(false);
    now = saved;
  });
});

describe("security events", () => {
  it("logs allowlisted codes with an opaque reference and nothing else", () => {
    const logs = createMemoryDestination();
    const events = new LogSecurityEvents(createLogger({ destination: logs }));
    events.record({
      code: "auth.sign_in_failed",
      category: "invalid_credentials",
      accountRef: "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b",
    });
    events.record({ code: "auth.not_a_code" as never });
    const text = logs.raw();
    expect(text).toContain("auth.sign_in_failed");
    expect(text).toContain("0b9a7a3e6a554c8e9a3b2f1d0c4e5a6b");
    expect(text).not.toContain("auth.not_a_code");
  });
});

describe("cookie writes", () => {
  it("converts Set-Cookie headers into cookie-store writes", () => {
    const [write] = toCookieWrites([
      "psa.session_token=TESTCANARY-value; Max-Age=28800; Path=/; HttpOnly; SameSite=Lax",
    ]);
    expect(write).toMatchObject({
      name: "psa.session_token",
      value: "TESTCANARY-value",
      options: { path: "/", httpOnly: true, sameSite: "lax", maxAge: 28800 },
    });
  });
});
