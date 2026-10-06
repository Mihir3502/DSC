"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorSummary, Field, SuccessPanel } from "./form-fields";
import {
  initialAuthFormState,
  type AuthFormAction,
  type AuthFormState,
} from "./form-state";
import { useFragmentCapability } from "./use-fragment-capability";

// Candidate authentication forms (packet M1.2 §14). Each form posts to a
// same-origin server action; no token, password, or code is ever placed in
// a URL, title, or client storage. Password fields allow paste and long
// passphrases, with no composition rules.

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

export function RegisterForm({
  action,
  publicIntent,
}: {
  action: AuthFormAction;
  publicIntent: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState,
  );
  const invitation = useFragmentCapability("intent");

  if (!invitation.ready) {
    return <p role="status">Preparing the registration form…</p>;
  }
  if (state.status === "success") {
    return (
      <SuccessPanel state={state} title="Check your email">
        <p>
          <Link href="/verify-email" className={linkClass}>
            Enter your verification code
          </Link>
        </p>
      </SuccessPanel>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <ErrorSummary state={state} />
      {invitation.value ? (
        <p className="rounded-lg border p-3">
          You are registering from an invitation. Use the email address the
          invitation was sent to.
        </p>
      ) : null}
      <input
        type="hidden"
        name="intentToken"
        value={invitation.value ?? publicIntent}
      />
      <Field
        label="Email address"
        name="email"
        type="email"
        autoComplete="email"
        spellCheck={false}
        required
        defaultValue={state.values?.email}
        error={errorFor(state, "email")}
      />
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
        <SubmitButton pending={pending}>Create account</SubmitButton>
      </div>
      <p>
        Already registered?{" "}
        <Link href="/sign-in" className={linkClass}>
          Sign in
        </Link>
      </p>
    </form>
  );
}

export function SignInForm({
  action,
  next,
}: {
  action: AuthFormAction;
  next?: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState,
  );
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <ErrorSummary state={state} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Field
        label="Email address"
        name="email"
        type="email"
        autoComplete="email"
        spellCheck={false}
        required
        defaultValue={state.values?.email}
        error={errorFor(state, "email")}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        error={errorFor(state, "password")}
      />
      <div>
        <SubmitButton pending={pending}>Sign in</SubmitButton>
      </div>
      <ul className="flex flex-col gap-2">
        <li>
          <Link href="/recover" className={linkClass}>
            Forgot your password?
          </Link>
        </li>
        <li>
          <Link href="/verify-email" className={linkClass}>
            Verify your email address
          </Link>
        </li>
        <li>
          <Link href="/register" className={linkClass}>
            Create a candidate account
          </Link>
        </li>
      </ul>
    </form>
  );
}

export function VerifyEmailForm({
  verifyAction,
  resendAction,
  codeLength,
}: {
  verifyAction: AuthFormAction;
  resendAction: AuthFormAction;
  codeLength: number;
}) {
  const [state, formAction, pending] = useActionState(
    verifyAction,
    initialAuthFormState,
  );
  const [resendState, resendFormAction, resendPending] = useActionState(
    resendAction,
    initialAuthFormState,
  );
  if (state.status === "success") {
    return (
      <SuccessPanel state={state} title="Email verified">
        <p>
          <Link href="/sign-in" className={linkClass}>
            Sign in
          </Link>
        </p>
      </SuccessPanel>
    );
  }
  const email = state.values?.email ?? resendState.values?.email;
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <ErrorSummary state={state} />
      <ErrorSummary state={resendState} />
      {resendState.status === "success" ? (
        <p role="status" className="rounded-lg border p-3">
          {resendState.message}
        </p>
      ) : null}
      <Field
        label="Email address"
        name="email"
        type="email"
        autoComplete="email"
        spellCheck={false}
        required
        defaultValue={email}
        error={errorFor(state, "email") ?? errorFor(resendState, "email")}
      />
      <Field
        label="Verification code"
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={codeLength + 4}
        hint={`Enter the ${codeLength}-digit code from your email.`}
        error={errorFor(state, "code")}
      />
      <div className="flex flex-wrap gap-3">
        <SubmitButton pending={pending}>Verify email</SubmitButton>
        <Button
          type="submit"
          size="lg"
          variant="outline"
          formAction={resendFormAction}
          disabled={resendPending}
        >
          Send a new code
        </Button>
      </div>
    </form>
  );
}

export function RecoverForm({ action }: { action: AuthFormAction }) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState,
  );
  if (state.status === "success") {
    return (
      <SuccessPanel state={state} title="Check your email">
        <p>
          <Link href="/sign-in" className={linkClass}>
            Return to sign in
          </Link>
        </p>
      </SuccessPanel>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <ErrorSummary state={state} />
      <Field
        label="Email address"
        name="email"
        type="email"
        autoComplete="email"
        spellCheck={false}
        required
        defaultValue={state.values?.email}
        error={errorFor(state, "email")}
      />
      <div>
        <SubmitButton pending={pending}>Send reset link</SubmitButton>
      </div>
    </form>
  );
}

export function ResetPasswordForm({ action }: { action: AuthFormAction }) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState,
  );
  const token = useFragmentCapability("token");

  if (!token.ready) return <p role="status">Checking your link…</p>;
  if (state.status === "success") {
    return (
      <SuccessPanel state={state} title="Password changed">
        <p>
          <Link href="/sign-in" className={linkClass}>
            Sign in with your new password
          </Link>
        </p>
      </SuccessPanel>
    );
  }
  if (!token.value) {
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-lg border p-4">
        <h2 className="font-semibold">This link can’t be used</h2>
        <p>
          The link is invalid, has expired, or was already used. You can request
          a new one.
        </p>
        <p>
          <Link href="/recover" className={linkClass}>
            Request a new reset link
          </Link>
        </p>
      </div>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <ErrorSummary state={state} />
      {state.status === "error" && !state.fieldErrors ? (
        <p>
          <Link href="/recover" className={linkClass}>
            Request a new reset link
          </Link>
        </p>
      ) : null}
      <input type="hidden" name="token" value={token.value} />
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        hint={passwordHint}
        error={errorFor(state, "password")}
      />
      <Field
        label="Confirm new password"
        name="passwordConfirmation"
        type="password"
        autoComplete="new-password"
        required
        error={errorFor(state, "passwordConfirmation")}
      />
      <div>
        <SubmitButton pending={pending}>Change password</SubmitButton>
      </div>
    </form>
  );
}

export function ChangePasswordForm({ action }: { action: AuthFormAction }) {
  const [state, formAction, pending] = useActionState(
    action,
    initialAuthFormState,
  );
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <ErrorSummary state={state} />
      {state.status === "success" ? (
        <p role="status" className="rounded-lg border p-3">
          {state.message}
        </p>
      ) : null}
      <Field
        label="Current password"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
        error={errorFor(state, "currentPassword")}
      />
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        hint={passwordHint}
        error={errorFor(state, "password")}
      />
      <Field
        label="Confirm new password"
        name="passwordConfirmation"
        type="password"
        autoComplete="new-password"
        required
        error={errorFor(state, "passwordConfirmation")}
      />
      <div>
        <SubmitButton pending={pending}>Change password</SubmitButton>
      </div>
    </form>
  );
}
