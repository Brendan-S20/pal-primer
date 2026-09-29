// From the product review of 2026-09-27, the office visit drawer.
//
// ── 1. A DATE THE WAY THE DATABASE SPELLS IT ─────────────────────────────
//
// The drawer's subtitle printed `v.scheduled_on` as it came back from
// PostgREST: "2026-09-27". Every other date in the drawer, and the toast for
// moving a visit, already went through `formatDay`. The subtitle is the first
// thing read on the drawer and the only line that says WHEN the visit is.
//
// ── 2. THE FUTURE, FILED UNDER THE PAST ──────────────────────────────────
//
// getVisitDetail fetched the client's latest five other visits by date,
// newest first, and the drawer listed them as the visit's history. Visits are
// generated weeks ahead, so for a weekly client the latest five are all still
// to come: the list showed next month's scheduled visits and never the last
// time anybody was actually in the yard. Filtering the same list on the
// client would not have fixed it — the past had already been cut off by the
// shared limit. So it is two queries, split at the organization's today
// (orgToday on organizations.timezone, the rule org-day.ts exists for), each
// with its own limit, and two headings.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(ROOT + p, "utf8");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");

const drawer = codeOnly(read("src/components/VisitDetailDrawer.tsx"));
const server = codeOnly(read("src/lib/visits.functions.ts"));

/** The body of getVisitDetail's handler, up to the next export. */
function visitDetailHandler(): string {
  const start = server.indexOf("export const getVisitDetail");
  expect(start, "getVisitDetail not found").toBeGreaterThan(-1);
  const end = server.indexOf("export const", start + 1);
  return server.slice(start, end === -1 ? undefined : end);
}

describe("the drawer's dates are read as days, not ISO strings", () => {
  it("formats the visit's own date in the subtitle", () => {
    expect(drawer).toMatch(/formatDay\(v\?\.scheduled_on\)/);
  });

  it("renders no scheduled_on raw anywhere in the drawer", () => {
    // `{v?.scheduled_on}` or `{h.scheduled_on}` as a JSX child. A comparison
    // (`moveTo === v?.scheduled_on`) is not a render, and is not matched.
    expect(drawer).not.toMatch(/\{\s*[\w?.]*scheduled_on\s*\}/);
  });
});

describe("past and future are fetched apart, on the org's day", () => {
  const handler = visitDetailHandler();

  it("computes today from the organization's timezone", () => {
    expect(handler).toMatch(/\.from\("organizations"\)[\s\S]*?\.select\("timezone"\)/);
    expect(handler).toMatch(/orgToday\(org\?\.timezone \|\| DEFAULT_ORG_TIMEZONE\)/);
    // Not the server's clock, in any of the spellings it has been written in.
    expect(handler).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  });

  it("asks for the past before today, newest first", () => {
    expect(handler).toMatch(
      /\.lt\("scheduled_on", today\)\.order\("scheduled_on", \{ ascending: false \}\)\.limit\(\d+\)/,
    );
  });

  it("asks for the future from today, soonest first, under its own limit", () => {
    expect(handler).toMatch(
      /\.gte\("scheduled_on", today\)\.order\("scheduled_on", \{ ascending: true \}\)\.limit\(\d+\)/,
    );
  });

  it("returns them as two lists, and the one shared list is gone", () => {
    expect(handler).toMatch(/recent: recent \?\? \[\]/);
    expect(handler).toMatch(/upcoming: upcoming \?\? \[\]/);
    expect(handler).not.toMatch(/\bhistory\b/);
  });
});

describe("the drawer shows them under two headings", () => {
  it("labels the past Recent visits and the future Coming up", () => {
    expect(drawer).toMatch(/<OtherVisits title="Recent visits" visits=\{recent\} \/>/);
    expect(drawer).toMatch(/<OtherVisits title="Coming up" visits=\{upcoming\} \/>/);
  });

  it("formats each row's day", () => {
    const list = drawer.slice(drawer.indexOf("function OtherVisits"));
    expect(list).toMatch(/formatDay\(h\.scheduled_on\)/);
    // Nothing to list, no heading over nothing.
    expect(list).toMatch(/if \(visits\.length === 0\) return null;/);
  });

  it("no longer reads the list that mixed them", () => {
    expect(drawer).not.toMatch(/data\?\.history/);
    expect(drawer).not.toMatch(/Other visits here/);
  });
});
