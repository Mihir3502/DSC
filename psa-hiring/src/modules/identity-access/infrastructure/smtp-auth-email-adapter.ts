import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import type { AuthEmailTransport, RenderedAuthEmail } from "./auth-email";

// Local-only SMTP transport for the Docker Compose Mailpit service (packet
// M1.2 §8.2). Mailpit has no relay, so nothing reaches real recipients. The
// host must be loopback; auth-env refuses this transport in staging and
// production. No authentication, no TLS, no transport logging.

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackSmtpHost(host: string): boolean {
  return loopbackHosts.has(host.replace(/^\[|\]$/g, "").toLowerCase());
}

export type LocalSmtpSettings = Readonly<{
  host: string;
  port: number;
  from: string;
}>;

export class LocalSmtpEmailTransport implements AuthEmailTransport {
  readonly kind = "smtp-local" as const;
  readonly #transporter: Transporter;
  readonly #from: string;

  constructor(settings: LocalSmtpSettings) {
    if (!isLoopbackSmtpHost(settings.host)) {
      throw new Error("the local SMTP transport accepts loopback hosts only");
    }
    this.#from = settings.from;
    this.#transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: false,
      ignoreTLS: true,
      logger: false,
      debug: false,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
  }

  async deliver(email: RenderedAuthEmail): Promise<void> {
    await this.#transporter.sendMail({
      from: this.#from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: { "X-PSA-Template": email.template },
    });
  }
}
