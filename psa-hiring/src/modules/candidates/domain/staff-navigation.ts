// Staff menu (UI_FLOW §8). Only screens that exist today, and only for people
// whose permissions allow them. It's a convenience, never authority: every page
// and action authorizes again. Later screens join when their milestones build
// them, so the menu never holds a dead link.

export type StaffMenuEntry = Readonly<{
  key: string;
  label: string;
  href: string;
}>;

export type StaffMenuFacts = Readonly<{
  workQueue: boolean;
  addCandidate: boolean;
  submittedApplications: boolean;
  positions: boolean;
  duplicates: boolean;
}>;

export function staffNavigation(
  facts: StaffMenuFacts,
): readonly StaffMenuEntry[] {
  const entries: StaffMenuEntry[] = [];
  if (facts.workQueue) {
    entries.push(
      { key: "dashboard", label: "Dashboard", href: "/staff" },
      { key: "work", label: "Work Queue", href: "/staff/work" },
    );
  }
  if (facts.addCandidate) {
    entries.push({
      key: "add-candidate",
      label: "Add Candidate",
      href: "/staff/candidates/new",
    });
  }
  if (facts.submittedApplications) {
    entries.push({
      key: "submitted",
      label: "Submitted Applications",
      href: "/staff/candidates/submitted",
    });
  }
  if (facts.positions) {
    entries.push({
      key: "positions",
      label: "Positions",
      href: "/staff/admin/positions",
    });
  }
  if (facts.duplicates) {
    entries.push({
      key: "duplicates",
      label: "Possible Duplicates",
      href: "/staff/candidates/duplicates",
    });
  }
  entries.push({ key: "security", label: "Security", href: "/staff/security" });
  return entries;
}
