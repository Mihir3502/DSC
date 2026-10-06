import { DependencyError } from "@/shared/errors";

// Application-owned email delivery port (packet M1.1 §9.4). M1.1 sends no
// email: the default adapter refuses delivery, and the in-memory capture
// adapter exists only for disposable tests. A Mailpit/SMTP adapter arrives
// with M1.2 candidate registration.

export type VerificationEmail = Readonly<{
  /** Opaque account reference; never the email address. */
  accountRef: string;
  /** Verification link containing the token. Never log it. */
  url: string;
}>;

export interface EmailDeliveryPort {
  sendVerificationEmail(message: VerificationEmail): Promise<void>;
}

/** Default: refuses to send. Nothing leaves the process in M1.1. */
export class RefusingEmailDelivery implements EmailDeliveryPort {
  async sendVerificationEmail(message: VerificationEmail): Promise<void> {
    void message;
    throw new DependencyError();
  }
}

/**
 * Test-only capture adapter. Construction fails outside APP_ENV=test so it
 * can never be wired into local, staging, or production configuration.
 */
export class InMemoryEmailCapture implements EmailDeliveryPort {
  readonly #messages: VerificationEmail[] = [];

  constructor(appEnv: string | undefined = process.env.APP_ENV) {
    if (appEnv !== "test") {
      throw new Error(
        "InMemoryEmailCapture is available only when APP_ENV=test",
      );
    }
  }

  async sendVerificationEmail(message: VerificationEmail): Promise<void> {
    this.#messages.push(Object.freeze({ ...message }));
  }

  /** Latest captured message for an account (test assertions only). */
  latestFor(accountRef: string): VerificationEmail | undefined {
    return this.#messages.filter((m) => m.accountRef === accountRef).at(-1);
  }

  get count(): number {
    return this.#messages.length;
  }
}
