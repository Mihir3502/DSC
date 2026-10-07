"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { buttonVariants } from "@/components/ui/button";

// Shared security page states (packet M1.5 §19, UI_FLOW §14). A closed set
// of kinds with fixed plain-language text: no state can show a record,
// owner, candidate, role, scope, branch/team, sensitivity, denial reason,
// or internal policy, because it accepts no such input. Actions link only
// to fixed same-origin destinations. Focus moves to the heading once so
// keyboard and screen-reader users land on the new content.

export const accessStateKinds = [
  "authentication-required",
  "denied",
  "not-found",
  "reauthentication-required",
  "ineligible",
  "system-error",
] as const;
export type AccessStateKind = (typeof accessStateKinds)[number];

type Content = Readonly<{
  title: string;
  message: string;
  actions: readonly Readonly<{ href: string; label: string }>[];
}>;

const home = { href: "/", label: "Go to the home page" } as const;
const candidateSignIn = {
  href: "/sign-in",
  label: "Candidate sign in",
} as const;
const staffSignIn = { href: "/staff/sign-in", label: "Staff sign in" } as const;

const content: Readonly<Record<AccessStateKind, Content>> = {
  "authentication-required": {
    title: "Sign in to continue",
    message: "You need to sign in before you can use this page.",
    actions: [candidateSignIn, staffSignIn],
  },
  denied: {
    title: "You cannot do this",
    message:
      "Your account does not allow this action. If you think this is wrong, contact the agency.",
    actions: [home],
  },
  "not-found": {
    title: "Page not found",
    message:
      "This page does not exist or is not available to you. Check the address, or return to the home page.",
    actions: [home],
  },
  "reauthentication-required": {
    title: "Confirm it is you",
    message:
      "For your security, confirm your password and authenticator code before continuing.",
    actions: [
      { href: "/staff/reauthenticate", label: "Confirm your identity" },
      home,
    ],
  },
  ineligible: {
    title: "Your session has ended",
    message:
      "Your session is no longer valid. Sign in again to continue. If the problem continues, contact the agency.",
    actions: [candidateSignIn, staffSignIn],
  },
  "system-error": {
    title: "Something went wrong",
    message:
      "We could not complete this request. Please try again. If the problem continues, contact support and share the reference below.",
    actions: [home],
  },
};

const referencePattern = /^[A-Za-z0-9-]{1,64}$/;

export function AccessState({
  kind,
  reference,
}: {
  kind: AccessStateKind;
  /** Opaque correlation ID; shown only for the system-error state. */
  reference?: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const state = content[kind];
  const safeReference =
    kind === "system-error" && reference && referencePattern.test(reference)
      ? reference
      : undefined;
  return (
    <section
      aria-labelledby="access-state-heading"
      className="flex max-w-2xl flex-col gap-4"
    >
      <h1
        id="access-state-heading"
        ref={heading}
        tabIndex={-1}
        className="text-3xl font-semibold tracking-tight"
      >
        {state.title}
      </h1>
      <p role={kind === "system-error" ? "alert" : "status"}>{state.message}</p>
      {kind === "system-error" ? (
        <p>
          {safeReference ? (
            <>
              Request reference:{" "}
              <code className="font-mono">{safeReference}</code>
            </>
          ) : (
            "No reference is available for this error."
          )}
        </p>
      ) : null}
      <nav aria-label="Next steps" className="flex flex-wrap gap-3">
        {state.actions.map((action) => (
          <Link
            key={action.href}
            href={action.href}
            prefetch={false}
            className={buttonVariants({ variant: "outline", size: "lg" })}
          >
            {action.label}
          </Link>
        ))}
      </nav>
    </section>
  );
}
