import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ErrorFallback } from "./error-fallback";

const reference = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";

describe("ErrorFallback", () => {
  it("shows a focused heading, a single alert message, and the reference", () => {
    render(
      <ErrorFallback
        reference={{ label: "Request reference", value: reference }}
      />,
    );
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Something went wrong",
    });
    expect(heading).toHaveFocus();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /could not complete this request/,
    );
    expect(screen.getByText(reference)).toBeInTheDocument();
    expect(screen.getByText(/Request reference:/)).toBeInTheDocument();
  });

  it("says when no reference is available", () => {
    render(<ErrorFallback />);
    expect(
      screen.getByText("No reference is available for this error."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("runs the retry action from the keyboard", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorFallback onRetry={onRetry} />);
    await user.tab();
    const button = screen.getByRole("button", { name: "Try again" });
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
