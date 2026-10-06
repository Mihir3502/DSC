import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "../e2e/support/fixtures";

// Automated axe scans for the foundation routes. Serious/critical violations
// fail; lower-impact findings are reported as annotations. No rules are
// disabled. Automated scanning does not replace manual review.

const blocking = new Set(["serious", "critical"]);

for (const path of ["/", "/candidate", "/staff"]) {
  test(
    `${path} has no serious or critical axe violations`,
    { tag: "@critical" },
    async ({ page }, testInfo) => {
      await page.goto(path);
      await expect(page.getByRole("main")).toBeVisible();

      const results = await new AxeBuilder({ page })
        .withTags([
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22aa",
          "best-practice",
        ])
        .analyze();

      const summary = results.violations.map(
        (v) =>
          `${v.impact ?? "unknown"} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      );
      for (const line of summary) {
        testInfo.annotations.push({ type: "axe", description: line });
      }
      const failures = results.violations.filter((v) =>
        blocking.has(v.impact ?? ""),
      );
      expect(
        failures.map((v) => `${v.impact} ${v.id} (${v.nodes.length} node(s))`),
        "serious/critical axe violations",
      ).toEqual([]);
    },
  );
}
