import type { Metadata } from "next";
import { currentRequestHeaders } from "@/app/_auth/auth-messages";
import { queryCandidateHelp } from "@/modules/candidates";
import { refuseAccess } from "@/modules/identity-access/delivery/route-authorization";

// Candidate help (packet M2.3 §12). The wording is code-owned, and contact
// details appear only when the deployment configures approved values.

export const metadata: Metadata = { title: "Help" };
export const dynamic = "force-dynamic";

export default async function CandidateHelpPage() {
  const result = await queryCandidateHelp(await currentRequestHeaders());
  if (result.kind !== "OK") {
    return refuseAccess(
      result.kind === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "NOT_FOUND",
      "CANDIDATE",
    );
  }
  const { agencyName, email, phone } = result.view;
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="text-3xl font-semibold tracking-tight">Help</h1>
      <p>
        Your answers save as you go, so you can leave an application and come
        back to it later. Your home page always shows your next step.
      </p>
      <p>
        When you contact us, include your reference number. It starts with C-.
        Please don&apos;t send Social Security numbers, ID numbers, or medical
        information.
      </p>
      {email || phone ? (
        <section aria-labelledby="contact" className="flex flex-col gap-2">
          <h2 id="contact" className="text-xl font-semibold">
            Contact {agencyName ?? "us"}
          </h2>
          <ul className="flex flex-col gap-1">
            {email ? (
              <li>
                Email:{" "}
                <a
                  href={`mailto:${email}`}
                  className="underline underline-offset-4"
                >
                  {email}
                </a>
              </li>
            ) : null}
            {phone ? (
              <li>
                Phone:{" "}
                <a
                  href={`tel:${phone.replace(/[^0-9+]/g, "")}`}
                  className="underline underline-offset-4"
                >
                  {phone}
                </a>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
