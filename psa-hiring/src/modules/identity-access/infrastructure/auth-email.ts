import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DependencyError } from "@/shared/errors";
import type { AppLogger } from "@/shared/logging";

// Application-owned authentication email port (packet M1.2 §8). Messages are
// typed templates with bounded variables; no caller can supply HTML. Links
// are built from the configured application origin only, never from request
// headers. Delivery is queued off the request path so response timing never
// depends on whether an account exists or an email was sent.

export const authEmailTemplates = [
  "EMAIL_VERIFICATION_CODE",
  "PASSWORD_RESET",
  "PASSWORD_CHANGED",
  "STAFF_INVITATION",
  "STAFF_SECURITY_NOTICE",
] as const;
export type AuthEmailTemplate = (typeof authEmailTemplates)[number];

export type AuthEmailMessage =
  | Readonly<{
      template: "EMAIL_VERIFICATION_CODE";
      to: string;
      code: string;
      expiresInMinutes: number;
    }>
  | Readonly<{
      template: "PASSWORD_RESET";
      to: string;
      /** Single-use reset token; placed only in the link fragment. */
      token: string;
      expiresInMinutes: number;
    }>
  | Readonly<{ template: "PASSWORD_CHANGED"; to: string }>
  | Readonly<{
      template: "STAFF_INVITATION";
      to: string;
      /** Single-use invitation capability; placed only in the link fragment. */
      token: string;
      /** Reenrollment follows an approved administrative MFA reset. */
      purpose: "STAFF_ACTIVATION" | "STAFF_REENROLLMENT";
      expiresInMinutes: number;
    }>
  | Readonly<{
      template: "STAFF_SECURITY_NOTICE";
      to: string;
      notice: "PASSWORD_CHANGED" | "BACKUP_CODES_REGENERATED";
    }>;

export type RenderedAuthEmail = Readonly<{
  template: AuthEmailTemplate;
  to: string;
  subject: string;
  text: string;
  html: string;
}>;

const productName = "PSA Workforce Hiring System";
const supportLine =
  "If you did not request this, you can ignore this message. Contact the agency's hiring office if you need help.";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function boundedMinutes(minutes: number): number {
  return Math.min(Math.max(Math.trunc(minutes), 1), 24 * 60);
}

/** Builds the reset link: fragment only, so the token never reaches a server. */
export function resetPasswordLink(origin: string, token: string): string {
  if (!/^[A-Za-z0-9]{16,128}$/.test(token)) {
    throw new Error("invalid reset token shape");
  }
  return `${new URL(origin).origin}/reset-password#token=${token}`;
}

/**
 * Builds the staff activation link: the capability is in the fragment only,
 * so it never reaches a server log, history entry, or Referer header.
 */
export function staffActivationLink(origin: string, token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("invalid invitation token shape");
  }
  return `${new URL(origin).origin}/staff/activate#invite=${token}`;
}

function linkEmail(lines: {
  before: string[];
  linkText: string;
  link: string;
  after: string[];
}): { text: string; html: string } {
  const text = [...lines.before, lines.link, ...lines.after].join("\n\n");
  const html = `<!doctype html><html lang="en"><body>${lines.before
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("")}<p><a href="${escapeHtml(lines.link)}">${escapeHtml(
    lines.linkText,
  )}</a></p>${lines.after
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("")}</body></html>`;
  return { text, html };
}

function paragraphs(lines: string[]): { text: string; html: string } {
  return {
    text: lines.join("\n\n"),
    html: `<!doctype html><html lang="en"><body>${lines
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join("")}</body></html>`,
  };
}

/** Renders a typed message. Every dynamic value is escaped in HTML. */
export function renderAuthEmail(
  message: AuthEmailMessage,
  origin: string,
): RenderedAuthEmail {
  switch (message.template) {
    case "EMAIL_VERIFICATION_CODE": {
      if (!/^\d{6,10}$/.test(message.code)) {
        throw new Error("invalid verification code shape");
      }
      const minutes = boundedMinutes(message.expiresInMinutes);
      const body = paragraphs([
        `Your ${productName} verification code is: ${message.code}`,
        `Enter this code on the email verification page. It expires in ${minutes} minutes and can be used once.`,
        supportLine,
      ]);
      return Object.freeze({
        template: message.template,
        to: message.to,
        subject: "Your email verification code",
        ...body,
      });
    }
    case "PASSWORD_RESET": {
      const minutes = boundedMinutes(message.expiresInMinutes);
      const link = resetPasswordLink(origin, message.token);
      const text = [
        `A password reset was requested for your ${productName} account.`,
        `Open this link to choose a new password. It expires in ${minutes} minutes and can be used once:`,
        link,
        supportLine,
      ].join("\n\n");
      const html = `<!doctype html><html lang="en"><body><p>${escapeHtml(
        `A password reset was requested for your ${productName} account.`,
      )}</p><p>${escapeHtml(
        `It expires in ${minutes} minutes and can be used once.`,
      )}</p><p><a href="${escapeHtml(link)}">Choose a new password</a></p><p>${escapeHtml(
        supportLine,
      )}</p></body></html>`;
      return Object.freeze({
        template: message.template,
        to: message.to,
        subject: "Reset your password",
        text,
        html,
      });
    }
    case "PASSWORD_CHANGED": {
      const body = paragraphs([
        `The password for your ${productName} account was changed, and other signed-in sessions were ended.`,
        "If you did not make this change, use “Forgot password” on the sign-in page and contact the agency's hiring office.",
      ]);
      return Object.freeze({
        template: message.template,
        to: message.to,
        subject: "Your password was changed",
        ...body,
      });
    }
    case "STAFF_INVITATION": {
      // Generic by design (packet M1.3 §8): no role, branch, candidate data,
      // or internal system detail; no backup codes or authenticator keys.
      const minutes = boundedMinutes(message.expiresInMinutes);
      const reset = message.purpose === "STAFF_REENROLLMENT";
      const body = linkEmail({
        before: [
          reset
            ? `An approved request reset the sign-in security for your ${productName} staff account. Set a new password and set up your authenticator app again before you can sign in.`
            : `You have been invited to activate a ${productName} staff account.`,
          `Open this link to continue. It expires in ${minutes} minutes and can be used once:`,
        ],
        linkText: reset
          ? "Set up sign-in again"
          : "Activate your staff account",
        link: staffActivationLink(origin, message.token),
        after: [
          reset
            ? "If you did not request this, contact your administrator immediately."
            : "If you were not expecting this invitation, you can ignore this message.",
        ],
      });
      return Object.freeze({
        template: message.template,
        to: message.to,
        subject: reset
          ? "Your staff sign-in security was reset"
          : "Activate your staff account",
        ...body,
      });
    }
    case "STAFF_SECURITY_NOTICE": {
      const what =
        message.notice === "PASSWORD_CHANGED"
          ? "The password for your staff account was changed and every signed-in session was ended."
          : "New backup codes were created for your staff account. Earlier backup codes no longer work.";
      const body = paragraphs([
        `${productName}: ${what}`,
        "If you did not make this change, contact your administrator immediately.",
      ]);
      return Object.freeze({
        template: message.template,
        to: message.to,
        subject: "Staff account security change",
        ...body,
      });
    }
  }
}

/** Sends one rendered message. Implementations must not log content. */
export interface AuthEmailTransport {
  readonly kind: "smtp-local" | "capture" | "refuse";
  deliver(email: RenderedAuthEmail): Promise<void>;
}

/** Fire-and-forget port used by auth hooks and application commands. */
export interface AuthEmailPort {
  enqueue(message: AuthEmailMessage): void;
}

/**
 * In-process asynchronous dispatcher: a safe local seam until the
 * production worker/provider decision (deferred, ADR-0003). Rendering and
 * delivery run after the current request continues; failures are logged as
 * codes only.
 */
export class AuthEmailDispatcher implements AuthEmailPort {
  readonly #pending = new Set<Promise<void>>();

  constructor(
    private readonly transport: AuthEmailTransport,
    private readonly origin: string,
    private readonly logger: AppLogger,
  ) {}

  enqueue(message: AuthEmailMessage): void {
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.transport.deliver(renderAuthEmail(message, this.origin)))
      .then(
        () =>
          this.logger.info("auth.email_dispatched", {
            module: "auth",
            action: message.template.toLowerCase(),
            resultCode: this.transport.kind,
          }),
        () =>
          this.logger.warn("auth.email_delivery_failed", {
            module: "auth",
            action: message.template.toLowerCase(),
            errorCode: "DEPENDENCY.UNAVAILABLE",
          }),
      )
      .finally(() => this.#pending.delete(task));
    this.#pending.add(task);
  }

  /** Resolves when queued deliveries have settled (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }
}

/** Default when no local transport is configured: nothing leaves the process. */
export class RefusingEmailTransport implements AuthEmailTransport {
  readonly kind = "refuse" as const;
  async deliver(email: RenderedAuthEmail): Promise<void> {
    void email;
    throw new DependencyError();
  }
}

function assertTestEnvironment(name: string, appEnv: string | undefined) {
  if (appEnv !== "test") {
    throw new Error(`${name} is available only when APP_ENV=test`);
  }
}

/**
 * Test-only in-memory capture. Construction fails outside APP_ENV=test so it
 * can never be wired into local, staging, or production configuration.
 */
export class InMemoryEmailCapture implements AuthEmailTransport {
  readonly kind = "capture" as const;
  readonly #messages: RenderedAuthEmail[] = [];
  readonly #waiters = new Set<() => void>();

  constructor(appEnv: string | undefined = process.env.APP_ENV) {
    assertTestEnvironment("InMemoryEmailCapture", appEnv);
  }

  async deliver(email: RenderedAuthEmail): Promise<void> {
    this.#messages.push(email);
    for (const wake of this.#waiters) wake();
  }

  /** Messages for one recipient and template, oldest first. */
  messagesFor(to: string, template?: AuthEmailTemplate): RenderedAuthEmail[] {
    return this.#messages.filter(
      (m) => m.to === to && (!template || m.template === template),
    );
  }

  latest(to: string, template: AuthEmailTemplate) {
    return this.messagesFor(to, template).at(-1);
  }

  /** Waits (bounded, no fixed sleep) until a matching message exists. */
  async waitFor(
    to: string,
    template: AuthEmailTemplate,
    count = 1,
    timeoutMs = 5_000,
  ): Promise<RenderedAuthEmail> {
    const found = () => this.messagesFor(to, template).length >= count;
    if (!found()) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#waiters.delete(wake);
          reject(new Error(`no ${template} email captured in time`));
        }, timeoutMs);
        const wake = () => {
          if (!found()) return;
          clearTimeout(timer);
          this.#waiters.delete(wake);
          resolve();
        };
        this.#waiters.add(wake);
      });
    }
    return this.latest(to, template)!;
  }

  /** Every captured message (test assertions only). */
  all(): readonly RenderedAuthEmail[] {
    return [...this.#messages];
  }

  get count(): number {
    return this.#messages.length;
  }
}

/**
 * Test-only file capture for browser tests, where the server runs in another
 * process. Writes one JSON file per message (mode 0600) into a directory the
 * test runner owns, outside Playwright report/trace folders.
 */
export class FileEmailCapture implements AuthEmailTransport {
  readonly kind = "capture" as const;

  constructor(
    private readonly directory: string,
    appEnv: string | undefined = process.env.APP_ENV,
  ) {
    assertTestEnvironment("FileEmailCapture", appEnv);
    if (!path.isAbsolute(directory)) {
      throw new Error("FileEmailCapture needs an absolute directory");
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  async deliver(email: RenderedAuthEmail): Promise<void> {
    const name = `${Date.now()}-${randomUUID()}.json`;
    writeFileSync(path.join(this.directory, name), JSON.stringify(email), {
      mode: 0o600,
    });
  }
}
