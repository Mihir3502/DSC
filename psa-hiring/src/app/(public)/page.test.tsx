import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import PublicHomePage from "./page";

describe("public home page", () => {
  it("states the product and its Release 1 boundary", () => {
    render(<PublicHomePage />);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "PSA Workforce Hiring System",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/through Ready for Assignment/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/contains no real personal information/),
    ).toBeInTheDocument();
  });

  it("offers both portals in a labelled navigation reachable by keyboard", async () => {
    const user = userEvent.setup();
    render(<PublicHomePage />);

    const nav = screen.getByRole("navigation", { name: "Portals" });
    const candidate = within(nav).getByRole("link", {
      name: "Candidate Portal",
    });
    const staff = within(nav).getByRole("link", { name: "Staff Portal" });
    expect(candidate).toHaveAttribute("href", "/candidate");
    expect(staff).toHaveAttribute("href", "/staff");

    await user.tab();
    expect(candidate).toHaveFocus();
    await user.tab();
    expect(staff).toHaveFocus();
  });

  it("collects no information: no form or text input is rendered", () => {
    const { container } = render(<PublicHomePage />);
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
