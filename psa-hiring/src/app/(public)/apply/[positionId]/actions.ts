"use server";

import { cookies, headers } from "next/headers";
import { applicationHandoffCookie } from "@/modules/identity-access";
import { safeRedirect } from "@/modules/identity-access/delivery/route-authorization";
import { beginApplicationHandoff } from "@/modules/organization";
import type { ConfigFormState } from "@/modules/organization/ui/config-form-state";
import { parseFormInput } from "@/shared/validation/form-input";
import { formSchemas } from "@/app/_auth/form-schemas";

// Start-application handoff (packet M2.1 §19, ADR-0003 note). Accepts only
// the opening's public reference; the server re-checks that it is
// accepting now (uncached), stores a short-lived signed handoff in an
// HttpOnly, SameSite=Lax cookie, and continues
// to a registered destination. No person, candidacy, or application is
// created, and no internal ID, email, role, or URL is placed in browser
// state.

export async function startApplicationAction(
  previous: ConfigFormState,
  formData: FormData,
): Promise<ConfigFormState> {
  const attempt = (previous.attempt ?? 0) + 1;
  const input = parseFormInput(formData, formSchemas.startApplication);
  if (input.kind === "REJECTED") {
    return {
      status: "error",
      message: "This request could not be completed. Please try again.",
      attempt,
    };
  }
  const result = await beginApplicationHandoff(
    input.values.reference,
    await headers(),
  );
  if (result.kind !== "ISSUED") {
    return {
      status: "error",
      message: "This position is no longer accepting applications.",
      attempt,
    };
  }
  const cookie = applicationHandoffCookie();
  (await cookies()).set(cookie.name, result.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookie.secure,
    // Site-wide path: the candidate sign-in action renders its redirect
    // destination in the same response, so the cookie must reach /sign-in.
    path: "/",
    maxAge: cookie.maxAgeSeconds,
  });
  safeRedirect(result.destination);
}
