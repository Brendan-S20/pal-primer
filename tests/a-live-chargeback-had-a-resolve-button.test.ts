// Step seven of the eleven-reviewer audit: three places where a screen did not
// say what it was actually showing.
//
//   /review     listed EVERY open review_item, including live chargebacks,
//               rendered as the raw string `payment_chargeback` and fitted
//               with a "Record a decision" button that decided nothing
//   /routes     headed "Today" while the range selector showed a whole month
//   the nav     called one page "Routes" on desktop and "Schedule" on mobile
//
// ── WHY THE FIRST ONE IS NOT A LABELLING BUG ──────────────────────────────
//
// `review_items` grew from the visit detector's private table into the place
// every "a human should look at this" event is filed: refunds, chargebacks,
// dispute inquiries, failed billing runs, AI allowance warnings. Each of those
// was a good decision on its own. What nobody did was tell /review which of
// them it OWNS, so it kept reading the whole table.
//
// That put a resolve button on money. /disputes derives a dispute's state from
// the reversal ledger — `disputesFrom` folds the payment_chargeback /
// _won / _lost rows — and never reads `review_items.status`. So an office
// manager marking a chargeback "resolved" in /review changed nothing the
// dispute queue could see: one screen said settled, the other said the bank is
// still holding the money, and both were reading the same table.
//
// The fix is an allowlist, in one place, that the list, the badge and the write
// all read. These tests fail against the code as it was: there was no list.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REVIEW_KINDS,
  REVIEW_QUEUE_KINDS,
  REVIEW_KIND_COPY,
  isReviewQueueKind,
  type ReviewQueueKind,
} from "@/lib/review-queue";
import { DISPUTE_KINDS } from "@/lib/disputes";
import en from "@/lib/i18n/locales/en";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comment lines stripped, so a `toMatch` cannot be satisfied by the prose that
 *  merely DESCRIBES the filter — this file's subject is heavily commented in
 *  the source, and every assertion below would pass vacuously without this. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--"));
    })
    .join("\n");

/** The body of one exported server fn, so "the list filters" cannot be proved
 *  by a filter that lives in a different function. */
function serverFn(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  if (start === -1) throw new Error(`${name} is not an exported server fn any more`);
  const rest = src.slice(start + 10);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the review queue names the kinds it owns", () => {
  it("shares no kind at all with the dispute queue", () => {
    // The invariant the whole fix rests on. A kind on both lists is a row two
    // screens both believe they are responsible for, which is the state that
    // let /review resolve a dispute /disputes went on showing as open.
    const overlap = REVIEW_QUEUE_KINDS.filter((k) =>
      (DISPUTE_KINDS as readonly string[]).includes(k),
    );
    expect(overlap, "these kinds are claimed by /review AND /disputes").toEqual([]);
    for (const k of DISPUTE_KINDS) {
      expect(isReviewQueueKind(k), `${k} must not reach /review`).toBe(false);
    }
  });

  it("does not claim refunds either", () => {
    // A refund is not a dispute, so a denylist built from DISPUTE_KINDS would
    // have let it straight through — and it is just as wrong here. It is
    // settled money with nothing to decide, it lives on /payments and in the
    // CPA pack, and /review has no copy for it and no action to offer.
    expect(isReviewQueueKind("payment_refunded")).toBe(false);
  });

  it("still carries every kind the visit detector files", () => {
    // The detector's output is the queue's original reason for existing.
    // Narrowing the reads must not have narrowed them past that.
    for (const kind of REVIEW_KINDS) {
      expect(isReviewQueueKind(kind), `${kind} is filed but no longer shown`).toBe(true);
    }
  });

  it("carries the two kinds whose ONLY reader is this page", () => {
    // billing_run_failed replaced a RAISE WARNING that concealed fifteen days
    // of failed invoicing; ai_allowance_warning exists so an overage is not
    // first seen on an invoice. Nothing in src/ reads either one anywhere else,
    // so dropping them from the queue would delete both features in silence —
    // the quiet way to reintroduce exactly the bug each was written to end.
    expect(isReviewQueueKind("billing_run_failed")).toBe(true);
    expect(isReviewQueueKind("ai_allowance_warning")).toBe(true);
    expect(codeOnly(read("src/lib/ai-usage.server.ts"))).toMatch(/kind: "ai_allowance_warning"/);
  });

  it("rejects a kind nobody has put on the list", () => {
    expect(isReviewQueueKind("payment_chargeback")).toBe(false);
    expect(isReviewQueueKind("not_a_real_kind")).toBe(false);
  });

  it("only names kinds the database can actually hold", () => {
    // A typo here is invisible in production — the row simply never matches and
    // the alert never appears — so it is checked against the live CHECK
    // constraint, which is the LAST one any migration installs.
    const dir = join(ROOT, "supabase", "migrations");
    let latest = "";
    for (const f of readdirSync(dir).sort()) {
      const sql = readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "");
      const m = sql.match(/ADD CONSTRAINT review_items_kind_check[\s\S]*?ARRAY\[([\s\S]*?)\]/);
      if (m) latest = m[1];
    }
    expect(latest, "could not find any review_items kind CHECK to compare against").toBeTruthy();
    const permitted = [...latest.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    for (const kind of REVIEW_QUEUE_KINDS) {
      expect(permitted, `${kind} can never be stored, so it can never be shown`).toContain(kind);
    }
  });

  it("has reader-facing copy for every kind it shows", () => {
    // The original defect, generalised: a card headed with its own kind string
    // and no explanation is a card nobody can act on. Keying REVIEW_KIND_COPY
    // on the allowlist makes this a compile error too; this asserts the copy is
    // real prose rather than a placeholder put there to satisfy the compiler.
    for (const kind of REVIEW_QUEUE_KINDS as readonly ReviewQueueKind[]) {
      const copy = REVIEW_KIND_COPY[kind];
      expect(copy?.label, `no label for ${kind}`).toBeTruthy();
      expect(copy.label).not.toBe(kind);
      expect(copy.whatItMeans.length, `${kind} does not explain itself`).toBeGreaterThan(40);
      expect(copy.howToFix.length, `${kind} does not say what to do`).toBeGreaterThan(10);
    }
  });
});

describe("the list, the badge and the write all read the same allowlist", () => {
  const src = codeOnly(read("src/lib/review-queue.functions.ts"));

  it("the list no longer selects every kind in the table", () => {
    expect(serverFn(src, "listReviewItems")).toMatch(
      /\.in\("kind", \[\.\.\.REVIEW_QUEUE_KINDS\]\)/,
    );
  });

  it("the nav badge counts the same rows the list will show", () => {
    // Separate query, so it needs the filter separately. A badge reading "7"
    // over a page showing three is how people learn to ignore the badge.
    expect(serverFn(src, "getReviewQueueCount")).toMatch(
      /\.in\("kind", \[\.\.\.REVIEW_QUEUE_KINDS\]\)/,
    );
  });

  it("and the decision itself cannot land on a row this queue does not own", () => {
    // Hiding a chargeback from the list stops it being CLICKED. The item id
    // still travels in the request body, and the fix has to hold at the write
    // or it is a UI convention rather than a rule about money.
    expect(serverFn(src, "resolveReviewItem")).toMatch(
      /\.in\("kind", \[\.\.\.REVIEW_QUEUE_KINDS\]\)/,
    );
  });

  it("keeps /disputes reading the ledger, not review_items.status", () => {
    // The other half of the same disagreement. If this ever starts filtering on
    // status, a dismissed row would vanish from the dispute queue while the
    // bank still held the money.
    const disputes = codeOnly(read("src/lib/disputes.functions.ts"));
    expect(disputes).toMatch(/\.in\("kind", \[\.\.\.DISPUTE_KINDS\]\)/);
    expect(disputes).not.toMatch(/\.eq\("status", "open"\)/);
  });
});

describe("the schedule page's heading follows the range it is showing", () => {
  const routes = read("src/routes/_authenticated/routes.tsx");

  it("no longer hardcodes the word Today", () => {
    expect(codeOnly(routes)).not.toMatch(/<h1[^>]*>Today<\/h1>/);
    // CHANGED 2026-08-19: the `<h1>` now wraps a button that opens the date
    // picker, so `{heading}` is no longer its only child and a single-line
    // regex cannot see it. The property is unchanged — the heading text is
    // still the computed `heading` and not a literal — so this reads the
    // element's contents instead of its exact spelling.
    //
    // CHANGED 2026-10-02: the `<h1>` is now the page's name, "Schedule", which
    // is what every nav surface calls it (launch pass recommendation 3), and
    // the date label moved out of it into the button beside it. The property
    // this pins moves with it: the date the page shows is still the computed
    // `heading`, read from the date button rather than the h1.
    expect(codeOnly(routes)).toMatch(/<h1 className="text-2xl font-semibold">Schedule<\/h1>/);
    const dateButton = routes.slice(routes.indexOf('data-testid="schedule-date"'));
    expect(dateButton.slice(0, dateButton.indexOf("</button>"))).toMatch(/\{heading\}/);
  });

  it("derives it from the same window the page fetches and the calendar draws", () => {
    // Written independently of rangeStart/rangeEnd it would drift from them,
    // which is the exact failure being fixed — a title that describes a
    // different span of days than the board underneath it.
    const memo = routes.slice(routes.indexOf("const heading = useMemo("));
    const body = memo.slice(0, memo.indexOf("}, ["));
    expect(body).toMatch(/rangeStart/);
    expect(body).toMatch(/rangeEnd/);
    // orgTodayIso joins the deps: "Today" is judged on the org's clock now.
    expect(memo).toMatch(/\}, \[range, day, rangeStart, rangeEnd, orgTodayIso\]\)/);
  });

  it("says something different for each of the three ranges", () => {
    const memo = routes.slice(routes.indexOf("const heading = useMemo("));
    const body = memo.slice(0, memo.indexOf("}, ["));
    expect(body).toMatch(/range === "month"/);
    expect(body).toMatch(/range === "week"/);
    // "Today" survives as a word, but only on the day it is true of.
    expect(body).toMatch(/day === orgTodayIso/);
    expect(body).toMatch(/return "Today"/);
  });

  it("parses the day as local midnight, never as a bare ISO date", () => {
    // `new Date("2026-08-09")` is UTC midnight and renders as the 8th anywhere
    // west of Greenwich — a heading that names the wrong day on a dispatch
    // screen is worse than the hardcoded one it replaced.
    const memo = routes.slice(routes.indexOf("const heading = useMemo("));
    const body = memo.slice(0, memo.indexOf("}, ["));
    expect(body).toMatch(/T00:00:00/);
  });
});

describe("desktop and mobile call the page the same thing", () => {
  // The mobile tab bar has said "Schedule" all along. There is no `routes`
  // table — a route is visits filtered by day and by tech — so "Schedule" is
  // also the more truthful of the two names.
  //
  // AppSidebar.tsx is owned by another workstream and is deliberately NOT
  // asserted on here; it still reads "Routes" and needs the same one-word
  // change. Asserting it would fail on someone else's branch rather than
  // catching anything of ours.

  it("the mobile tab bar is the name everything else is being matched to", () => {
    // The words live in lib/i18n now (a tech can read the bar in Spanish);
    // the tab reads the sidebar's own key for /routes, and in English that
    // key still says Schedule.
    expect(read("src/components/MobileTabBar.tsx")).toMatch(
      /<span>\{t\("nav\.item\.routes"\)\}<\/span>/,
    );
    expect(en.nav.item.routes).toBe("Schedule");
  });

  it("the keyboard shortcut and the command palette both say Schedule", () => {
    const shortcuts = read("src/components/KeyboardShortcuts.tsx");
    expect(shortcuts).toMatch(/\{ keys: "g r", label: "Schedule", to: "\/routes" \}/);

    const palette = read("src/components/CommandPalette.tsx");
    expect(palette).toMatch(/\{ label: "Schedule", to: "\/routes", group: "Operations" \}/);
  });

  it("both help articles offer to open the Schedule", () => {
    const help = read("src/lib/help-content.ts");
    expect([
      ...help.matchAll(/appLink: \{ to: "\/routes", label: "Open Schedule" \}/g),
    ]).toHaveLength(2);
    expect(codeOnly(help)).not.toMatch(/label: "Open Routes"/);
  });

  it("an empty day sends a tech to the schedule, not to routes", () => {
    // This test's NAME was right and its assertion was not. It pinned
    // `<Link to="/routes">View schedule</Link>` — the label renamed, the
    // destination left alone — and the destination was the bug: ROUTE_ROLES
    // has never granted /routes to a tech, so RoleGuard bounced them straight
    // back to /my-day with "You don't have access to that page." The only
    // action on an empty day was a dead end for the only role that screen is
    // for, and this test was holding it in place.
    //
    // /my-schedule is the technician's own forward view and admits them. The
    // full rule — every ROUTE_ROLES-guarded link My Day offers must admit a
    // tech — lives in tests/the-only-button-on-an-empty-day-was-a-dead-end.ts,
    // which catches the next one rather than just this one.
    expect(codeOnly(read("src/routes/_authenticated/my-day.tsx"))).toMatch(
      /<Link to="\/my-schedule">\{t\("myDay\.viewMySchedule"\)\}<\/Link>/,
    );
    expect(en.myDay.viewMySchedule).toBe("View my schedule");
  });

  it("but the URL is untouched everywhere — the label changed, not the route", () => {
    // Renaming /routes would be ~20 call sites and a redirect, bought for a
    // string nobody reads. Every surface above still points at the same path,
    // and this is what keeps a later "finish the rename" from being started
    // quietly by find-and-replace.
    // my-day.tsx came off this list on 2026-09-14 and that is not a rename:
    // its one link moved to /my-schedule because a tech cannot open /routes.
    // The surfaces below are all office-facing, still point at /routes, and
    // are what this test is actually guarding.
    for (const f of [
      "src/components/KeyboardShortcuts.tsx",
      "src/components/CommandPalette.tsx",
      "src/lib/help-content.ts",
      "src/components/AppSidebar.tsx",
    ]) {
      expect(read(f), `${f} no longer links to /routes`).toMatch(/["']\/routes["']/);
    }
  });
});
