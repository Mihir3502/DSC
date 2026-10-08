"use client";

import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import {
  configNextPattern,
  initialConfigFormState,
  type ConfigFormAction,
  type ConfigFormState,
} from "./config-form-state";

// Accessible configuration form (packet M2.1 §16, UI_FLOW §14/§17, WCAG
// 2.2 AA): visible labels, hints and errors linked by aria-describedby, an
// error summary that receives focus, polite success status, preserved
// input after a validation or stale-version error, and no meaning carried
// by color alone. Hidden fields carry only the server-issued command key
// and the record reference/version the server rendered.

const inputClass =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20";

export type FieldDef =
  | Readonly<{
      kind: "text" | "datetime-local";
      name: string;
      label: string;
      hint?: string;
      defaultValue?: string;
      maxLength?: number;
      required?: boolean;
      readOnly?: boolean;
      autoComplete?: string;
    }>
  | Readonly<{
      kind: "textarea";
      name: string;
      label: string;
      hint?: string;
      defaultValue?: string;
      maxLength?: number;
      rows?: number;
      required?: boolean;
    }>
  | Readonly<{
      kind: "select";
      name: string;
      label: string;
      hint?: string;
      defaultValue?: string;
      options: readonly Readonly<{ value: string; label: string }>[];
      required?: boolean;
    }>
  | Readonly<{
      kind: "checkbox";
      name: string;
      label: string;
      hint?: string;
      defaultChecked?: boolean;
    }>;

function FieldControl({
  field,
  state,
}: {
  field: FieldDef;
  state: ConfigFormState;
}) {
  const id = useId();
  const hintId = field.hint ? `${id}-hint` : undefined;
  const error = state.fieldErrors?.[field.name];
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const submitted = state.values?.[field.name];
  const common = {
    id,
    name: field.name,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
  } as const;
  const labelEl = (
    <label htmlFor={id} className="font-medium">
      {field.label}
    </label>
  );
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

  if (field.kind === "checkbox") {
    const checked =
      state.values !== undefined
        ? submitted === "yes"
        : (field.defaultChecked ?? false);
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <input
            {...common}
            type="checkbox"
            value="yes"
            defaultChecked={checked}
            className="mt-1 size-4"
          />
          {labelEl}
        </div>
        {hint}
        {errorEl}
      </div>
    );
  }

  const value = submitted ?? field.defaultValue ?? "";
  return (
    <div className="flex flex-col gap-1.5">
      {labelEl}
      {hint}
      {errorEl}
      {field.kind === "textarea" ? (
        <textarea
          {...common}
          defaultValue={value}
          maxLength={field.maxLength}
          rows={field.rows ?? 8}
          required={field.required}
          className={inputClass}
        />
      ) : field.kind === "select" ? (
        <select
          {...common}
          defaultValue={value}
          required={field.required}
          className={`${inputClass} h-10`}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          {...common}
          type={field.kind}
          defaultValue={value}
          maxLength={field.kind === "text" ? field.maxLength : undefined}
          required={field.required}
          readOnly={field.readOnly}
          autoComplete={field.autoComplete ?? "off"}
          className={`${inputClass} h-10`}
        />
      )}
    </div>
  );
}

/** Error summary that receives focus after each failed submission. */
export function ConfigErrorSummary({ state }: { state: ConfigFormState }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status === "error") ref.current?.focus();
  }, [state.status, state.attempt]);
  if (state.status !== "error" || !state.message) return null;
  const fieldMessages = Object.values(state.fieldErrors ?? {});
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="rounded-lg border border-destructive p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <h3 className="font-semibold">There is a problem</h3>
      <p>{state.message}</p>
      {fieldMessages.length > 0 ? (
        <ul className="mt-2 list-disc pl-5">
          {fieldMessages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** After success: open the created record, or refresh the current page. */
export function useConfigSuccess(state: ConfigFormState) {
  const router = useRouter();
  useEffect(() => {
    if (state.status !== "success") return;
    if (state.next && configNextPattern.test(state.next)) {
      router.push(state.next);
    } else {
      router.refresh();
    }
  }, [state.status, state.attempt, state.next, router]);
}

export function ConfigForm({
  action,
  title,
  fields,
  hidden,
  submitLabel,
  children,
}: {
  action: ConfigFormAction;
  title: string;
  fields: readonly FieldDef[];
  hidden: Readonly<Record<string, string>>;
  submitLabel: string;
  children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialConfigFormState,
  );
  useConfigSuccess(state);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
      <ConfigErrorSummary state={state} />
      {state.status === "success" && state.message ? (
        <p role="status" className="rounded-lg border p-3">
          {state.message}
        </p>
      ) : null}
      <form action={formAction} noValidate className="flex flex-col gap-4">
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {fields.map((field) => (
          <FieldControl key={field.name} field={field} state={state} />
        ))}
        <div>
          <Button type="submit" disabled={pending} aria-disabled={pending}>
            {pending ? "Saving…" : submitLabel}
          </Button>
        </div>
      </form>
    </section>
  );
}
