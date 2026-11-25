// Regression tests for the small first-hour and friction fixes batched in one
// branch: #1030-3, #1043-2/6/8, #1011-2/3/6.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STAYS_IN_BROWSER, appLinkClaims } from "@/lib/android-app-links";
import { inviteTimingLine } from "@/lib/invite-dates";
import { noEmailNotice } from "@/lib/no-email-notice";
import { hasStartPoint, showDriveLine } from "@/lib/start-point";
import { createClientProgress } from "@/lib/create-client-progress";
import { isSearching } from "@/lib/clients-search-state";

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

describe("#1030-3 /settings/team forwards to Settings → Users", () => {
  it("is a client-side alias to /settings/users", () => {
    const f = src("src/routes/_authenticated/settings.team.tsx");
    expect(f).toContain('createFileRoute("/_authenticated/settings/team")');
    expect(f).toContain('to="/settings/users"');
    expect(f).toContain("clientRedirect: true");
  });
  it("stays in the browser list, so no manifest or native claim changes", () => {
    expect(STAYS_IN_BROWSER["/settings/team"]).toBeTruthy();
    expect(appLinkClaims("/settings/team")).toBe(false);
  });
});

describe("#1043-6 the sidebar footer does not flash '?' while the profile loads", () => {
  it("draws a skeleton while loading, not the fallback name", () => {
    const s = src("src/components/AppSidebar.tsx");
    expect(s).toContain("loading: meLoading");
    expect(s).toMatch(/meLoading \? \(\s*[\s\S]*sidebar-account-skeleton[\s\S]*<Skeleton/);
  });
});

describe("#1043-8 pending invite timing", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  it("says when it was sent and when it expires", () => {
    expect(inviteTimingLine("2026-11-24T10:00:00Z", "2026-12-08T10:00:00Z", now)).toBe(
      "Sent Nov 24 · expires Dec 8",
    );
  });
  it("says expired once the date has passed", () => {
    expect(inviteTimingLine("2026-11-01T10:00:00Z", "2026-11-15T10:00:00Z", now)).toBe(
      "Sent Nov 1 · expired Nov 15",
    );
  });
  it("says nothing it does not know", () => {
    expect(inviteTimingLine(null, undefined, now)).toBeNull();
    expect(inviteTimingLine("nope", "", now)).toBeNull();
  });
  it("the invite landing page carries the product logo and legal links", () => {
    const s = src("src/routes/invite.$token.tsx");
    expect(s).toContain('<Logo variant="landscape"');
    expect(s).toContain("/legal/terms");
    expect(s).toContain("/legal/privacy");
  });
});

describe("#1043-2 no-email note only where something would be emailed", () => {
  const base = { emailOptOut: false, primaryEmail: null, activeServiceCount: 1 };
  it("notes it when opted in, no address and an active service", () => {
    expect(noEmailNotice(base)).toMatch(/No email address on file/);
  });
  it("is silent with nothing to email, with an address, or when opted out", () => {
    expect(noEmailNotice({ ...base, activeServiceCount: 0 })).toBeNull();
    expect(noEmailNotice({ ...base, primaryEmail: "a@b.co" })).toBeNull();
    expect(noEmailNotice({ ...base, emailOptOut: true })).toBeNull();
  });
  it("is an info note, not a warning, on the Summary tab", () => {
    const s = src("src/components/client-detail/SummaryTab.tsx");
    expect(s).toMatch(/noEmailNotice\([\s\S]*?alerts\.push\(\{ severity: "info", text: noEmail \}\)/);
    expect(s).not.toContain("Email notifications are enabled but");
  });
});

describe("#1011-2 drive line needs a start point", () => {
  const none = { orgHasLocation: false, staffWithStart: 0, disposalSites: 0 };
  const visit = { travel_km: 91.5, travel_min: 198 };
  it("hides it with no start point, and while unknown", () => {
    expect(hasStartPoint(none)).toBe(false);
    expect(showDriveLine(none, visit)).toBe(false);
    expect(showDriveLine(undefined, visit)).toBe(false);
  });
  it("shows it once the business, a tech or a dump site has a location", () => {
    expect(showDriveLine({ ...none, orgHasLocation: true }, visit)).toBe(true);
    expect(showDriveLine({ ...none, staffWithStart: 1 }, visit)).toBe(true);
    expect(showDriveLine({ ...none, disposalSites: 2 }, visit)).toBe(true);
  });
  it("shows nothing for a visit with no drive figures", () => {
    expect(showDriveLine({ ...none, orgHasLocation: true }, {})).toBe(false);
  });
  it("is applied on the schedule card and in the visit drawer", () => {
    expect(src("src/routes/_authenticated/routes.tsx")).toContain("showDriveLine(useStartPoints()");
    expect(src("src/components/VisitDetailDrawer.tsx")).toContain("showDriveLine(startPoints, v)");
  });
});

describe("#1011-3 Create client progress is only what the request does", () => {
  it("names the client and property always, dogs and plan when sent", () => {
    expect(createClientProgress({ hasDogs: false, hasPlan: false, secondsWaited: 0 }).detail).toBe(
      "Saving the client and the property.",
    );
    expect(createClientProgress({ hasDogs: true, hasPlan: true, secondsWaited: 0 }).detail).toBe(
      "Saving the client, the property, their dogs and the plan and its visits.",
    );
  });
  it("says it is still going after a wait, without inventing steps", () => {
    const d = createClientProgress({ hasDogs: false, hasPlan: true, secondsWaited: 8 }).detail;
    expect(d).toMatch(/^Still saving /);
    expect(d).toMatch(/keep this page open/);
  });
});

describe("#1011-6 client search says Searching…", () => {
  it("is on from the keystroke until the page for that text arrives", () => {
    expect(isSearching({ typed: "zz", searched: "", fetching: false, showingPreviousResults: false })).toBe(true);
    expect(isSearching({ typed: "zz", searched: "zz", fetching: true, showingPreviousResults: true })).toBe(true);
    expect(isSearching({ typed: "zz", searched: "zz", fetching: false, showingPreviousResults: false })).toBe(false);
    expect(isSearching({ typed: " ", searched: "", fetching: false, showingPreviousResults: false })).toBe(false);
  });
  it("the empty state waits for it", () => {
    const s = src("src/routes/_authenticated/clients.index.tsx");
    expect(s).toContain("data-clients-searching");
    expect(s).toContain("!filtered.length && searching ? null");
  });
});
