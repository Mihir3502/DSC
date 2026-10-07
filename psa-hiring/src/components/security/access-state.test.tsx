import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import NotFound from "@/app/not-found";
import { AccessState, accessStateKinds } from "./access-state";

// Shared security states (packet M1.5 §19, AC-M1.5-10/11). Accessible
// heading/focus/announcement behavior, fixed safe content, and fixed safe
// destinations only.

const reference = "0b9a7a3e-6a55-4c8e-9a3b-2f1d0c4e5a6b";
const forbidden =
  /candidate|staff member|role|scope|branch|team|sensitivity|owner|permission|policy|exist(s|ed)\b|record id|denied because/i;

describe("AccessState", () => {
  it.each(accessStateKinds)(
    "%s: focused level-1 heading, one announcement, keyboard-reachable safe actions",
    async (kind) => {
      const user = userEvent.setup();
      render(<AccessState kind={kind} reference={reference} />);
      const heading = screen.getByRole("heading", { level: 1 });
      expect(heading).toHaveFocus();
      const announcements =
        kind === "system-error"
          ? screen.getAllByRole("alert")
          : screen.getAllByRole("status");
      expect(announcements).toHaveLength(1);
      const nav = screen.getByRole("navigation", { name: "Next steps" });
      const links = within(nav).getAllByRole("link");
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link.getAttribute("href")).toMatch(/^\/[a-z/-]*$/);
      }
      await user.tab();
      expect(links[0]).toHaveFocus();
    },
  );

  it("never discloses resource, owner, role, scope, or policy in any state", () => {
    for (const kind of accessStateKinds) {
      const { container, unmount } = render(<AccessState kind={kind} />);
      // "Candidate"/"Staff" appear only in the fixed sign-in link labels.
      const text = container
        .textContent!.replace("Candidate sign in", "")
        .replace("Staff sign in", "");
      expect(text, kind).not.toMatch(forbidden);
      unmount();
    }
  });

  it("shows a validated correlation reference only for the system-error state", () => {
    render(<AccessState kind="system-error" reference={reference} />);
    expect(screen.getByText(reference)).toBeInTheDocument();
  });

  it("drops a malformed or injected reference", () => {
    render(<AccessState kind="system-error" reference={"<img src=x>"} />);
    expect(
      screen.getByText("No reference is available for this error."),
    ).toBeInTheDocument();
  });

  it("does not render a reference on non-error states", () => {
    render(<AccessState kind="not-found" reference={reference} />);
    expect(screen.queryByText(reference)).not.toBeInTheDocument();
  });

  it("renders the same safe not-found page for every hidden or unknown route", () => {
    render(<NotFound />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Page not found" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("link", { name: "Go to the home page" }),
    ).toHaveAttribute("href", "/");
  });
});
