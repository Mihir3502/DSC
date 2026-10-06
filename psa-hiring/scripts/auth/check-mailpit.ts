import { randomBytes } from "node:crypto";
import { createLogger } from "../../src/shared/logging";
import {
  AuthEmailDispatcher,
  authEmailTemplates,
  type AuthEmailMessage,
} from "../../src/modules/identity-access/infrastructure/auth-email";
import { LocalSmtpEmailTransport } from "../../src/modules/identity-access/infrastructure/smtp-auth-email-adapter";
import { runScript } from "../db/lib/tooling";

// Local-only Mailpit integration check (packet M1.2 §8.2, §16.5): sends each
// supported auth template through the real local SMTP transport and the
// asynchronous dispatcher to the Compose Mailpit service, then confirms
// through Mailpit's local API that every template arrived with the expected
// subject and no remote content. Synthetic recipient and values only.
//
//   pnpm infra:up && pnpm auth:mailpit:check

const smtpHost = process.env.SMTP_HOST ?? "127.0.0.1";
const smtpPort = Number(process.env.SMTP_PORT ?? 1025);
const apiBase = `http://${smtpHost}:${process.env.MAILPIT_UI_HOST_PORT ?? 8025}`;

type MailpitList = {
  messages: { ID: string; Subject: string; To: { Address: string }[] }[];
};

void runScript("auth:mailpit:check", async () => {
  if (process.env.APP_ENV && process.env.APP_ENV !== "local") {
    throw new Error("auth:mailpit:check runs only for local development");
  }
  const to = `test.mailpit.${randomBytes(4).toString("hex")}@example.test`;
  const transport = new LocalSmtpEmailTransport({
    host: smtpHost,
    port: smtpPort,
    from: process.env.SMTP_FROM ?? "no-reply@example.test",
  });
  const dispatcher = new AuthEmailDispatcher(
    transport,
    "http://localhost:3000",
    createLogger(),
  );
  const messages: AuthEmailMessage[] = [
    {
      template: "EMAIL_VERIFICATION_CODE",
      to,
      code: "12345678",
      expiresInMinutes: 10,
    },
    {
      template: "PASSWORD_RESET",
      to,
      token: "TESTmailpitCheckToken000",
      expiresInMinutes: 30,
    },
    { template: "PASSWORD_CHANGED", to },
    // M1.3 staff templates (synthetic capability; never a real invitation).
    {
      template: "STAFF_INVITATION",
      to,
      token: randomBytes(32).toString("base64url"),
      purpose: "STAFF_ACTIVATION",
      expiresInMinutes: 4320,
    },
    { template: "STAFF_SECURITY_NOTICE", to, notice: "PASSWORD_CHANGED" },
  ];
  for (const message of messages) dispatcher.enqueue(message);
  await dispatcher.idle();

  const deadline = Date.now() + 10_000;
  let found: MailpitList["messages"] = [];
  while (Date.now() < deadline) {
    const response = await fetch(
      `${apiBase}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    if (!response.ok)
      throw new Error(`Mailpit API returned ${response.status}`);
    found = ((await response.json()) as MailpitList).messages;
    if (found.length >= messages.length) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (found.length !== authEmailTemplates.length) {
    throw new Error(
      `expected ${authEmailTemplates.length} messages in Mailpit, found ${found.length}`,
    );
  }
  for (const message of found) {
    const detail = (await (
      await fetch(`${apiBase}/api/v1/message/${message.ID}`)
    ).json()) as { HTML: string; Text: string };
    if (/<img|<script|https?:\/\/(?!localhost:3000\/)/i.test(detail.HTML)) {
      throw new Error(`unexpected remote content in "${message.Subject}"`);
    }
  }
  console.log(
    `auth:mailpit:check passed: ${found
      .map((m) => `"${m.Subject}"`)
      .sort()
      .join(", ")} received by Mailpit for a synthetic recipient.`,
  );
});
