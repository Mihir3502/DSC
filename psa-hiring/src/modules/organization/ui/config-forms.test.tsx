import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigForm } from "./config-form";
import type { ConfigFormAction, ConfigFormState } from "./config-form-state";
import { ConfirmCommand } from "./confirm-command";
import { StartApplicationForm } from "./start-application-form";

// M2.1 configuration components (packet M2.1 §16, §19; UI_FLOW §14–§15,
// §17; AC-M2.1-14): labels, hints and errors linked to inputs, a focused
// error summary, preserved input after a stale or invalid submission,
// specific confirmation dialogs with a required reason, and safe success
// navigation.

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

beforeAll(() => {
  // jsdom lacks the modal dialog API; emulate open/close for tests.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(() => {
  push.mockReset();
  refresh.mockReset();
});

const returning =
  (state: ConfigFormState): ConfigFormAction =>
  async (previous) => ({ ...state, attempt: (previous.attempt ?? 0) + 1 });

describe("ConfigForm", () => {
  it("labels every field, links hints, and submits only declared hidden fields", async () => {
    const action = vi.fn(returning({ status: "success", message: "Saved." }));
    render(
      <ConfigForm
        action={action}
        title="Position details"
        submitLabel="Save"
        hidden={{ commandKey: "TEST-key", expectedVersion: "3" }}
        fields={[
          {
            kind: "text",
            name: "code",
            label: "Position code",
            hint: "Stored in capitals.",
          },
          { kind: "textarea", name: "body", label: "Description" },
          {
            kind: "select",
            name: "workerPathsAllowed",
            label: "Worker paths",
            options: [{ value: "W2_ONLY", label: "W-2 employee only" }],
          },
        ]}
      />,
    );
    const code = screen.getByLabelText("Position code");
    expect(code).toHaveAccessibleDescription("Stored in capitals.");
    expect(screen.getByLabelText("Description").tagName).toBe("TEXTAREA");
    await userEvent.type(code, "lex");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const form = action.mock.calls[0]![1] as FormData;
    expect([...form.keys()].sort()).toEqual([
      "body",
      "code",
      "commandKey",
      "expectedVersion",
      "workerPathsAllowed",
    ]);
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
    expect(refresh).toHaveBeenCalled();
  });

  it("focuses the error summary, marks invalid fields, and keeps the typed values", async () => {
    render(
      <ConfigForm
        action={returning({
          status: "error",
          message: "Fix the highlighted fields and try again.",
          fieldErrors: {
            code: "Code: use 2–32 letters, numbers, hyphens, or underscores.",
          },
          values: { code: "bad code!" },
        })}
        title="Position details"
        submitLabel="Save"
        hidden={{ commandKey: "TEST-key" }}
        fields={[{ kind: "text", name: "code", label: "Position code" }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    const code = screen.getByLabelText("Position code");
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(code).toHaveAccessibleDescription(/Error: Code: use 2–32/);
    expect(code).toHaveValue("bad code!");
  });

  it("navigates after a create only to a staff position-administration path", async () => {
    const { unmount } = render(
      <ConfigForm
        action={returning({
          status: "success",
          next: "/staff/admin/positions/00000000-0000-4000-8000-000000000001",
        })}
        title="New"
        submitLabel="Create"
        hidden={{}}
        fields={[]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        "/staff/admin/positions/00000000-0000-4000-8000-000000000001",
      ),
    );
    unmount();
    render(
      <ConfigForm
        action={returning({
          status: "success",
          next: "https://evil.example.test/",
        })}
        title="New"
        submitLabel="Create"
        hidden={{}}
        fields={[]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(push).toHaveBeenCalledTimes(1);
  });
});

describe("ConfirmCommand", () => {
  it("explains the record, result, and consequence and requires a reason before confirming", async () => {
    const action = vi.fn(returning({ status: "success" }));
    render(
      <ConfirmCommand
        action={action}
        label="Close cycle"
        title="Close this hiring cycle?"
        recordLabel="TEST cycle (CYCLE-1)"
        result="Closed: no longer accepting applications"
        consequence="A closed cycle can never reopen."
        reasons={[{ value: "POSITIONS_FILLED", label: "Positions filled" }]}
        hidden={{
          commandKey: "TEST-key",
          targetId: "TEST-id",
          expectedVersion: "4",
        }}
        destructive
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Close cycle" }));
    const dialog = screen.getByRole("dialog", {
      name: "Close this hiring cycle?",
    });
    expect(dialog).toHaveAccessibleDescription(
      /TEST cycle \(CYCLE-1\).*Closed: no longer accepting.*can never reopen/,
    );
    expect(screen.getByLabelText("Reason")).toBeRequired();
    await userEvent.selectOptions(
      screen.getByLabelText("Reason"),
      "POSITIONS_FILLED",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm: Close cycle" }),
    );
    await waitFor(() => expect(action).toHaveBeenCalled());
    const form = action.mock.calls[0]![1] as FormData;
    expect(Object.fromEntries(form)).toEqual({
      commandKey: "TEST-key",
      targetId: "TEST-id",
      expectedVersion: "4",
      reasonCode: "POSITIONS_FILLED",
    });
  });

  it("shows a stale-version refusal inside the dialog", async () => {
    render(
      <ConfirmCommand
        action={returning({
          status: "error",
          message: "This record changed after you opened it.",
        })}
        label="Open cycle"
        title="Open this hiring cycle?"
        recordLabel="TEST"
        result="Open"
        consequence="Applicants can apply."
        reasons={[
          { value: "ROUTINE_CONFIGURATION", label: "Routine configuration" },
        ]}
        hidden={{}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open cycle" }));
    await userEvent.selectOptions(
      screen.getByLabelText("Reason"),
      "ROUTINE_CONFIGURATION",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm: Open cycle" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This record changed",
    );
  });
});

describe("StartApplicationForm", () => {
  it("submits only the public reference and shows a generic refusal", async () => {
    const action = vi.fn(
      returning({
        status: "error",
        message: "This position is no longer accepting applications.",
      }),
    );
    render(<StartApplicationForm action={action} reference="k3m9x2p7q4ad" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Continue to sign in" }),
    );
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect(Object.fromEntries(action.mock.calls[0]![1] as FormData)).toEqual({
      reference: "k3m9x2p7q4ad",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "no longer accepting",
    );
  });
});
