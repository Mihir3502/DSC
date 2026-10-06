import type { Auth } from "@/modules/identity-access/infrastructure/auth";
import type {
  AccountStatus,
  AccountType,
} from "@/modules/identity-access/domain/account-types";
import { reasonCodeFor } from "@/modules/identity-access/domain/account-types";
import { normalizeLoginEmail } from "@/modules/identity-access/domain/email";

// Test-only synthetic account factories (packet M1.1 §12). They refuse to run
// outside APP_ENV=test, use reserved example.test addresses, and create
// credentials only through Better Auth's internal adapter and its own
// password hasher (no custom cryptography). Never import from app code.

let sequence = 0;

/** Clearly synthetic passphrase; long, paste-friendly, never real. */
export const TEST_PASSWORD = "TEST correct horse battery staple 0001";

function assertTestEnvironment() {
  if (process.env.APP_ENV !== "test") {
    throw new Error("auth test factories are available only when APP_ENV=test");
  }
}

export type TestAccountOptions = {
  accountType?: AccountType;
  status?: AccountStatus;
  emailVerified?: boolean;
  /** Entered/display form; normalized before storage. */
  email?: string;
  password?: string | null;
};

export type TestAccount = Readonly<{
  id: string;
  email: string;
  password: string | null;
  accountType: AccountType;
  status: AccountStatus;
}>;

export function nextTestEmail(label = "account"): string {
  sequence += 1;
  return `test.${label}.${sequence}.${process.pid}@example.test`;
}

export async function createTestAccount(
  auth: Auth,
  options: TestAccountOptions = {},
): Promise<TestAccount> {
  assertTestEnvironment();
  const accountType = options.accountType ?? "CANDIDATE";
  const status = options.status ?? "ACTIVE";
  const { login, display } = normalizeLoginEmail(
    options.email ?? nextTestEmail(accountType.toLowerCase()),
  );
  const restricted =
    status === "LOCKED" || status === "DISABLED" || status === "CLOSED";
  const ctx = await auth.$context;

  const user = await ctx.internalAdapter.createUser(
    {
      email: login,
      emailDisplay: display,
      name: `TEST ${accountType.toLowerCase()} account`,
      emailVerified: options.emailVerified ?? true,
      accountType,
      status,
      ...(restricted
        ? { disabledAt: new Date(), disabledReasonCode: reasonCodeFor[status] }
        : {}),
    },
    // Server-side provisioning (never public sign-up).
    { method: "admin" },
  );
  if (!user) throw new Error("test account was not created");

  const password =
    options.password === undefined ? TEST_PASSWORD : options.password;
  if (password !== null) {
    await ctx.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await ctx.password.hash(password),
    });
  }
  return Object.freeze({
    id: user.id,
    email: login,
    password,
    accountType,
    status,
  });
}

/** Cookie header value extracted from a Set-Cookie response (no logging). */
export function sessionCookieFrom(response: Response): string | null {
  const cookie = response.headers
    .getSetCookie()
    .find((c) => /(^|__Secure-)psa\.session_token=/.test(c));
  return cookie ? cookie.split(";")[0] : null;
}
