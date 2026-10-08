"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { ConfigErrorSummary } from "./config-form";
import {
  initialConfigFormState,
  type ConfigFormAction,
} from "./config-form-state";

// The start-application confirmation (packet M2.1 §19). It submits only
// the opening's public reference; the server re-checks availability and
// continues to candidate sign-in or the candidate application boundary.
// It never submits an application.

export function StartApplicationForm({
  action,
  reference,
}: {
  action: ConfigFormAction;
  reference: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialConfigFormState,
  );
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <ConfigErrorSummary state={state} />
      <input type="hidden" name="reference" value={reference} />
      <div>
        <Button type="submit" disabled={pending} aria-disabled={pending}>
          {pending ? "Continuing…" : "Continue to sign in"}
        </Button>
      </div>
    </form>
  );
}
