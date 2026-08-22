// Five findings that survived because a fix landed in one of two places.
//
// The docs in `docs/` were re-read against current code. Most of what they
// describe is genuinely done. What was left is almost all the same shape: a
// change applied to one consumer and not its twin, or to the detail page and
// not the list. That shape is why these are worth pinning rather than just
// fixing — the second copy is what nobody looks at.
//
// ── 1 & 2. TWO MONEY FORMS THAT DID NOT REFLOW ────────────────────────────
//
// The client Billing tab's two add-on forms and My Day's field billing form
// were `grid-cols-6` with no responsive branch. Six columns of a ~264px inner
// width is about 37px each, and in all three the price or quantity box got one
// column and the submit button got another. These are the controls that charge
// a customer's card, and My Day is the one screen in this product that is a
// phone screen by definition.
//
// The fix is not novel: `BillingTab.tsx`'s add-credit form, in the file next
// door, already reflows `col-span-6 sm:col-span-1`. It was written correctly
// and the three beside it were not.
//
// ── 3. THE OVERDUE CHIP ASKED THE WRONG CALENDAR ──────────────────────────
//
// `isInvoiceOverdue(status, dueOn, today)` defaults `today` to
// `America/Chicago` — the SQL column default, which `org-day.ts` is explicit
// is a fallback and not an answer: "a caller that does not know the timezone
// is a caller that should be fetching it, not defaulting."
//
// `InvoiceRow` and `InvoiceDrawer` called it with two arguments and took the
// default. `getDashboardSummary` reads `organizations.timezone` and passes it.
// Both render the same invoices, and one live org is `America/New_York` — so
// from 23:00 Chicago an invoice due today was badged Overdue on the list while
// the dashboard still counted it as current. Settings → Preferences promises
// in as many words that the timezone decides "what counts as 'today'
// everywhere … overdue and missed-visit detection".
//
// ── 4. TWO PLACES COUNTED THE SAME DOGS DIFFERENTLY ───────────────────────
//
// The clients list counted every dog row; the client detail page counts
// `d.active !== false` and the service dog-mismatch warning compares against
// that. Marking a dog inactive is the documented alternative to deleting one,
// so the list kept showing a number nothing else agreed with.
//
// ── 5. A YARD SIZE THE DATABASE OVERWRITES, TYPED BY HAND ─────────────────
//
// `properties.functions.ts` stopped writing `yard_size` and says why: it is
// derived from the boundary by a trigger. The New Client wizard was the older
// form still sending it, and a hand-picked size is worse than none — the tech
// reading it in the field cannot tell a guess from a measurement.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(ROOT + p, "utf8");
/** Whole-line comments dropped: every file here explains the bug it fixes,
 *  naming the class or column it bans. */
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

/** Every `col-span-N` on a grid child inside `src`, per file. */
function colSpans(src: string): string[] {
  return [...codeOnly(src).matchAll(/(?:^|[\s"'`])((?:[a-z]+:)?col-span-\d+)/g)].map((m) => m[1]);
}

describe("a form that charges a card fits on the phone it is used from", () => {
  it("reflows both add-on forms on the client Billing tab", () => {
    const src = codeOnly(read("src/components/client-detail/billing-panels.tsx"));
    // Two forms, four columns each. Every bare col-span must have an sm: twin,
    // or the narrow layout is still six columns of 37px.
    const bare = colSpans(src).filter((c) => !c.includes(":"));
    const prefixed = colSpans(src).filter((c) => c.startsWith("sm:"));
    expect(bare.length).toBeGreaterThanOrEqual(8);
    expect(
      prefixed.length,
      "each column needs an sm: width, otherwise it keeps the phone value everywhere",
    ).toBe(bare.length);
    // The money inputs specifically: half a row below sm, one column above.
    expect(src).toMatch(/col-span-3 sm:col-span-1[\s\S]*?addon-price/);
    expect(src).toMatch(/col-span-3 sm:col-span-1[\s\S]*?addon-sub-price/);
  });

  it("reflows the field billing form on My Day", () => {
    const src = codeOnly(read("src/routes/_authenticated/my-day.tsx"));
    const form = src.slice(src.indexOf("addonSvcId"), src.indexOf("Bill $"));
    expect(form).toMatch(/col-span-6 h-9[\s\S]*?sm:col-span-4/);
    expect(form).toMatch(/col-span-2 h-9[\s\S]*?sm:col-span-1/);
    // The confirm button gets the rest of the row and a 44px height on touch.
    expect(form).toMatch(/col-span-4 touch:min-h-11 sm:col-span-1/);
  });

  it("keeps the form that was already right, which is where the pattern came from", () => {
    // BillingTab's add-credit form. If this regresses, the three above lose
    // the precedent they were copied from.
    expect(codeOnly(read("src/components/client-detail/BillingTab.tsx"))).toMatch(
      /col-span-6 sm:col-span-1/,
    );
  });
});

describe("the overdue chip and the dashboard use one calendar", () => {
  it("asks the org for today rather than taking the Chicago default", () => {
    for (const p of ["src/components/InvoiceRow.tsx", "src/components/InvoiceDrawer.tsx"]) {
      const src = codeOnly(read(p));
      expect(src, `${p} does not read the org's day`).toMatch(/useOrgToday\(\)/);
      // Three arguments, always. Two takes the default and reintroduces this.
      expect(
        src,
        `${p} calls isInvoiceOverdue without a day, which silently means America/Chicago`,
      ).not.toMatch(/isInvoiceOverdue\([^)]*\.due_on\s*\)/);
    }
  });

  it("gets the timezone from the query the shell has already loaded", () => {
    // A second fetch per invoice row would be a worse bug than the one fixed.
    const hook = codeOnly(read("src/hooks/useOrgToday.ts"));
    expect(hook).toMatch(/queryKey: \["my-org"\]/);
    expect(hook).toMatch(/orgToday\(tz\)/);
    // And the server function has to actually return it.
    expect(codeOnly(read("src/lib/org.functions.ts"))).toMatch(/"id, name, portal_slug, timezone,/);
  });

  it("still falls back rather than rendering nothing when the org is unknown", () => {
    const hook = codeOnly(read("src/hooks/useOrgToday.ts"));
    expect(hook).toMatch(/DEFAULT_ORG_TIMEZONE/);
  });
});

describe("the clients list counts the dogs the client page counts", () => {
  it("excludes inactive dogs and archived properties", () => {
    const src = codeOnly(read("src/lib/clients.functions.ts"));
    expect(src).toMatch(/\.select\("id, client_id, dogs\(id, active\)"\)/);
    expect(src).toMatch(/\.is\("archived_at", null\)/);
    expect(src).toMatch(/d\?\.active !== false/);
  });

  it("uses the same test as the detail page, not an equivalent-looking one", () => {
    // `active !== false` and `active === true` differ on a null, and the
    // column is nullable. Both sides must spell it the same way.
    expect(codeOnly(read("src/components/client-detail/PropertiesTab.tsx"))).toMatch(
      /active !== false/,
    );
  });
});

describe("nobody is asked to guess a yard size the database derives", () => {
  it("is gone from the new-client wizard", () => {
    const src = codeOnly(read("src/routes/_authenticated/clients.new.tsx"));
    expect(src).not.toMatch(/yardSize/);
    expect(src).not.toMatch(/Small \(under 1\/8 acre\)/);
  });

  it("leaves the server tolerant of older forms rather than newly strict", () => {
    // The field is still ACCEPTED and still ignored. Rejecting it would turn a
    // stale cached bundle into an error instead of a no-op.
    expect(read("src/lib/properties.functions.ts")).toMatch(/still accepted .* but never written/);
  });
});

describe("NATIVE.md describes a build that can boot", () => {
  const doc = () => read("NATIVE.md");

  it("does not tell anyone the shell points at a preview domain", () => {
    // The config stopped hard-coding this precisely because a binary built on
    // any given day would have shipped pointing at it.
    expect(doc()).not.toMatch(/points `server\.url` to/);
    expect(doc()).toMatch(/CAP_SERVER_URL/);
  });

  it("names the build script that produces a bootable shell", () => {
    // `bun run build` emits .output/public, which has no index.html — a
    // WebView pointed at it loads nothing.
    expect(doc()).toMatch(/bun run build:native\s+# NOT `bun run build`/);
    expect(doc()).toMatch(/no index\.html/);
    expect(doc()).not.toMatch(/Comment out the `server` block/);
  });

  it("stops listing push tokens as outstanding, since they shipped", () => {
    expect(doc()).toMatch(/✅ Push tokens/);
    expect(doc()).toMatch(/FCM HTTP v1/);
  });
});
