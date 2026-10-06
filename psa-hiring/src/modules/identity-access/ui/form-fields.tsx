"use client";

import {
  useEffect,
  useId,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import type { AuthFormState } from "./form-state";

// Accessible form building blocks for candidate authentication (packet
// M1.2 §14, WCAG 2.2 AA): visible labels, hints and errors linked through
// aria-describedby, an error summary that receives focus, status messages
// announced politely, and meaning never carried by color alone.

const inputClass =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20";

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  name: string;
  hint?: string;
  error?: string;
};

export function Field({ label, name, hint, error, ...input }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm font-medium text-destructive">
          Error: {error}
        </p>
      ) : null}
      <input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={inputClass}
        {...input}
      />
    </div>
  );
}

/**
 * Error summary: receives focus after each failed submission so keyboard
 * and screen-reader users land on it.
 */
export function ErrorSummary({ state }: { state: AuthFormState }) {
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
      <h2 className="font-semibold">There is a problem</h2>
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

/** Success/confirmation panel, focused when it appears. */
export function SuccessPanel({
  state,
  title,
  children,
}: {
  state: AuthFormState;
  title: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status === "success") ref.current?.focus();
  }, [state.status, state.attempt]);
  if (state.status !== "success") return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      className="flex flex-col gap-2 rounded-lg border p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <h2 className="font-semibold">{title}</h2>
      {state.message ? <p>{state.message}</p> : null}
      {children}
    </div>
  );
}
