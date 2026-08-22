// A franchise settlement had two problems, and they are the same problem.
//
// ── 1. THE SCREEN WITH THE BUTTONS SHOWED THE WRONG NUMBER ────────────────
//
// `generate_franchise_settlements` writes `direction` — who pays whom — and
// `net_due_cents` — how much. `/franchise` selected neither. It showed the
// ROYALTY, which is an input to the settlement rather than its result:
//
//     balance = revenue_the_franchise_collected − (total_revenue × royalty%)
//
// so under parent-collection the franchise is holding the location's money and
// owes most of it back. A statement billing a location $100 and a statement
// owing that location $900 both rendered as a row reading "Royalty $100". The
// franchise owner pressed **Mark paid** on a screen that never said who was
// paying.
//
// The labels for this existed — in `buildFranchiseSettlements`, in the CPA
// report pack, which had selected both columns all along. One of two places
// again, and the place that got it was the one without the buttons.
//
// ── 2. THE OTHER PARTY COULD NOT READ IT AT ALL ───────────────────────────
//
// RLS on `franchise_royalty_invoices` is `can_write_org(auth.uid(),
// parent_organization_id)`: the parent's office and nobody else. There was no
// server function for the child side and no screen for it. So "Issue" moved a
// status column and delivered nothing — the location learned what it owed by
// being told out of band.
//
// That is the rule this codebase already states twice, unapplied to the
// document the rule is about: "a franchisee being unable to see their own
// royalty rate in a product that bills them for it would be indefensible", and
// "a deduction a franchisee cannot look up is indistinguishable from an error,
// and they will assume the worst".
//
// ── WHY THE AUDIENCE ARGUMENT IS REQUIRED ─────────────────────────────────
//
// "You owe the franchise" and "The location owes you" are the SAME ROW. Which
// one is true depends on who is reading. There is no safe default, so there is
// no default — and the pair being swapped is the failure this file exists to
// catch, because every figure still looks like a plausible number.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  describeSettlement,
  settlementDirectionLabel,
  settlementFlow,
  settlementIsDelivered,
  settlementStatusLabel,
  type SettlementRow,
} from "../src/lib/franchise-settlement";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(ROOT + p, "utf8");
/** Whole-line comments dropped: every file here explains the bug it fixes,
 *  quoting the column names and the wrong behaviour it replaced. */
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

const row = (over: Partial<SettlementRow> = {}): SettlementRow => ({
  id: "s1",
  period_start: "2026-07-01",
  period_end: "2026-08-01",
  revenue_cents: 100_000,
  royalty_percent: 10,
  royalty_cents: 10_000,
  adjustments_applied_cents: 0,
  direction: "location_owes_franchise",
  net_due_cents: 10_000,
  status: "issued",
  ...over,
});

describe("which way the money goes, said from the reader's side", () => {
  it("gives the two parties opposite sentences for one row", () => {
    expect(settlementDirectionLabel("location_owes_franchise", "location")).toBe(
      "You owe the franchise",
    );
    expect(settlementDirectionLabel("location_owes_franchise", "franchise")).toBe(
      "The location owes you",
    );
    expect(settlementDirectionLabel("franchise_owes_location", "location")).toBe(
      "The franchise owes you",
    );
    expect(settlementDirectionLabel("franchise_owes_location", "franchise")).toBe(
      "You owe the location",
    );
  });

  it("never tells either party they are owed money they in fact owe", () => {
    // The mutation this is really guarding: swap the two DIRECTIONS entries and
    // every label is still a well-formed English sentence about money.
    for (const audience of ["franchise", "location"] as const) {
      const owes = settlementDirectionLabel("location_owes_franchise", audience);
      const owed = settlementDirectionLabel("franchise_owes_location", audience);
      expect(owes).not.toBe(owed);
      // Whoever "you" is, exactly one of the two sentences puts them on the
      // paying side.
      const youPay = [owes, owed].filter((s) => s.startsWith("You owe"));
      expect(youPay, `${audience} sees ${JSON.stringify([owes, owed])}`).toHaveLength(1);
    }
  });

  it("turns the same row into an incoming figure for one side and outgoing for the other", () => {
    expect(settlementFlow("location_owes_franchise", "franchise")).toBe("incoming");
    expect(settlementFlow("location_owes_franchise", "location")).toBe("outgoing");
    expect(settlementFlow("franchise_owes_location", "franchise")).toBe("outgoing");
    expect(settlementFlow("franchise_owes_location", "location")).toBe("incoming");
  });

  it("moves nothing when the period settled exactly", () => {
    expect(settlementFlow("settled", "franchise")).toBe("settled");
    expect(settlementFlow("settled", "location")).toBe("settled");
    expect(settlementDirectionLabel("settled", "location")).toBe("Settled, nothing to move");
  });

  it("prints an unrecognised direction rather than guessing one", () => {
    // `direction` is a text column with a default. Defaulting an unknown value
    // to either real direction would be a confident lie about money.
    expect(settlementDirectionLabel("something_new", "location")).toBe("something_new");
    expect(settlementFlow("something_new", "location")).toBe("settled");
  });
});

describe("the statement's headline is the net, not the royalty", () => {
  it("reads net_due_cents, which is not the royalty under parent collection", () => {
    // The $1,000 case from the both-directions migration: the franchise
    // collected everything at 10%, so it owes the location $900 while the
    // royalty is $100. Rendering the royalty here is the original bug.
    const line = describeSettlement(
      row({ direction: "franchise_owes_location", net_due_cents: 90_000, royalty_cents: 10_000 }),
      "location",
    );
    expect(line.netDueCents).toBe(90_000);
    expect(line.royaltyCents).toBe(10_000);
    expect(line.flow).toBe("incoming");
  });

  it("falls back to amount_cents only when royalty_cents was not selected", () => {
    // Both are written from the same expression. A query that predates the
    // named column should still show the royalty rather than zero.
    const line = describeSettlement(
      row({ royalty_cents: undefined, amount_cents: 7_500 }),
      "franchise",
    );
    expect(line.royaltyCents).toBe(7_500);
  });
});

describe("issuing is what delivers a statement", () => {
  it("treats a draft as undelivered and everything else as delivered", () => {
    // The generator rewrites drafts freely, so a draft is a figure still
    // moving. Showing one to a location invites them to reconcile and be wrong.
    expect(settlementIsDelivered("draft")).toBe(false);
    expect(settlementIsDelivered("issued")).toBe(true);
    expect(settlementIsDelivered("paid")).toBe(true);
    // A void that WAS issued must stay visible — there is no issued_at column
    // to tell it from one that never left draft, and silently retracting a
    // statement the location already saw is the worse of the two errors.
    expect(settlementIsDelivered("void")).toBe(true);
  });

  it("labels a draft as unagreed rather than printing the raw column", () => {
    expect(settlementStatusLabel("draft")).toBe("Draft, not yet agreed");
    expect(settlementStatusLabel("void")).toBe("Voided");
  });
});

describe("the parent's screen selects the columns that say what happens", () => {
  const src = codeOnly(read("src/lib/franchise.functions.ts"));

  it("asks for direction and net_due_cents", () => {
    const select = /\.select\(\s*"([^"]*franchise_royalty[\s\S]*?|[^"]*child_organization_id[^"]*)"/.exec(
      src.slice(src.indexOf("listRoyaltyInvoices")),
    );
    expect(select, "no select found on listRoyaltyInvoices").toBeTruthy();
    expect(select![1]).toContain("direction");
    expect(select![1]).toContain("net_due_cents");
  });
});

describe("the location can read the statements that bill it", () => {
  const src = codeOnly(read("src/lib/franchise-membership.functions.ts"));
  const fn = src.slice(src.indexOf("getMyFranchiseSettlements"));

  it("exists at all, which it did not", () => {
    expect(src).toMatch(/export const getMyFranchiseSettlements/);
  });

  it("is scoped to statements this organization is the subject of", () => {
    // Service-role is unavoidable — a location is not a member of its
    // franchise — so the scope is the whole of the authorization.
    expect(fn).toMatch(/\.eq\("child_organization_id", orgId\)/);
    expect(fn).not.toMatch(/\.eq\("parent_organization_id"/);
  });

  it("does not hand a location a draft", () => {
    expect(fn).toMatch(/\.neq\("status", "draft"\)/);
  });

  it("gates on view_financials, because these are money lines", () => {
    expect(fn).toMatch(/requirePermission\(context\.supabase, context\.userId, "view_financials"\)/);
  });

  it("is mounted on the page the franchisee already reads", () => {
    const page = codeOnly(read("src/routes/_authenticated/settings.franchise.tsx"));
    expect(page).toMatch(/getMyFranchiseSettlements/);
    expect(page).toMatch(/audience="location"/);

    // CHANGED 2026-08-19. This asserted `m?.isChild ? <MyStatements /> : null`,
    // which turned out to PIN a bug rather than prevent one.
    //
    // unlink_franchise_child clears parent_organization_id and preserves every
    // statement and adjustment already raised — it says so in as many words,
    // because unlinking is not a way to erase what was owed. But `isChild`
    // goes false at that moment, so the location lost sight of its own unpaid
    // statements while the franchise kept theirs. Two parties reconciling the
    // same document, one of whom could still read it.
    //
    // The gate is now "is, or was, a location".
    expect(page).toMatch(/const showLedgers = !!m && \(m\.isChild \|\| m\.hasFranchiseHistory\)/);
    expect(page).toMatch(/showLedgers \? <MyStatements \/> : null/);
    expect(page, "the old isChild-only gate is what hid a live debt").not.toMatch(
      /m\?\.isChild \? <MyStatements \/> : null/,
    );
  });

  it("still shows a parent nothing, and an outsider nothing", () => {
    // The property the old assertion was really protecting, and the one the
    // widened gate must not have cost: statements are billed TO a location, so
    // a franchise parent has none of its own and a solo operator must not meet
    // an empty "Settlement statements" card on their settings page.
    //
    // Both fall out of how hasFranchiseHistory is computed rather than from
    // the JSX, which is why this reads the server function: it counts rows
    // matching `child_organization_id = orgId`, so a pure parent — which is
    // nobody's child — can never set it. Asserted here because widening that
    // filter to either side of the relationship is the plausible wrong edit,
    // and it would silently mount the panel on every parent's page.
    const fnSrc = codeOnly(read("src/lib/franchise-membership.functions.ts"));
    const block = fnSrc.slice(
      fnSrc.indexOf("let hasFranchiseHistory"),
      fnSrc.indexOf("return {", fnSrc.indexOf("let hasFranchiseHistory")),
    );
    expect(block).not.toBe("");
    // Only asked of an org that is not a child now — otherwise isChild covers it.
    expect(block).toMatch(/if \(!me\?\.parent_organization_id\)/);
    // And only ever about rows billed to this org.
    expect((block.match(/\.eq\("child_organization_id", orgId\)/g) ?? []).length).toBe(2);
    expect(block).not.toMatch(/parent_organization_id", orgId/);
  });

  it("gives the location no way to move a statement's status", () => {
    // Issuing and marking paid are the franchise's acts. The component only
    // renders controls when handed a callback, and the location's side passes
    // none.
    const page = codeOnly(read("src/routes/_authenticated/settings.franchise.tsx"));
    const mine = page.slice(page.indexOf("function MyStatements"));
    expect(mine.slice(0, mine.indexOf("function MyAdjustments"))).not.toMatch(/onSetStatus/);
  });
});

describe("one vocabulary, so a third copy cannot appear", () => {
  it("has the CPA pack reading the shared module rather than its own map", () => {
    const src = codeOnly(read("src/lib/cpa-reports.functions.ts"));
    expect(src).toMatch(/from "@\/lib\/franchise-settlement"/);
    expect(src).toMatch(/settlementDirectionLabel\(r\.direction, audience\)/);
    // The local copy these labels used to live in.
    expect(src).not.toMatch(/const DIRECTION: Record<string, string>/);
    expect(src).not.toMatch(/asParent \? "You owe the location"/);
  });

  it("has both screens rendering the same component", () => {
    for (const p of [
      "src/routes/_authenticated/franchise.tsx",
      "src/routes/_authenticated/settings.franchise.tsx",
    ]) {
      expect(codeOnly(read(p)), `${p} renders its own statement list`).toMatch(
        /<FranchiseSettlementStatements/,
      );
    }
  });

  it("no longer renders the royalty as a bare table column on /franchise", () => {
    // The old table: Location / Period / Revenue / Rate / Royalty / Status,
    // with amount_cents as the emphasised figure and no direction anywhere.
    const src = codeOnly(read("src/routes/_authenticated/franchise.tsx"));
    expect(src).not.toMatch(/money\(Number\(r\.amount_cents\)\)/);
    expect(src).not.toMatch(/<TableHead>Royalty<\/TableHead>/);
  });
});

describe("the void button the product already told people to press", () => {
  it("exists", () => {
    // The Generate toast says "Void an issued statement to recalculate it".
    // The server function has accepted 'void' all along; there was no control.
    const src = codeOnly(read("src/components/FranchiseSettlementStatements.tsx"));
    expect(src).toMatch(/onSetStatus\(line\.id, "void"\)/);
    // Only on an issued statement — voiding a draft is what Generate does.
    const block = src.slice(src.indexOf('onSetStatus(line.id, "void")') - 400);
    expect(block).toMatch(/line\.status === "issued"/);
  });

  it("keeps the instruction that names it", () => {
    expect(read("src/routes/_authenticated/franchise.tsx")).toMatch(
      /Void an issued statement to recalculate it/,
    );
  });
});

describe("one location, on its own", () => {
  const drawer = codeOnly(read("src/components/FranchiseLocationDrawer.tsx"));
  const page = codeOnly(read("src/routes/_authenticated/franchise.tsx"));

  it("shows only the statements and adjustments belonging to that location", () => {
    // The mutation that matters: drop either filter and one location's drawer
    // shows every location's money, on a screen whose whole purpose is to
    // isolate one of them.
    expect(drawer).toMatch(
      /statements\.filter\(\(s\) => s\.child_organization_id === row\.organization_id\)/,
    );
    expect(drawer).toMatch(
      /adjustments\.filter\(\(a\) => a\.child_organization_id === row\.organization_id\)/,
    );
  });

  it("reads the query keys the panels below already use, so it cannot disagree with them", () => {
    // Re-fetching per location would put two answers to one question on one
    // screen. Same key, same cache, one fetch.
    for (const key of ['"royalty-invoices"', '"adjustments"', '"royalty-settings"']) {
      expect(
        page.match(new RegExp(`queryKey: \\["franchise", ${key}\\]`, "g"))?.length,
        `${key} is not shared between the drill-down and the panel`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps the promise that a parent sees totals and not customers", () => {
    // /franchise tells a franchisee "you see their totals, not their
    // customers". A drill-down is exactly where that erodes quietly.
    expect(drawer).not.toMatch(/client_id|visits\(|listClients|clients\./);
    expect(drawer).toMatch(/active_clients/); // the COUNT is a total, and fine
  });

  it("opens from a real button rather than a clickable row", () => {
    // A row that opens something on click has no keyboard affordance, and on
    // touch it makes every number in the row a hit target for a drawer.
    const cell = page.slice(page.indexOf("setDrillInto(r)") - 500, page.indexOf("setDrillInto(r)"));
    expect(cell).toMatch(/<button/);
    expect(cell).toMatch(/type="button"/);
    expect(cell).toMatch(/touch:min-h-11/);
    expect(cell).toMatch(/truncate/);
  });
});

describe("a franchisee reads their own bill on a phone", () => {
  const src = read("src/components/FranchiseSettlementStatements.tsx");

  it("is a list that wraps, not a seven-column money table", () => {
    // "Dense grids reflow, they do not shrink" — seven columns of money at
    // 360px is the case the working agreement names.
    expect(src).not.toMatch(/<Table[\s>]/);
    expect(codeOnly(src)).toMatch(/<ul className="divide-y text-sm">/);
    expect(codeOnly(src)).toMatch(/flex flex-wrap items-start justify-between/);
  });

  it("gives every status control a 44px touch target", () => {
    // These replaced bare `text-xs text-primary underline` buttons, which are
    // roughly 16px of hittable height.
    const buttons = [...codeOnly(src).matchAll(/<Button[\s\S]*?>/g)].map((m) => m[0]);
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const b of buttons) {
      expect(b, `a status control with no touch height: ${b}`).toMatch(/touch:min-h-11/);
    }
  });

  it("lets a long location name shrink instead of widening the row", () => {
    const page = read("src/routes/_authenticated/franchise.tsx");
    const rate = page.slice(page.indexOf("Royalty rate per location"));
    // The rate row: name, a number box, and "% of collected revenue" is more
    // than 360px, and the trailing label was the part going over the edge.
    expect(rate).toMatch(/flex flex-col gap-1 text-sm sm:flex-row/);
    expect(rate).toMatch(/min-w-0 flex-1 truncate/);
  });

  it("wraps the card header instead of pushing its button off the edge", () => {
    const page = read("src/routes/_authenticated/franchise.tsx");
    const header = page.slice(page.indexOf("Royalty billing") - 400);
    expect(header).toMatch(/flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between/);
  });

  it("labels the rate input for a screen reader, since its only label is a % sign", () => {
    expect(read("src/routes/_authenticated/franchise.tsx")).toMatch(
      /aria-label=\{`Royalty percentage for \$\{c\.name\}`\}/,
    );
  });
});
