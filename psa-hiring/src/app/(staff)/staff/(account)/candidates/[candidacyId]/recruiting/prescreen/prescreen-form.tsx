"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ConfigErrorSummary,
  useConfigSuccess,
} from "@/modules/organization/ui/config-form";
import {
  initialConfigFormState,
  type ConfigFormAction,
} from "@/modules/organization/ui/config-form-state";

// The checklist answers (packet M3.3 §12). Each item is a labelled group of
// radios, so it works by keyboard and on a phone. Notes are internal and the
// form says so. The server validates every code and result.

type Item = Readonly<{ code: string; label: string; result: string | null }>;

const choices = [
  ["MET", "Met"],
  ["NOT_MET", "Not met"],
  ["NOT_APPLICABLE", "Not applicable"],
] as const;

export function PrescreenForm({
  action,
  candidacyId,
  version,
  commandKey,
  items,
  notes,
}: {
  action: ConfigFormAction;
  candidacyId: string;
  version: number;
  commandKey: string;
  items: readonly Item[];
  notes: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialConfigFormState,
  );
  useConfigSuccess(state);
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      items.flatMap((i) => (i.result ? [[i.code, i.result]] : [])),
    ),
  );
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <ConfigErrorSummary state={state} />
      {state.status === "success" && state.message ? (
        <p role="status" className="rounded-lg border p-3">
          {state.message}
        </p>
      ) : null}
      <input type="hidden" name="commandKey" value={commandKey} />
      <input type="hidden" name="candidacyId" value={candidacyId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <input type="hidden" name="responses" value={JSON.stringify(answers)} />
      {items.map((item, index) => (
        <fieldset
          key={item.code}
          className="flex flex-col gap-2 rounded-lg border p-3"
        >
          <legend className="px-1 font-medium [overflow-wrap:anywhere]">
            {item.label}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {choices.map(([value, label]) => (
              <label
                key={value}
                className="flex min-h-11 items-center gap-2 md:min-h-8"
              >
                <input
                  type="radio"
                  name={`choice${index}`}
                  value={value}
                  checked={answers[item.code] === value}
                  onChange={() =>
                    setAnswers((current) => ({
                      ...current,
                      [item.code]: value,
                    }))
                  }
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="prescreen-notes" className="font-medium">
          Internal notes (the candidate never sees these)
        </label>
        <textarea
          id="prescreen-notes"
          name="internalNotes"
          rows={4}
          maxLength={2000}
          defaultValue={notes ?? ""}
          className="w-full rounded-lg border border-input bg-background p-3"
        />
      </div>
      <div>
        <Button type="submit" disabled={pending} aria-disabled={pending}>
          {pending ? "Saving…" : "Save answers"}
        </Button>
      </div>
    </form>
  );
}
