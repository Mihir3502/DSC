import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RequestReferenceProvider } from "@/components/request-reference";
import {
  buildCanaryError,
  findCanaryCategories,
} from "../../tests/fixtures/canaries";
import RouteError from "./error";

const correlationId = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";

function renderBoundary(retry = vi.fn()) {
  const error = Object.assign(buildCanaryError(), { digest: "TESTDIGEST123" });
  const view = render(
    <RequestReferenceProvider value={correlationId}>
      <RouteError error={error} retry={retry} />
    </RequestReferenceProvider>,
  );
  return { ...view, retry };
}

describe("route error boundary (src/app/error.tsx)", () => {
  it("shows generic guidance and the page request reference", () => {
    renderBoundary();
    expect(
      screen.getByRole("heading", { level: 1, name: "Something went wrong" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Request reference:/)).toHaveTextContent(
      correlationId,
    );
  });

  it("renders no error message, stack, cause, digest, or name", () => {
    const { container } = renderBoundary();
    const text = container.textContent ?? "";
    expect(findCanaryCategories(text + container.innerHTML)).toEqual([]);
    for (const leak of ["TESTDIGEST123", "Error:", "/srv/", "digest"]) {
      expect(text.includes(leak), `rendered "${leak}"`).toBe(false);
    }
  });

  it("retries via keyboard", async () => {
    const user = userEvent.setup();
    const { retry } = renderBoundary();
    await user.tab();
    expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
    await user.keyboard(" ");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("shows no reference when none was provided by the layout", () => {
    render(<RouteError error={new Error("x")} retry={vi.fn()} />);
    expect(
      screen.getByText("No reference is available for this error."),
    ).toBeInTheDocument();
  });
});
