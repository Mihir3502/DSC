"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// Returning an application for correction (packet M2.7 §8, §12). Staff pick
// sections, optionally flag fields inside them, and write what the candidate
// will read. The candidate sees this text, so the form says so; internal notes
// don't belong here. The key stays the same until the server answers.

type Section = Readonly<{
  code: string;
  title: string;
  fields: readonly Readonly<{ code: string; label: string }>[];
}>;

const MAX = 1000;

export function StaffReturnForm({
  action,
  candidacyId,
  version,
  commandKey,
  sections,
  reasons,
}: {
  action: (form: FormData) => Promise<{ ok: boolean; message?: string }>;
  candidacyId: string;
  version: number;
  commandKey: string;
  sections: readonly Section[];
  reasons: Readonly<Record<string, string>>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [attachments, setAttachments] = useState(false);
  const [reason, setReason] = useState("");
  const [instructions, setInstructions] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const alert = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (problem) alert.current?.focus();
  }, [problem]);

  const anything = Object.keys(selected).length > 0 || attachments;
  const ready = anything && reason !== "" && instructions.trim().length > 0;

  function toggleSection(code: string, on: boolean) {
    setSelected((current) => {
      const next = { ...current };
      if (on) next[code] = [];
      else delete next[code];
      return next;
    });
  }

  function toggleField(section: string, field: string, on: boolean) {
    setSelected((current) => ({
      ...current,
      [section]: on
        ? [...(current[section] ?? []), field]
        : (current[section] ?? []).filter((f) => f !== field),
    }));
  }

  async function submit() {
    setBusy(true);
    setProblem(null);
    const data = new FormData();
    data.set("commandKey", commandKey);
    data.set("candidacyId", candidacyId);
    data.set("expectedVersion", String(version));
    data.set("reasonCode", reason);
    data.set("instructions", instructions);
    data.set("selection", JSON.stringify(selected));
    if (attachments) data.set("attachments", "yes");
    try {
      const result = await action(data);
      if (result.ok) {
        setDone(true);
        router.refresh();
        return;
      }
      setConfirming(false);
      setProblem(result.message ?? "This application wasn't returned.");
    } catch (error) {
      const digest = (error as { digest?: unknown } | null)?.digest;
      if (typeof digest === "string" && digest.startsWith("NEXT_")) throw error;
      setConfirming(false);
      setProblem(
        "We couldn't confirm the return. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p role="status" className="rounded-lg border p-4">
        Application returned. The candidate has been asked to correct it.
      </p>
    );
  }

  return (
    <section
      aria-labelledby="return"
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <h2 id="return" className="text-xl font-semibold">
        Return for correction
      </h2>
      {problem ? (
        <p
          ref={alert}
          tabIndex={-1}
          role="alert"
          className="rounded-lg border border-destructive p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {problem}
        </p>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">What should reopen?</legend>
        {sections.map((section) => {
          const on = Object.hasOwn(selected, section.code);
          return (
            <div key={section.code} className="flex flex-col gap-1">
              <label className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-5 shrink-0"
                  checked={on}
                  onChange={(event) =>
                    toggleSection(section.code, event.target.checked)
                  }
                />
                {section.title}
              </label>
              {on ? (
                <fieldset className="ml-8 flex flex-col gap-1">
                  <legend className="text-sm">
                    Optional: flag answers to check in {section.title}
                  </legend>
                  {section.fields.map((field) => (
                    <label
                      key={field.code}
                      className="flex min-h-11 items-center gap-3 [overflow-wrap:anywhere]"
                    >
                      <input
                        type="checkbox"
                        className="size-5 shrink-0"
                        checked={
                          selected[section.code]?.includes(field.code) === true
                        }
                        onChange={(event) =>
                          toggleField(
                            section.code,
                            field.code,
                            event.target.checked,
                          )
                        }
                      />
                      {field.label}
                    </label>
                  ))}
                </fieldset>
              ) : null}
            </div>
          );
        })}
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            className="size-5 shrink-0"
            checked={attachments}
            onChange={(event) => setAttachments(event.target.checked)}
          />
          Attachments
        </label>
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="return-reason" className="font-medium">
          Reason (the candidate sees this)
        </label>
        <select
          id="return-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="min-h-11 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base"
        >
          <option value="">Choose a reason</option>
          {Object.entries(reasons).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="return-instructions" className="font-medium">
          Instructions (the candidate sees this)
        </label>
        <p
          id="return-instructions-hint"
          className="text-sm text-muted-foreground"
        >
          Write what to change, up to {MAX} characters. Don&apos;t include
          internal notes.
        </p>
        <textarea
          id="return-instructions"
          aria-describedby="return-instructions-hint"
          rows={5}
          maxLength={MAX}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          className="w-full rounded-lg border border-input bg-transparent px-3 py-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>
      {confirming ? (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p>
            Return this application? The candidate will be emailed and can
            change what you selected. The submitted version is kept.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="lg"
              className="min-h-11"
              disabled={busy}
              autoFocus
              onClick={() => void submit()}
            >
              {busy ? "Returning…" : "Confirm return"}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep reviewing
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            type="button"
            size="lg"
            className="min-h-11"
            disabled={!ready}
            onClick={() => setConfirming(true)}
          >
            Return for correction
          </Button>
        </div>
      )}
    </section>
  );
}
