"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  applicationNextPattern,
  initialBeginDraftState,
  type BeginDraftState,
} from "./application-form-state";

export function BeginApplicationForm({
  action,
  candidacyId,
  commandKey,
  label = "Begin application",
}: {
  action: (
    previous: BeginDraftState,
    formData: FormData,
  ) => Promise<BeginDraftState>;
  candidacyId: string;
  commandKey: string;
  label?: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    action,
    initialBeginDraftState,
  );
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (state.status === "error") alert.current?.focus();
    if (
      state.status === "success" &&
      state.next &&
      applicationNextPattern.test(state.next)
    ) {
      router.push(state.next);
    }
  }, [state, router]);
  return (
    <form action={formAction} className="flex flex-col gap-3">
      {state.status === "error" && state.message ? (
        <p
          ref={alert}
          tabIndex={-1}
          role="alert"
          className="rounded-lg border border-destructive p-4 outline-none"
        >
          {state.message}
        </p>
      ) : null}
      <input type="hidden" name="commandKey" value={commandKey} />
      <input type="hidden" name="candidacyId" value={candidacyId} />
      <div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Starting…" : label}
        </Button>
      </div>
    </form>
  );
}
