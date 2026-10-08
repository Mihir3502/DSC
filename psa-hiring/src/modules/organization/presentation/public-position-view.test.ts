import { describe, expect, it } from "vitest";
import {
  classificationDisclaimer,
  publicDetail,
  publicListItem,
  toBlocks,
  workerPathPublicText,
  type PublicSource,
} from "./public-position-view";

// Public projection shape and content handling (packet M2.1 §17–§18,
// AC-M2.1-10/15): exact keys, plain-text blocks, generic closed state, and
// worker-path wording that never classifies anyone.

const source: PublicSource = {
  publicReference: "k3m9x2p7q4ad",
  publicTitle: "TEST Caregiver",
  summary: "TEST summary.",
  body: "TEST first paragraph\ncontinues here.\n\n- duty one\n* duty two\n\nTEST last.",
  locationLabel: "Testville",
  workerPaths: "W2_AND_CONTRACTOR_ELIGIBLE",
  closesAt: new Date("2026-10-09T21:00:00.000Z"),
  displayTimezone: "America/New_York",
};

describe("public position projections", () => {
  it("builds the list item from public snapshot fields only", () => {
    expect(publicListItem(source)).toEqual({
      reference: "k3m9x2p7q4ad",
      title: "TEST Caregiver",
      summary: "TEST summary.",
      location: "Testville",
      workerPaths: workerPathPublicText.W2_AND_CONTRACTOR_ELIGIBLE,
      closes: "Applications close Oct 9, 2026, 5:00 PM EDT",
    });
  });

  it("splits plain text into paragraphs and lists without interpreting markup", () => {
    expect(toBlocks(source.body)).toEqual([
      { kind: "paragraph", text: "TEST first paragraph continues here." },
      { kind: "list", items: ["duty one", "duty two"] },
      { kind: "paragraph", text: "TEST last." },
    ]);
    // Even if unsafe text ever reached a block, it stays inert data.
    expect(toBlocks("<b>x</b>")).toEqual([
      { kind: "paragraph", text: "<b>x</b>" },
    ]);
  });

  it("describes contractor eligibility without classifying anyone", () => {
    for (const text of Object.values(workerPathPublicText)) {
      expect(text).not.toMatch(/\bis (a )?1099\b|guarantee|classified as/i);
    }
    expect(workerPathPublicText.CONTRACTOR_ELIGIBLE_ONLY).toMatch(
      /after an approved worker-classification review/,
    );
  });

  it("shows the classification disclaimer on accepting detail", () => {
    const detail = publicDetail(source, "ACCEPTING");
    expect(detail.availability === "ACCEPTING" && detail.disclaimer).toBe(
      classificationDisclaimer,
    );
  });

  it("reduces a closed opening to one generic state with no content or reason", () => {
    expect(publicDetail(source, "NO_LONGER_ACCEPTING")).toEqual({
      reference: "k3m9x2p7q4ad",
      availability: "NO_LONGER_ACCEPTING",
    });
  });
});
