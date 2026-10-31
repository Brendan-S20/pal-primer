// "Active" was a flag somebody set. Having work is a fact. The clients list
// was only showing the flag.
//
// Found by measuring, not by reading: this database has 297 clients, and 287
// of them have no subscription at all. No subscription means no visits, no
// route, no invoice, no revenue — the rolling generator works off active
// subscriptions. All 297 rendered in green as "Active", indistinguishable
// from the 10 on a weekly route, and the headline count said 297.
//
// That is not a data problem to clean up quietly. Any book of business
// accumulates them: an import that was never finished, a service that ended
// and was never replaced, a lead converted and then forgotten. They are the
// clients that quietly stop earning, and the list was the one place that
// could have said so.
//
// Three states now, everywhere the status appears.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const page = readFileSync(join(root, "src/routes/_authenticated/clients.index.tsx"), "utf8");
const server = readFileSync(join(root, "src/lib/clients.functions.ts"), "utf8");
// The tiles and filters are worked out on the server since #617, when the
// list began to be paged there; the rule moved with them.
const roster = readFileSync(join(root, "src/lib/client-roster.ts"), "utf8");

describe("no service plan is its own state", () => {
  it("the server already counted it — this needed no new query", () => {
    expect(server).toMatch(/active_subscription_count: activeSubsByClient\.get\(c\.id\) \?\? 0/);
  });

  it("counted from active subscriptions, not from the active flag", () => {
    expect(roster).toMatch(/!!c\.active && \(c\.active_subscription_count \?\? 0\) === 0/);
    expect(roster).toMatch(/if \(hasNoPlan\(c\)\) noPlan \+= 1/);
  });

  it("both views tell the same story", () => {
    // A phone and a laptop disagreeing about whether a client is active is
    // worse than neither of them saying it.
    const occurrences = page.match(/\(c\.active_subscription_count \?\? 0\) === 0 \? \(/g) ?? [];
    expect(occurrences).toHaveLength(2);
    const amber = page.match(/No service plan<\/span>/g) ?? [];
    expect(amber).toHaveLength(2);
  });

  it("inactive still wins over no-plan", () => {
    // An archived client has no plan either. Reporting that instead of
    // "Inactive" would bury the decision somebody actually made.
    expect(page).toMatch(
      /!c\.active \? \(\s*\n?\s*<span className="text-xs text-muted-foreground">Inactive/,
    );
  });
});

describe("it is findable, not just visible", () => {
  it("there is a filter for it", () => {
    expect(page).toMatch(/\| "no_plan"/);
    expect(page).toMatch(/<SelectItem value="no_plan">No service plan<\/SelectItem>/);
    expect(roster).toMatch(/status === "no_plan" && !hasNoPlan\(c\)/);
  });

  it("the tile is a way in, not just a number", () => {
    expect(page).toMatch(/onClick=\{\(\) => stats\.noPlan > 0 && setStatus\("no_plan"\)\}/);
  });

  it("it replaced Inactive, which was already derivable", () => {
    // Active and total were both on screen; Inactive was the third number
    // that could be worked out from the other two. It survives as the tile's
    // subtitle rather than occupying a tile of its own.
    expect(page).toMatch(/\{stats\.total - stats\.active\} archived/);
  });

  it("says what the consequence is, not just the state", () => {
    expect(page).toMatch(/never scheduled, never invoiced, and never appear on a route/);
  });
});
