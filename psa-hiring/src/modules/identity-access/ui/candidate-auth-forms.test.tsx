import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChangePasswordForm,
  RecoverForm,
  RegisterForm,
  ResetPasswordForm,
  SignInForm,
  VerifyEmailForm,
} from "./candidate-auth-forms";
import type { AuthFormAction, AuthFormState } from "./form-state";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown>) => (
    <a href={href as string} {...rest}>
      {children as React.ReactNode}
    </a>
  ),
}));

const resetToken = "AbCdEfGhIjKlMnOpQrStUvWx";
const invitation = "TESTinvitationCapability0123456789abcdefghij";

function action(result: AuthFormState) {
  return vi.fn<AuthFormAction>(async () => result);
}

const idle: AuthFormState = { status: "idle" };

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("RegisterForm", () => {
  it("labels every field, sets autocomplete, and allows paste-friendly passwords", async () => {
    render(<RegisterForm action={action(idle)} publicIntent="PUBLIC.intent" />);
    const email = await screen.findByLabelText("Email address");
    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("autocomplete", "email");
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(password).toHaveAccessibleDescription(/at least 12 characters/);
    expect(password).not.toHaveAttribute("maxlength");
    expect(password).not.toHaveAttribute("onpaste");
    expect(screen.getByLabelText("Confirm password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    expect(document.querySelector('input[name="intentToken"]')).toHaveValue(
      "PUBLIC.intent",
    );
    // No account type, status, role, or other staff fields are rendered.
    expect(
      document.querySelectorAll('input:not([type="hidden"])'),
    ).toHaveLength(3);
  });

  it("takes an invitation from the fragment and removes it from the URL first", async () => {
    window.history.replaceState(null, "", `/register#intent=${invitation}`);
    render(<RegisterForm action={action(idle)} publicIntent="PUBLIC.intent" />);
    await screen.findByLabelText("Email address");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(invitation);
    expect(document.querySelector('input[name="intentToken"]')).toHaveValue(
      invitation,
    );
    expect(screen.getByText(/registering from an invitation/)).toBeVisible();
  });

  it("moves focus to the error summary and links field errors", async () => {
    const user = userEvent.setup();
    const submit = action({
      status: "error",
      message: "Check the highlighted fields and try again.",
      fieldErrors: {
        email: "Enter an email address in the format name@example.com.",
        passwordConfirmation: "The passwords do not match.",
      },
      attempt: 1,
    });
    render(<RegisterForm action={submit} publicIntent="PUBLIC.intent" />);
    await user.click(
      await screen.findByRole("button", { name: "Create account" }),
    );
    const summary = await screen.findByRole("alert");
    await waitFor(() => expect(summary).toHaveFocus());
    expect(summary).toHaveTextContent("There is a problem");
    const email = screen.getByLabelText("Email address");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription(/Error: Enter an email/);
    expect(
      screen.getByLabelText("Confirm password"),
    ).toHaveAccessibleDescription(/do not match/);
  });

  it("shows a generic confirmation after submission", async () => {
    const user = userEvent.setup();
    render(
      <RegisterForm
        action={action({
          status: "success",
          message:
            "If this email address can be used to register, we sent it a code.",
        })}
        publicIntent="PUBLIC.intent"
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Create account" }),
    );
    const panel = await screen.findByRole("status");
    expect(panel).toHaveTextContent("Check your email");
    expect(
      screen.getByRole("link", { name: "Enter your verification code" }),
    ).toHaveAttribute("href", "/verify-email");
  });
});

describe("SignInForm", () => {
  it("uses current-password autocomplete, a continuation key, and safe links", () => {
    render(<SignInForm action={action(idle)} next="CANDIDATE_SECURITY" />);
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(document.querySelector('input[name="next"]')).toHaveValue(
      "CANDIDATE_SECURITY",
    );
    expect(
      screen.getByRole("link", { name: "Forgot your password?" }),
    ).toHaveAttribute("href", "/recover");
  });
});

describe("VerifyEmailForm", () => {
  it("asks for the email and a one-time code", () => {
    render(
      <VerifyEmailForm
        verifyAction={action(idle)}
        resendAction={action(idle)}
        codeLength={8}
      />,
    );
    const code = screen.getByLabelText("Verification code");
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    expect(code).toHaveAccessibleDescription(/8-digit code/);
    expect(
      screen.getByRole("button", { name: "Send a new code" }),
    ).toBeInTheDocument();
  });
});

describe("RecoverForm", () => {
  it("shows the same confirmation for any submitted email", async () => {
    const user = userEvent.setup();
    render(
      <RecoverForm
        action={action({
          status: "success",
          message: "If this email address…",
        })}
      />,
    );
    await user.type(screen.getByLabelText("Email address"), "x@example.test");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Check your email",
    );
  });
});

describe("ResetPasswordForm", () => {
  it("reads the token from the fragment, strips it, and keeps it out of the URL", async () => {
    window.history.replaceState(
      null,
      "",
      `/reset-password#token=${resetToken}`,
    );
    render(<ResetPasswordForm action={action(idle)} />);
    await screen.findByLabelText("New password");
    expect(window.location.href).not.toContain(resetToken);
    expect(document.querySelector('input[name="token"]')).toHaveValue(
      resetToken,
    );
    expect(document.title).not.toContain(resetToken);
  });

  it("shows a safe state when no usable token is present", async () => {
    window.history.replaceState(null, "", "/reset-password?token=leaked");
    render(<ResetPasswordForm action={action(idle)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This link can’t be used",
    );
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });
});

describe("ChangePasswordForm", () => {
  it("requires the current password with correct autocomplete", () => {
    render(<ChangePasswordForm action={action(idle)} />);
    expect(screen.getByLabelText("Current password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(screen.getByLabelText("New password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
  });
});

describe("fragment capture under Strict Mode", () => {
  it("keeps the captured token when effects run twice", async () => {
    const { StrictMode } = await import("react");
    window.history.replaceState(
      null,
      "",
      `/reset-password#token=${resetToken}`,
    );
    render(
      <StrictMode>
        <ResetPasswordForm action={action(idle)} />
      </StrictMode>,
    );
    await screen.findByLabelText("New password");
    expect(window.location.href).not.toContain(resetToken);
    expect(document.querySelector('input[name="token"]')).toHaveValue(
      resetToken,
    );
  });
});
