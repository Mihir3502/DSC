import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { RequestReferenceProvider } from "@/components/request-reference";
import { SiteShell } from "@/components/site-shell";
import {
  CORRELATION_HEADER,
  isValidCorrelationId,
} from "@/shared/logging/correlation";

export const metadata: Metadata = {
  title: {
    default: "PSA Workforce Hiring System",
    template: "%s · PSA Workforce Hiring System",
  },
  description:
    "Hiring and compliance-readiness workflow for a private-pay Personal Services Agency, from candidate intake through Ready for Assignment.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Set by src/proxy.ts for every page request; used only as the request
  // reference shown by the error boundary.
  const forwarded = (await headers()).get(CORRELATION_HEADER);
  const correlationId = isValidCorrelationId(forwarded) ? forwarded : undefined;
  return (
    <html lang="en">
      <body>
        <RequestReferenceProvider value={correlationId}>
          <SiteShell>{children}</SiteShell>
        </RequestReferenceProvider>
      </body>
    </html>
  );
}
