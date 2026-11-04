"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import type { SaveSectionState } from "./application-form-state";

// One section of the application draft (packet M2.4; UI_FLOW §7.3). Saves
// after a short idle period, on request, and before moving to another
// section. One save runs at a time, each names the version it read, and a
// failed save keeps what the candidate typed. Answers live only in this
// component's memory: nothing goes to browser storage or the URL.

const AUTOSAVE_IDLE_MS = 2_000;

type Value = string | readonly string[];
export type SectionField = Readonly<{
  code: string;
  label: string;
  hint: string | null;
  type: string;
  required: boolean;
  flagged: boolean;
  options: readonly Readonly<{ value: string; label: string }>[];
  value: Value | null;
}>;

type SaveLink = Readonly<{ code: string; title: string }> | null;

const inputClass =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive";
const textMax: Readonly<Record<string, number>> = {
  short_text: 200,
  long_text: 2000,
  email: 200,
  phone: 40,
};
const inputKind: Readonly<Record<string, string>> = {
  short_text: "text",
  date: "date",
  email: "email",
  phone: "tel",
};
const autoComplete: Readonly<Record<string, string>> = {
  email: "off",
  phone: "off",
};

export function ApplicationSectionForm({
  action,
  candidacyId,
  sectionCode,
  initialVersion,
  initialStatus,
  initialSaved,
  fields,
  overviewPath,
  previous,
  next,
}: {
  action: (formData: FormData) => Promise<SaveSectionState>;
  candidacyId: string;
  sectionCode: string;
  initialVersion: number;
  initialStatus: string;
  initialSaved: string | null;
  fields: readonly SectionField[];
  overviewPath: string;
  previous: SaveLink;
  next: SaveLink;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, Value>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.code,
        f.value ?? (f.type === "multi_choice" ? [] : ""),
      ]),
    ),
  );
  const [sectionStatus, setSectionStatus] = useState(initialStatus);
  const [lastSaved, setLastSaved] = useState(initialSaved);
  const [activity, setActivity] = useState<"idle" | "dirty" | "saving">("idle");
  const [problem, setProblem] = useState<Exclude<
    SaveSectionState,
    { status: "saved" }
  > | null>(null);
  const problemRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const conflicted = useRef(false);

  const version = useRef(initialVersion);
  const latest = useRef(values);
  const dirty = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A retry of unchanged answers reuses its key, so it cannot apply twice. */
  const pendingKey = useRef<Readonly<{ body: string; key: string }> | null>(
    null,
  );

  const runSave = useCallback(async (): Promise<boolean> => {
    if (conflicted.current) return false;
    const body = JSON.stringify(latest.current);
    const key =
      pendingKey.current?.body === body
        ? pendingKey.current.key
        : crypto.randomUUID();
    pendingKey.current = { body, key };
    const form = new FormData();
    form.set("commandKey", key);
    form.set("candidacyId", candidacyId);
    form.set("sectionCode", sectionCode);
    form.set("expectedVersion", String(version.current));
    form.set("answers", body);
    dirty.current = false;
    setActivity("saving");
    let result: SaveSectionState;
    try {
      result = await action(form);
    } catch (error) {
      if (isNavigation(error)) throw error;
      dirty.current = true;
      setActivity("dirty");
      setProblem({
        status: "error",
        message:
          "We couldn't save just now. Your answers are still on this page. Check your connection and try again.",
      });
      return false;
    }
    if (result.status === "saved") {
      pendingKey.current = null;
      version.current = result.version;
      setSectionStatus(result.sectionStatus);
      setLastSaved(result.lastSaved);
      setProblem(null);
      setActivity(dirty.current ? "dirty" : "idle");
      return true;
    }
    pendingKey.current = null;
    dirty.current = true;
    if (result.status === "conflict") conflicted.current = true;
    setProblem(result);
    setActivity("dirty");
    return false;
  }, [action, candidacyId, sectionCode]);

  /** Runs one save at a time, then again if answers changed meanwhile. */
  const save = useCallback(async (): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current;
    if (!dirty.current) return true;
    const run = runSave();
    inFlight.current = run;
    try {
      return await run;
    } finally {
      inFlight.current = null;
    }
  }, [runSave]);

  function update(code: string, value: Value) {
    const nextValues = { ...latest.current, [code]: value };
    latest.current = nextValues;
    setValues(nextValues);
    dirty.current = true;
    setActivity("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void save();
    }, AUTOSAVE_IDLE_MS);
  }

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Manual saves and blocked navigation move focus to the problem; a
  // background autosave only announces it, so typing is never interrupted.
  useEffect(() => {
    if (problem && moved.current) {
      problemRef.current?.focus();
      moved.current = false;
    }
  }, [problem]);

  async function saveThenGo(path: string) {
    moved.current = true;
    const ok = dirty.current ? await save() : true;
    if (ok) router.push(path);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    moved.current = true;
    dirty.current = true;
    await save();
  }

  const statusText =
    activity === "saving"
      ? "Saving…"
      : activity === "dirty"
        ? "You have unsaved changes."
        : lastSaved
          ? `All changes saved. Last saved ${lastSaved}.`
          : "Nothing saved yet.";

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <p className="text-sm">
        Section status: <span className="font-medium">{sectionStatus}</span>
      </p>
      {problem ? (
        <div
          ref={problemRef}
          tabIndex={-1}
          role="alert"
          className="rounded-lg border border-destructive p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <h2 className="font-semibold">There is a problem</h2>
          <p>{problem.message}</p>
          {problem.fieldErrors ? (
            <ul className="mt-2 list-disc pl-5">
              {Object.entries(problem.fieldErrors).map(([code, message]) => (
                <li key={code}>
                  <a href={`#field-${code}`} className="underline">
                    {message}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {fields.map((field) => (
        <Field
          key={field.code}
          field={field}
          value={values[field.code] ?? ""}
          error={problem?.fieldErrors?.[field.code]}
          onChange={(value) => update(field.code, value)}
        />
      ))}

      <p role="status" className="text-sm">
        {statusText}
      </p>

      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="lg" disabled={activity === "saving"}>
          Save draft
        </Button>
        {next ? (
          <Button
            type="button"
            size="lg"
            variant="outline"
            className="h-auto min-h-11 max-w-full shrink whitespace-normal py-2 text-left"
            onClick={() => void saveThenGo(`${overviewPath}/${next.code}`)}
          >
            Save and go to {next.title}
          </Button>
        ) : null}
        {previous ? (
          <Button
            type="button"
            size="lg"
            variant="outline"
            className="h-auto min-h-11 max-w-full shrink whitespace-normal py-2 text-left"
            onClick={() => void saveThenGo(`${overviewPath}/${previous.code}`)}
          >
            Save and go back to {previous.title}
          </Button>
        ) : null}
      </div>
      <p>
        <Link
          prefetch={false}
          href={overviewPath}
          className={buttonVariants({ variant: "link" })}
          onClick={(event) => {
            if (dirty.current) {
              event.preventDefault();
              void saveThenGo(overviewPath);
            }
          }}
        >
          Back to application overview
        </Link>
      </p>
    </form>
  );
}

/** Next.js redirects (an expired session) must pass through untouched. */
function isNavigation(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

function Field({
  field,
  value,
  error,
  onChange,
}: {
  field: SectionField;
  value: Value;
  error: string | undefined;
  onChange: (value: Value) => void;
}) {
  const id = `field-${field.code}`;
  const hintId = field.hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const label = (
    <>
      {field.label}
      {field.required ? (
        <span className="font-normal"> (required)</span>
      ) : (
        <span className="font-normal"> (optional)</span>
      )}
    </>
  );
  const flag = field.flagged ? (
    <p className="text-sm font-medium">We asked you to check this answer.</p>
  ) : null;
  const hint = field.hint ? (
    <p id={hintId} className="text-sm text-muted-foreground">
      {field.hint}
    </p>
  ) : null;
  const errorEl = error ? (
    <p id={errorId} className="text-sm font-medium text-destructive">
      Error: {error}
    </p>
  ) : null;

  if (field.type === "multi_choice" || field.type === "single_choice") {
    const multi = field.type === "multi_choice";
    const selected = new Set(multi ? (value as readonly string[]) : [value]);
    return (
      <fieldset
        id={id}
        tabIndex={-1}
        aria-describedby={describedBy}
        className="flex flex-col gap-1.5"
      >
        <legend className="mb-1 font-medium">{label}</legend>
        {flag}
        {hint}
        {errorEl}
        {field.options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-11 items-center gap-3"
          >
            <input
              type={multi ? "checkbox" : "radio"}
              name={field.code}
              value={option.value}
              checked={selected.has(option.value)}
              className="size-5 shrink-0"
              onChange={(event) => {
                if (!multi) return onChange(option.value);
                const current = new Set(value as readonly string[]);
                if (event.target.checked) current.add(option.value);
                else current.delete(option.value);
                onChange(
                  field.options
                    .map((o) => o.value)
                    .filter((v) => current.has(v)),
                );
              }}
            />
            {option.label}
          </label>
        ))}
        {!multi && value !== "" && !field.required ? (
          <div>
            <Button
              type="button"
              variant="link"
              onClick={() => onChange("")}
              aria-label={`Clear answer: ${field.label}`}
            >
              Clear answer
            </Button>
          </div>
        ) : null}
      </fieldset>
    );
  }

  const common = {
    id,
    name: field.code,
    value: value as string,
    maxLength: textMax[field.type],
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    className: inputClass,
    autoComplete: autoComplete[field.type] ?? "off",
  } as const;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {flag}
      {hint}
      {errorEl}
      {field.type === "long_text" ? (
        <textarea
          {...common}
          rows={5}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          {...common}
          type={inputKind[field.type] ?? "text"}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}
