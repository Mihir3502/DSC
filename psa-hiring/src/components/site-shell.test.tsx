import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SiteShell } from "./site-shell";

function renderShell() {
  return render(
    <SiteShell>
      <h1>TEST page heading</h1>
    </SiteShell>,
  );
}

describe("SiteShell", () => {
  it("provides banner, main, and contentinfo landmarks around the content", () => {
    renderShell();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toHaveTextContent(
      "Do not enter real personal information.",
    );
    const main = screen.getByRole("main");
    expect(main).toContainElement(
      screen.getByRole("heading", { level: 1, name: "TEST page heading" }),
    );
  });

  it("makes the skip link the first keyboard stop and targets the main landmark", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.tab();
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveFocus();
    const main = screen.getByRole("main");
    expect(skip).toHaveAttribute("href", `#${main.id}`);
    // tabIndex -1 lets the skip link move focus to main without adding a tab stop.
    expect(main).toHaveAttribute("tabindex", "-1");

    await user.tab();
    expect(
      screen.getByRole("link", { name: "PSA Workforce Hiring System" }),
    ).toHaveFocus();
  });

  it("links the product name back to the public home page", () => {
    renderShell();
    expect(
      screen.getByRole("link", { name: "PSA Workforce Hiring System" }),
    ).toHaveAttribute("href", "/");
  });
});
