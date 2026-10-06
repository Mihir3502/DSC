import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthFormAction, AuthFormState } from "./form-state";
import {
  BackupCodesPanel,
  RegenerateBackupCodesForm,
  StaffActivationFlow,
  StaffMfaForm,
  StaffReauthenticateForm,
  StaffRecoveryForm,
  StaffSignInForm,
} from "./staff-auth-forms";
import type {
  BackupCodesState,
  BeginActivationState,
  EnrollmentDisplay,
  StaffFormAction,
} from "./staff-form-state";

// Staff authentication components (packet M1.3 §16, §17.7): labels,
// focus, announcements, paste, QR/manual-key alternative, one-time code
// display, and no sensitive value after its step.

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown>) => (
    <a href={href as string} {...rest}>
      {children as React.ReactNode}
    </a>
  ),
}));

// Synthetic, clearly fake values (never real secrets).
const invite = "TESTstaffInvitationCapability0123456789abcd";
const enrollment: EnrollmentDisplay = {
  qrPath: "M0 0h1v1h-1zM2 2h1v1h-1z",
  qrSize: 21,
  manualKey: "TEST SEED ABCD EFGH",
  issuer: "PSA Workforce Hiring",
  accountLabel: "t•••@example.test",
};
const codes = Array.from({ length: 10 }, (_, i) => `TEST${i}-CODE${i}`);

function action<S extends AuthFormState>(result: S) {
  return vi.fn<StaffFormAction<S>>(async () => result);
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("StaffActivationFlow", () => {
  it("removes the invitation from the URL and walks password → authenticator → codes", async () => {
    window.history.replaceState(null, "", `/staff/activate#invite=${invite}`);
    const begin = action<BeginActivationState>({
      status: "success",
      enrollment,
      attempt: 1,
    });
    const verify = action<BackupCodesState>({
      status: "success",
      backupCodes: codes,
      attempt: 1,
    });
    const complete = action<AuthFormState>({
      status: "error",
      message: "Check the highlighted fields and try again.",
      fieldErrors: {
        saved:
          "Confirm that you have saved your backup codes before you finish.",
      },
      attempt: 1,
    });
    render(
      <StaffActivationFlow
        beginAction={begin}
        verifyAction={verify}
        completeAction={complete as unknown as AuthFormAction}
      />,
    );
    const heading = await screen.findByRole("heading", { name: /Step 1 of 3/ });
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(invite);
    expect(heading).toHaveFocus();
    expect(document.querySelector('input[name="invite"]')).toHaveValue(invite);
    // The bound email is not editable here.
    expect(screen.queryByLabelText(/email/i)).toBeNull();

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Password"),
      "TEST staff passphrase 1",
    );
    await user.type(
      screen.getByLabelText("Confirm password"),
      "TEST staff passphrase 1",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const step2 = await screen.findByRole("heading", { name: /Step 2 of 3/ });
    expect(step2).toHaveFocus();
    // QR is never the only path: a text setup key is shown with it.
    expect(
      screen.getByRole("img", { name: /use the setup key instead/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("TEST SEED ABCD EFGH")).toBeInTheDocument();
    const code = screen.getByLabelText(
      "6-digit code from your authenticator app",
    );
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    expect(code).toHaveAccessibleDescription(/Spaces are ignored/);
    await user.click(code);
    await user.paste("123 456");
    expect(code).toHaveValue("123 456");
    await user.type(
      screen.getByLabelText("Your new password"),
      "TEST staff passphrase 1",
    );
    await user.click(screen.getByRole("button", { name: "Verify code" }));

    expect(
      await screen.findByRole("heading", { name: /Step 3 of 3/ }),
    ).toHaveFocus();
    // The setup key is gone once the code is verified.
    expect(screen.queryByText("TEST SEED ABCD EFGH")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    const list = screen.getByRole("list", { name: "Backup codes" });
    expect(list.querySelectorAll("li")).toHaveLength(10);

    // Explicit confirmation: the server rejects an unchecked submission.
    await user.click(screen.getByRole("button", { name: "Finish activation" }));
    expect(await screen.findByRole("alert")).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /saved your backup codes/,
    );
    const checkbox = screen.getByLabelText(
      "I have saved my backup codes somewhere safe.",
    );
    expect(checkbox).toHaveAttribute("aria-invalid", "true");
    // Nothing reached browser storage.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("shows a safe error without an invitation fragment", async () => {
    render(
      <StaffActivationFlow
        beginAction={action<BeginActivationState>({ status: "idle" })}
        verifyAction={action<BackupCodesState>({ status: "idle" })}
        completeAction={action<AuthFormState>({ status: "idle" })}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This activation link cannot be used",
    );
    expect(screen.queryByLabelText("Password")).toBeNull();
  });
});

describe("BackupCodesPanel", () => {
  it("offers copy, print, and download without storing the codes", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    render(<BackupCodesPanel codes={codes} />);
    const user = userEvent.setup();
    // userEvent installs its clipboard stub during setup; spy on it after.
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "Copy all codes" }));
    expect(writeText).toHaveBeenCalledWith(codes.join("\n"));
    expect(screen.getByRole("status")).toHaveTextContent("Codes copied");
    await user.click(screen.getByRole("button", { name: "Print codes" }));
    expect(print).toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });
});

describe("StaffSignInForm and StaffMfaForm", () => {
  it("labels the staff sign-in fields and shows a generic error", async () => {
    render(
      <StaffSignInForm
        action={action<AuthFormState>({
          status: "error",
          message: "The email address or password is incorrect.",
          attempt: 1,
        })}
      />,
    );
    expect(screen.getByLabelText("Work email address")).toHaveAttribute(
      "autocomplete",
      "username",
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    // No account-type, trusted-device, or "remember me" control exists.
    expect(screen.queryByRole("checkbox")).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveFocus();
  });

  it("switches between TOTP and a backup code, keeping the selection consistent after errors", async () => {
    render(
      <StaffMfaForm
        action={action<AuthFormState>({
          status: "error",
          message: "Check the highlighted fields and try again.",
          fieldErrors: {
            code: "That backup code is incorrect or was already used.",
          },
          attempt: 1,
        })}
      />,
    );
    const user = userEvent.setup();
    expect(screen.getByLabelText("Authenticator app code")).toBeChecked();
    expect(
      screen.getByLabelText("6-digit code from your authenticator app"),
    ).toBeInTheDocument();
    expect(document.querySelector('input[name="trustDevice"]')).toBeNull();
    await user.click(screen.getByLabelText("One of my backup codes"));
    const backup = screen.getByLabelText("Backup code", { exact: true });
    expect(backup).toHaveAttribute("autocomplete", "off");
    await user.type(backup, "abcde-12345");
    await user.click(
      screen.getByRole("button", { name: "Verify and sign in" }),
    );
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(screen.getByLabelText("One of my backup codes")).toBeChecked(),
    );
    expect(
      screen.getByLabelText("Backup code", { exact: true }),
    ).toHaveAttribute("aria-invalid", "true");
    await user.click(screen.getByLabelText("Authenticator app code"));
    expect(
      screen.getByLabelText("6-digit code from your authenticator app"),
    ).toBeInTheDocument();
  });
});

describe("reauthentication, regeneration, and recovery", () => {
  it("submits only a registry purpose key with password and code", () => {
    render(
      <StaffReauthenticateForm
        action={action<AuthFormState>({ status: "idle" })}
        purpose="CHANGE_PASSWORD"
      />,
    );
    expect(document.querySelector('input[name="purpose"]')).toHaveValue(
      "CHANGE_PASSWORD",
    );
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(
      screen.getByLabelText("6-digit code from your authenticator app"),
    ).toBeInTheDocument();
    // No backup-code option for reauthentication.
    expect(screen.queryByLabelText(/backup/i)).toBeNull();
  });

  it("shows regenerated codes once, then hides them for good", async () => {
    render(
      <RegenerateBackupCodesForm
        action={action<BackupCodesState>({
          status: "success",
          backupCodes: codes,
          attempt: 1,
        })}
      />,
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Create new backup codes" }),
    );
    expect(
      await screen.findByRole("list", { name: "Backup codes" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "I have saved these codes" }),
    );
    expect(screen.queryByRole("list", { name: "Backup codes" })).toBeNull();
    expect(screen.queryByText(codes[0])).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "cannot be shown again",
    );
  });

  it("confirms recovery requests generically", async () => {
    render(
      <StaffRecoveryForm
        action={action<AuthFormState>({
          status: "success",
          message:
            "If this email address belongs to an active staff account, your request was recorded.",
          attempt: 1,
        })}
        reasons={[
          { value: "UNSPECIFIED", label: "Choose a reason (optional)" },
        ]}
      />,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Work email address"),
      "test.staff@example.test",
    );
    await user.click(screen.getByRole("button", { name: "Request help" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      /If this email address belongs/,
    );
  });
});
