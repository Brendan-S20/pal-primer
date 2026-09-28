// Step three of the eleven-reviewer audit: the things a paying customer is
// told that are not true, or not told at all.
//
//   the vacation hold   said "N visits skipped" when it had skipped none
//   the dead ends       showed a Postgres error to a homeowner, unbranded
//   paying an invoice   produced no acknowledgement of any kind
//   every email         never said who sent it or how to reach them
//
// ── ONE THING THE REVIEW GOT WRONG, WHICH CHANGED THE FIX ─────────────────
//
// The report's remedy for the vacation hold was "delete the Account-tab
// duplicate; render the correct component in both places". Deleting it would
// have removed the feature from a whole class of customer.
//
// The Visits tab's hold was nested inside `{(subsQ.data ?? []).length > 0 &&`.
// `subsQ` is portal_list_prepaid_subscriptions, which filters
// `billing_cadence = 'prepaid'`. A POSTPAID customer therefore had no plan
// rows, so no vacation hold on that tab at all — however the org had set
// allow_vacation_hold. The Account tab's version, lying toast and all, was
// the only one they could reach.
//
// So both halves were needed: render the shared card on the Account tab AND
// lift it out of the prepaid gate on the Visits tab. The permission is the
// gate; having prepaid a balance is not.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comment lines stripped, so a `not.toMatch` cannot be satisfied or defeated
 *  by the prose documenting what was removed. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--"));
    })
    .join("\n");

describe("the vacation hold stops claiming visits were skipped", () => {
  const account = read("src/routes/portal.$slug.$token.account.tsx");
  const visits = read("src/routes/portal.$slug.$token.visits.tsx");
  const ui = read("src/lib/portal-ui.tsx");

  it("the Account tab renders the shared card, not its own form", () => {
    expect(account).toMatch(/<VacationHoldCard/);
    expect(account).toMatch(/autoApply=\{!!c\?\.auto_apply_changes\}/);
  });

  it("and the toast that lied is gone", () => {
    // `Vacation hold set. ${r.skippedCount ?? 0} visit(s) skipped.` — fired
    // whatever came back. With auto-apply off the RPC skips nothing and
    // returns 0, so the customer read "hold set" and went away.
    expect(codeOnly(account)).not.toMatch(/visit\(s\) skipped/);
    expect(codeOnly(account)).not.toMatch(/Vacation hold set/);
  });

  it("the shared mutation says what actually happened in both cases", () => {
    const mut = ui.slice(ui.indexOf("const vacationMut = useMutation("));
    const body = mut.slice(0, mut.indexOf("});"));
    expect(body).toMatch(/skippedCount > 0/);
    expect(body).toMatch(/Vacation hold sent to the office for review/);
  });

  it("the card knows whether the hold applies now or waits for the office", () => {
    const card = ui.slice(ui.indexOf("export function VacationHoldCard("));
    expect(card.slice(0, 3000)).toMatch(/Visits in this range will be skipped immediately/);
    expect(card.slice(0, 3000)).toMatch(/The office will confirm and skip the affected visits/);
  });

  it("and refuses a hold that starts in the past", () => {
    // The deleted form had no minimum. A hold backdated a week is a request
    // nobody can honour, accepted without comment.
    const card = ui.slice(ui.indexOf("export function VacationHoldCard("));
    expect(card.slice(0, 3000)).toMatch(/const min = new Date\(Date\.now\(\) \+ 86400000\)/);
    expect(card.slice(0, 3000)).toMatch(/<Input type="date" min=\{min\}/);
  });

  it("the Visits tab shows it to postpaid customers too", () => {
    // The regression the report's own fix would have caused. The hold must
    // sit OUTSIDE the prepaid-subscriptions block.
    const holdAt = visits.indexOf("<VacationHoldCard");
    const planBlockEnd = visits.indexOf(
      "</section>",
      visits.indexOf("(subsQ.data ?? []).length > 0"),
    );
    expect(holdAt).toBeGreaterThan(planBlockEnd);
    expect(visits).toMatch(/\{c\?\.allow_vacation_hold && \(/);
  });

  it("and that gate is the permission, not the billing cadence", () => {
    const tail = visits.slice(visits.indexOf("{c?.allow_vacation_hold && ("));
    expect(tail).not.toMatch(/subsQ/);
  });
});

describe("the portal's dead ends are branded and say something useful", () => {
  const ui = read("src/lib/portal-ui.tsx");
  const layout = read("src/routes/portal.$slug.$token.tsx");

  it("there is one component for all of them", () => {
    expect(ui).toMatch(/export function PortalDeadEnd\(/);
    // Inside the same branded shell the verify gate uses — whose own comment
    // claims "no unbranded portal page exists anywhere", which four pages
    // were quietly falsifying.
    const dead = ui.slice(ui.indexOf("export function PortalDeadEnd("));
    expect(dead.slice(0, 2000)).toMatch(/<PortalBrandedShell/);
  });

  it("the raw error is never the headline", () => {
    const dead = ui.slice(ui.indexOf("export function PortalDeadEnd("));
    const block = dead.slice(0, 2000);
    // Kept, but collapsed: support needs it, the customer does not.
    expect(block).toMatch(/<details/);
    expect(block).toMatch(/Technical details/);
  });

  it("the route no longer prints error.message as the whole page", () => {
    expect(codeOnly(layout)).not.toMatch(
      /<p className="mt-2 text-sm text-muted-foreground">\{error\.message\}<\/p>/,
    );
    expect(layout).toMatch(/detail=\{error\.message\}/);
  });

  it("all four dead ends use it", () => {
    // errorComponent, notFoundComponent, and the two inline bail-outs.
    expect(layout.match(/<PortalDeadEnd/g)).toHaveLength(4);
  });

  it("the expired-link page says links expire and where to find a live one", () => {
    // It used to read, in full: "Invalid or expired portal link." — which of
    // the two, and what to do about it, were left to the reader.
    expect(codeOnly(layout)).not.toMatch(/Invalid or expired portal link\./);
    expect(layout).toMatch(/This link has expired/);
    expect(layout).toMatch(/most recent text or email/);
  });
});

describe("paying an invoice is acknowledged", () => {
  const billing = read("src/routes/portal.$slug.$token.billing.tsx");
  const pay = read("src/routes/portal.$slug.$token.pay.$invoiceId.tsx");

  it("the billing route now declares the search param it was always sent", () => {
    expect(billing).toMatch(/validateSearch:/);
    expect(billing).toMatch(/paid\?: "succeeded" \| "processing"/);
  });

  it("declared as optional, so unrelated links are not forced to pass it", () => {
    // A validator that always returns the key makes `search` required on
    // every <Link> to this route, and three of them have no business knowing
    // about payment status.
    const v = billing.slice(billing.indexOf("validateSearch:"));
    expect(v.slice(0, 400)).toMatch(/\? \{ paid: search\.paid \}\s*\n?\s*: \{\}/);
  });

  it("and renders a banner that distinguishes settled from pending", () => {
    expect(billing).toMatch(/paid === "processing" \? "Payment started" : "Payment received"/);
    expect(billing).toMatch(/take a few business days to clear/);
  });

  it("the pay page sends the real status, not a flat flag", () => {
    // ACH lands as `processing` and takes days. "Payment received" there is a
    // reassurance the product cannot honour.
    expect(codeOnly(pay)).not.toMatch(/paid: "1"/);
    expect(pay).toMatch(/paymentIntent\?\.status === "processing" \? "processing" : "succeeded"/);
    expect(pay).toMatch(/search: \{ paid: redirectStatus \}/);
  });
});

describe("emails say who sent them", () => {
  const shared = read("src/lib/email-templates/_shared.tsx");
  const enqueue = read("src/lib/email/enqueue.server.ts");
  const TEMPLATES = [
    "invoice-sent",
    "overdue-reminder",
    "payment-received",
    "visit-completed",
    "weather-reschedule",
    "welcome",
    "win-back",
    "review-request",
    "visit-reminder",
    "on-my-way",
  ];

  it("there is a shared footer", () => {
    expect(shared).toMatch(/export function OrgFooter\(/);
    expect(shared).toMatch(/export interface OrgContact/);
  });

  it("every line of it is independently optional", () => {
    // A tenant who has not filled in an address must not get a blank line or
    // the word "null" in their customer's inbox.
    const f = shared.slice(shared.indexOf("export function OrgFooter("));
    expect(f).toMatch(/if \(!name && !phone && !email && !address\) return null;/);
    for (const v of ["name", "phone", "email", "address"]) {
      expect(f).toMatch(new RegExp(`\\{${v} \\? \\(`));
    }
  });

  it("built as a table, because this is email", () => {
    const f = shared.slice(shared.indexOf("export function OrgFooter("));
    expect(f).toMatch(/<table role="presentation"/);
  });

  it("the org's details are merged in centrally, not per caller", () => {
    // The failure being replaced is precisely "the data was available and
    // nobody wired it up" — so no template author has to remember.
    expect(enqueue).toMatch(/contact_phone, contact_address/);
    expect(enqueue).toMatch(/orgPhone: orgContact\.contact_phone \?\? null/);
    expect(enqueue).toMatch(/orgAddress: orgContact\.contact_address \?\? null/);
  });

  it("and every customer-facing template renders it", () => {
    for (const t of TEMPLATES) {
      const src = read(`src/lib/email-templates/${t}.tsx`);
      expect(src, t).toMatch(/<OrgFooter /);
      expect(src, t).toMatch(/interface Props extends OrgContact \{/);
    }
  });

  it("the footer is the last thing in the container", () => {
    for (const t of TEMPLATES) {
      const src = read(`src/lib/email-templates/${t}.tsx`);
      const footer = src.lastIndexOf("<OrgFooter ");
      const close = src.lastIndexOf("</Container>");
      expect(footer, t).toBeLessThan(close);
      expect(src.slice(footer, close), t).not.toMatch(/<Text|<Button/);
    }
  });

  it("no auth or platform template picked it up by accident", () => {
    // magic-link, recovery, reauthentication, email-change, invite, signup
    // and the weekly digest do not go to customers; an org footer on a
    // password reset would be wrong.
    const dir = join(ROOT, "src/lib/email-templates");
    const others = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx") && f !== "_shared.tsx")
      .map((f) => f.replace(/\.tsx$/, ""))
      .filter((f) => !TEMPLATES.includes(f));
    for (const t of others) {
      expect(read(`src/lib/email-templates/${t}.tsx`), t).not.toMatch(/<OrgFooter /);
    }
  });
});

describe("the address the footer prints", () => {
  // Read lazily. Resolving in the describe body makes a missing file abort
  // the whole file at import, which reports as "no tests" instead of as the
  // assertions that actually depend on it.
  const migration = () =>
    read("supabase/migrations/20260808230000_an-email-from-a-company-with-no-phone-number.sql");

  it("is one free-text field, not a parsed address", () => {
    expect(migration()).toMatch(/ADD COLUMN IF NOT EXISTS contact_address text/);
    expect(migration()).toMatch(/never parsed, geocoded or routed to/);
  });

  it("rejects the empty string, so 'blank' and 'unset' cannot differ", () => {
    expect(migration()).toMatch(/length\(btrim\(contact_address\)\) BETWEEN 1 AND 300/);
  });

  it("is editable, which is the difference between a column and a feature", () => {
    // Moved 2026-08-28 to the Client portal settings page. The address the
    // footer prints still has to be editable; only its address bar changed.
    const settings = read("src/components/settings/ClientPortalCards.tsx");
    expect(settings).toMatch(/Business address/);
    expect(settings).toMatch(/setContactAddress/);
    expect(settings).toMatch(/contactAddress: contactAddress\.trim\(\) \|\| null/);
    const org = read("src/lib/org.functions.ts");
    expect(org).toMatch(/contactAddress: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(300\)/);
    expect(org).toMatch(/patch\.contact_address = data\.contactAddress/);
    expect(org).toMatch(/contact_phone, contact_email, contact_address/);
  });

  it("caps at the same length in both places", () => {
    // A zod max the CHECK disagrees with turns a validation message into a
    // 500 from Postgres.
    expect(read("src/lib/org.functions.ts")).toMatch(/max\(300\)/);
    expect(migration()).toMatch(/BETWEEN 1 AND 300/);
  });
});
