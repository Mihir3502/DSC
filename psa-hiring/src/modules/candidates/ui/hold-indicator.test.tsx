import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HoldIndicator } from "./hold-indicator";

describe("hold indicator", () => {
  it("shows nothing without a hold", () => {
    const { container } = render(<HoldIndicator hold={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("states an active hold in words", () => {
    render(<HoldIndicator hold={{ label: "TEST category" }} />);
    expect(screen.getByRole("note")).toHaveTextContent(
      "On hold: TEST category",
    );
  });
});
