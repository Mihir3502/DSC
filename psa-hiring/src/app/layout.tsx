import type { Metadata } from "next";
import "./globals.css";
import { SiteShell } from "@/components/site-shell";

export const metadata: Metadata = {
  title: {
    default: "PSA Workforce Hiring System",
    template: "%s · PSA Workforce Hiring System",
  },
  description:
    "Hiring and compliance-readiness workflow for a private-pay Personal Services Agency, from candidate intake through Ready for Assignment.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <SiteShell>{children}</SiteShell>
      </body>
    </html>
  );
}
