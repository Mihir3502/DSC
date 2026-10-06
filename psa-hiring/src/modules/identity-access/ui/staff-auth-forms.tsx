"use client";

import Link from "next/link";
import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { ErrorSummary, Field } from "./form-fields";
import {
  initialAuthFormState,
  type AuthFormAction,
  type AuthFormState,
} from "./form-state";
import type {
  BackupCodesState,
  BeginActivationState,
  EnrollmentDisplay,
  StaffFormAction,
} from "./staff-form-state";
import { useFragmentCapability } from "./use-fragment-capability";

// Staff authentication screens (packet M1.3 §16, WCAG 2.2 AA). Each form
// posts to a same-origin server action. One-time values (the setup key/QR
// and backup codes) live only in the state of the step that shows them and
// disappear when that step ends; nothing is written to a URL, title,
// storage, or analytics. Code inputs accept paste and spaces, and the QR
// code always has a manual-key alternative.

const passwordHint =
  "Use at least 12 characters. Long passphrases are welcome, and you can paste from a password manager.";
const linkClass = "font-medium text-primary underline underline-offset-4";

function SubmitButton({
  pending,
  children,
}: {
  pending: boolean;
  children: string;
}) {
  return (
    <Button type="submit" size="lg" disabled={pending} aria-disabled={pending}>
      {pending ? "Please wait…" : children}
    </Button>
  );
}

function errorFor(state: AuthFormState, name: string) {
  return state.status === "error" ? state.fieldErrors?.[name] : undefined;
}

/** Focuses a step heading when the step appears (screen-reader context). */
function StepHeading({ children }: { children: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h2 ref={ref} tabIndex={-1} className="text-xl font-semibold outline-none">
      {children}
    </h2>
  );
}

function TotpField({
  state,
  label = "6-digit code from your authenticator app",
}: {
  state: AuthFormState;
  label?: string;
}) {
  return (
    <Field
      label={label}
      name="code"
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      spellCheck={false}
      maxLength={16}
      required
      hint="Enter the current code. Spaces are ignored, and you can paste it. Codes change every 30 seconds."
      error={errorFor(state, "code")}
    />
  );
}

/** Copy/print/download controls and the one-time list of backup codes. */
export function BackupCodesPanel({ codes }: { codes: readonly string[] }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const listId = useId();
  const text = codes.join("\n");
  return (
    <div className="flex flex-col gap-3">
      <ol
        id={listId}
        aria-label="Backup codes"
        className="grid list-decimal grid-cols-1 gap-x-8 gap-y-1 rounded-lg border p-4 pl-10 font-mono text-lg sm:grid-cols-2"
      >
        {codes.map((code) => (
          <li key={code} className="select-all">
            {code}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied("copied");
            } catch {
              setCopied("failed");
            }
          }}
        >
          Copy all codes
        </Button>
        <Button type="button" variant="outline" onClick={() => window.print()}>
          Print codes
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([`${text}\n`], { type: "text/plain" }),
            );
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "staff-backup-codes.txt";
            anchor.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download as a text file
        </Button>
      </div>
      <p role="status" aria-live="polite" className="text-sm">
        {copied === "copied"
          ? "Codes copied to the clipboard."
          : copied === "failed"
            ? "Copying failed. Select the codes and copy them, or print or download them."
            : ""}
      </p>
    </div>
  );
}

/** The QR code (decorative alternative) and the manual setup key. */
function EnrollmentPanel({ enrollment }: { enrollment: EnrollmentDisplay }) {
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex list-decimal flex-col gap-2 pl-5">
        <li>
          Open an authenticator app on your phone or computer (for example, a
          password manager or authenticator app approved by your agency).
        </li>
        <li>
          Add an account by scanning the QR code, or enter the setup key below
          instead. Choose a time-based code if asked.
        </li>
        <li>Enter the 6-digit code the app shows, and your password.</li>
      </ol>
      <div className="flex flex-wrap items-start gap-6">
        <svg
          role="img"
          aria-label="QR code for adding this account to an authenticator app. If you cannot scan it, use the setup key instead."
          viewBox={`0 0 ${enrollment.qrSize} ${enrollment.qrSize}`}
          width={200}
          height={200}
          shapeRendering="crispEdges"
          className="rounded-lg border bg-white"
        >
          <rect width="100%" height="100%" fill="#ffffff" />
          <path d={enrollment.qrPath} fill="#000000" />
        </svg>
        <dl className="flex flex-col gap-2">
          <dt className="font-medium">
            Setup key (enter this if you cannot scan)
          </dt>
          <dd>
            <code className="select-all rounded-md border px-2 py-1 font-mono text-lg tracking-wide break-all">
              {enrollment.manualKey}
            </code>
          </dd>
          <dt className="font-medium">Account name in the app</dt>
          <dd>
            {enrollment.issuer} ({enrollment.accountLabel})
          </dd>
          <dt className="font-medium">Code type</dt>
          <dd>Time-based, 6 digits, every 30 seconds</dd>
        </dl>
      </div>
    </div>
  );
}

function ActivationPasswordStep({
  action,
  invite,
  onStarted,
}: {
  action: StaffFormAction<BeginActivationState>;
  invite: string;
  onStarted: (enrollment: EnrollmentDisplay) => void;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState as BeginActivationState,
  );
  useEffect(() => {
    if (state.status === "success" && state.enrollment) {
      onStarted(state.enrollment);
    }
  }, [state, onStarted]);
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <StepHeading>Step 1 of 3: Create your password</StepHeading>
      <ErrorSummary state={state} />
      <p>
        Your account uses the email address this invitation was sent to. It
        cannot be changed here.
      </p>
      <input type="hidden" name="invite" value={invite} />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        hint={passwordHint}
        error={errorFor(state, "password")}
      />
      <Field
        label="Confirm password"
        name="passwordConfirmation"
        type="password"
        autoComplete="new-password"
        required
        error={errorFor(state, "passwordConfirmation")}
      />
      <div>
        <SubmitButton pending={pending}>Continue</SubmitButton>
      </div>
    </form>
  );
}

function ActivationEnrollStep({
  enrollment,
  action,
  onVerified,
}: {
  enrollment: EnrollmentDisplay;
  action: StaffFormAction<BackupCodesState>;
  onVerified: (codes: readonly string[]) => void;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState as BackupCodesState,
  );
  useEffect(() => {
    if (state.status === "success" && state.backupCodes) {
      onVerified(state.backupCodes);
    }
  }, [state, onVerified]);
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <StepHeading>Step 2 of 3: Set up your authenticator app</StepHeading>
      <ErrorSummary state={state} />
      <p>
        Staff accounts always require a code from an authenticator app in
        addition to your password.
      </p>
      <EnrollmentPanel enrollment={enrollment} />
      <TotpField state={state} />
      <Field
        label="Your new password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        hint="Enter the password you just created to confirm it is you."
        error={errorFor(state, "password")}
      />
      <div>
        <SubmitButton pending={pending}>Verify code</SubmitButton>
      </div>
    </form>
  );
}

function ActivationCodesStep({
  codes,
  action,
}: {
  codes: readonly string[];
  action: AuthFormAction;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState,
  );
  const checkboxId = useId();
  const error = errorFor(state, "saved");
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <StepHeading>Step 3 of 3: Save your backup codes</StepHeading>
      <ErrorSummary state={state} />
      <p>
        If you lose access to your authenticator app, each of these codes lets
        you sign in once. They are shown only now and cannot be viewed again.
        Store them somewhere safe, such as a password manager, or print them.
        Never share them or send them by email.
      </p>
      <BackupCodesPanel codes={codes} />
      <div className="flex items-start gap-3">
        <input
          id={checkboxId}
          type="checkbox"
          name="saved"
          value="saved"
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${checkboxId}-error` : undefined}
          className="mt-1 size-5"
        />
        <label htmlFor={checkboxId}>
          I have saved my backup codes somewhere safe.
        </label>
      </div>
      {error ? (
        <p
          id={`${checkboxId}-error`}
          className="text-sm font-medium text-destructive"
        >
          Error: {error}
        </p>
      ) : null}
      <div>
        <SubmitButton pending={pending}>Finish activation</SubmitButton>
      </div>
    </form>
  );
}

/** Invitation-bound activation: password → authenticator → backup codes. */
export function StaffActivationFlow({
  beginAction,
  verifyAction,
  completeAction,
}: {
  beginAction: StaffFormAction<BeginActivationState>;
  verifyAction: StaffFormAction<BackupCodesState>;
  completeAction: AuthFormAction;
}) {
  const invite = useFragmentCapability("invite");
  const [enrollment, setEnrollment] = useState<EnrollmentDisplay | null>(null);
  const [codes, setCodes] = useState<readonly string[] | null>(null);

  if (!invite.ready) return <p role="status">Preparing activation…</p>;
  if (codes)
    return <ActivationCodesStep codes={codes} action={completeAction} />;
  if (enrollment) {
    return (
      <ActivationEnrollStep
        enrollment={enrollment}
        action={verifyAction}
        onVerified={(next) => {
          // The setup key leaves memory once the code is verified.
          setEnrollment(null);
          setCodes(next);
        }}
      />
    );
  }
  if (!invite.value) {
    return (
      <div role="alert" className="rounded-lg border border-destructive p-4">
        <h2 className="font-semibold">This activation link cannot be used</h2>
        <p>
          Open the link from your most recent invitation email. If it has
          expired, ask your administrator for a new invitation.
        </p>
      </div>
    );
  }
  return (
    <ActivationPasswordStep
      action={beginAction}
      invite={invite.value}
      onStarted={setEnrollment}
    />
  );
}

export function StaffSignInForm({
  action,
  notice,
}: {
  action: AuthFormAction;
  notice?: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState,
  );
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {notice && state.status === "idle" ? (
        <p role="status" className="rounded-lg border p-3">
          {notice}
        </p>
      ) : null}
      <ErrorSummary state={state} />
      <Field
        label="Work email address"
        name="email"
        type="email"
        autoComplete="username"
        spellCheck={false}
        required
        defaultValue={state.values?.email}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <div>
        <SubmitButton pending={pending}>Continue</SubmitButton>
      </div>
      <ul className="flex flex-col gap-2">
        <li>
          <Link href="/staff/recover" className={linkClass}>
            Lost your password or authenticator?
          </Link>
        </li>
        <li>
          <Link href="/sign-in" className={linkClass}>
            Candidate sign-in
          </Link>
        </li>
      </ul>
    </form>
  );
}

export function StaffMfaForm({ action }: { action: AuthFormAction }) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState,
  );
  const [method, setMethod] = useState<"totp" | "backup">("totp");
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <ErrorSummary state={state} />
      {/* Remounted after each submission: React resets form controls to
          their defaults after an action, which would otherwise show one
          method selected while the other method's field is displayed. */}
      <fieldset key={state.attempt ?? 0} className="flex flex-col gap-2">
        <legend className="font-medium">Verification method</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="method"
            value="totp"
            checked={method === "totp"}
            onChange={() => setMethod("totp")}
            className="size-4"
          />
          Authenticator app code
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="method"
            value="backup"
            checked={method === "backup"}
            onChange={() => setMethod("backup")}
            className="size-4"
          />
          One of my backup codes
        </label>
      </fieldset>
      {method === "totp" ? (
        <TotpField state={state} />
      ) : (
        <Field
          key="backup"
          label="Backup code"
          name="code"
          type="text"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          maxLength={32}
          required
          hint="Enter one unused backup code, for example abcde-12345. Each code works once."
          error={errorFor(state, "code")}
        />
      )}
      <div>
        <SubmitButton pending={pending}>Verify and sign in</SubmitButton>
      </div>
      <p>
        <Link href="/staff/sign-in" className={linkClass}>
          Start sign-in again
        </Link>
      </p>
    </form>
  );
}

export function StaffReauthenticateForm({
  action,
  purpose,
}: {
  action: AuthFormAction;
  purpose: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState,
  );
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <ErrorSummary state={state} />
      <input type="hidden" name="purpose" value={purpose} />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <TotpField state={state} />
      <div>
        <SubmitButton pending={pending}>Confirm it is you</SubmitButton>
      </div>
      <p>
        <Link href="/staff/security" className={linkClass}>
          Cancel and return to account security
        </Link>
      </p>
    </form>
  );
}

/** Backup-code regeneration with an inline password + TOTP step-up. */
export function RegenerateBackupCodesForm({
  action,
}: {
  action: StaffFormAction<BackupCodesState>;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState as BackupCodesState,
  );
  const [dismissed, setDismissed] = useState(false);
  if (state.status === "success" && state.backupCodes && !dismissed) {
    return (
      <div className="flex flex-col gap-4">
        <StepHeading>Your new backup codes</StepHeading>
        <p>
          Every earlier backup code has stopped working. These codes are shown
          only now; save them before you leave this page.
        </p>
        <BackupCodesPanel codes={state.backupCodes} />
        <div>
          <Button type="button" size="lg" onClick={() => setDismissed(true)}>
            I have saved these codes
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <ErrorSummary state={state} />
      {dismissed ? (
        <p role="status" className="rounded-lg border p-3">
          New backup codes were created. They cannot be shown again.
        </p>
      ) : null}
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <TotpField state={state} />
      <div>
        <SubmitButton pending={pending}>Create new backup codes</SubmitButton>
      </div>
    </form>
  );
}

export function StaffRecoveryForm({
  action,
  reasons,
}: {
  action: AuthFormAction;
  reasons: readonly { value: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState,
  );
  const selectId = useId();
  if (state.status === "success") {
    return (
      <div role="status" className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 className="font-semibold">Request received</h2>
        <p>{state.message}</p>
      </div>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <ErrorSummary state={state} />
      <Field
        label="Work email address"
        name="email"
        type="email"
        autoComplete="username"
        spellCheck={false}
        required
        defaultValue={state.values?.email}
        error={errorFor(state, "email")}
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={selectId} className="font-medium">
          What happened?
        </label>
        <select
          id={selectId}
          name="reason"
          defaultValue="UNSPECIFIED"
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-base"
        >
          {reasons.map((reason) => (
            <option key={reason.value} value={reason.value}>
              {reason.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <SubmitButton pending={pending}>Request help</SubmitButton>
      </div>
    </form>
  );
}

export function StaffPageNotice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-lg border p-3">
      {children}
    </p>
  );
}
