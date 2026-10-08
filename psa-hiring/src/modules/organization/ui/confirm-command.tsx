"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ConfigErrorSummary, useConfigSuccess } from "./config-form";
import {
  initialConfigFormState,
  type ConfigFormAction,
} from "./config-form-state";

// Confirmation dialog for activation, publication, open, close, cancel,
// archive, and retire (packet M2.1 §16, UI_FLOW §15). It names the record,
// the exact command, the resulting status, and the consequence, and
// requires a reason code — never a generic "Are you sure?". A native modal
// <dialog> traps focus and closes on Escape; focus returns to the opener.
// The server re-authorizes and may require a recent-authentication step.

export function ConfirmCommand({
  action,
  label,
  title,
  recordLabel,
  result,
  consequence,
  reasons,
  hidden,
  destructive = false,
}: {
  action: ConfigFormAction;
  /** Button text, e.g. "Publish cycle". */
  label: string;
  title: string;
  /** Safe display reference of the record (code or title). */
  recordLabel: string;
  /** Resulting status in words. */
  result: string;
  consequence: string;
  reasons: readonly Readonly<{ value: string; label: string }>[];
  hidden: Readonly<Record<string, string>>;
  destructive?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialConfigFormState,
  );
  useConfigSuccess(state);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const reasonId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (state.status === "success") dialog.current?.close();
  }, [state.status, state.attempt]);

  return (
    <>
      {/* Irreversible actions are marked in words, not by color alone. */}
      <Button
        ref={opener}
        type="button"
        variant={destructive ? "outline" : "default"}
        onClick={() => dialog.current?.showModal()}
      >
        {label}
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        onClose={() => opener.current?.focus()}
        className="m-auto w-full max-w-lg rounded-xl border bg-background p-6 text-foreground backdrop:bg-black/50"
      >
        <form action={formAction} className="flex flex-col gap-4">
          <h2 id={headingId} className="text-xl font-semibold">
            {title}
          </h2>
          <div id={descriptionId} className="flex flex-col gap-2">
            <p>
              <span className="font-medium">Record:</span> {recordLabel}
            </p>
            <p>
              <span className="font-medium">Result:</span> {result}
            </p>
            <p>{consequence}</p>
            {destructive ? (
              <p className="font-medium">This cannot be undone.</p>
            ) : null}
          </div>
          <ConfigErrorSummary state={state} />
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={reasonId} className="font-medium">
              Reason
            </label>
            <select
              id={reasonId}
              name="reasonCode"
              required
              defaultValue=""
              className="h-10 w-full rounded-lg border border-input bg-background px-3"
            >
              <option value="" disabled>
                Choose a reason
              </option>
              {reasons.map((reason) => (
                <option key={reason.value} value={reason.value}>
                  {reason.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={pending} aria-disabled={pending}>
              {pending ? "Working…" : `Confirm: ${label}`}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
