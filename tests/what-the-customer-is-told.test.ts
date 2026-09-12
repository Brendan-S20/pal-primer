// Three things the customer-facing half told people that were not true.
//
//  1. The OTP email — a one-time LOGIN CODE — carried `List-Unsubscribe` and
//     `List-Unsubscribe-Post: One-Click`. /unsubscribe writes the address into
//     `suppressed_emails` globally and both senders fail closed on it, so a
//     customer who tapped unsubscribe on a login code, or whose mail client
//     fired the one-click POST while scanning the message, stopped receiving
//     their invoices and receipts. Neither they nor the office were told, and
//     the code kept working, because that send POSTs Resend directly and never
//     checks suppression.
//  2. The public pay page kept a private copy of the date logic:
//     `dueOn < new Date().toISOString().slice(0,10)` — the SERVER's day, which
//     src/lib/overdue.ts documents as a fixed bug. Every evening from 19:00
//     local, a customer's own payment page stamped OVERDUE on a bill due that
//     day.
//  3. Photos were captioned by their position in an array while
//     `visit_photos.kind` sat populated and ignored — so an `issue` photo,
//     taken to document a problem, was served to the customer as a routine
//     before-and-after.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const SQL = readdirSync(join(root, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(root, "supabase/migrations", f), "utf8"))
  .join("\n");

describe("a login code is not a mailing list", () => {
  const auth = strip(read("src/lib/portal-auth.server.ts"));

  it("sends no unsubscribe header on a one-time code", () => {
    expect(auth).not.toMatch(/List-Unsubscribe/);
    expect(auth).not.toMatch(/One-Click/);
  });

  it("mints no unsubscribe token for it either", () => {
    // The token row was the other half: it exists to be redeemed, and the only
    // thing redeeming it does is suppress the address.
    expect(auth).not.toMatch(/email_unsubscribe_tokens/);
  });

  it("still sends the code, and still logs the send", () => {
    // The point is to remove one opt-out header, not to break the login email.
    //
    // Read RAW rather than through `strip`: comment-stripping by `//` eats the
    // scheme separator out of every URL in the file, so a check for an
    // endpoint has to look at the real text.
    const raw = read("src/lib/portal-auth.server.ts");
    expect(raw).toMatch(/api\.resend\.com\/emails/);
    expect(auth).toMatch(/portal-otp-\$\{randomBytes\(8\)\.toString\("hex"\)\}/);
    expect(auth).toMatch(/verification code`,/);
  });
});

describe("the pay page dates overdue in the org's day", () => {
  const page = strip(read("src/routes/pay.i.$token.tsx"));

  it("has no private copy of the date logic", () => {
    expect(page).not.toMatch(/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
    expect(page).not.toMatch(/function isOverdue/);
  });

  it("asks the shared helper, with the organization's timezone", () => {
    expect(page).toMatch(/import \{ isInvoiceOverdue, todayISO \} from "@\/lib\/overdue"/);
    expect(page).toMatch(/todayISO\(data\.orgTimezone \?\? undefined\)/);
  });

  it("is given a timezone to use", () => {
    const fns = strip(read("src/lib/invoices.functions.ts"));
    expect(fns).toMatch(/organizations\(name, timezone\)/);
    expect(fns).toMatch(/orgTimezone: \(org\?\.timezone \?\? null\) as string \| null/);
  });
});

describe("a photo is labelled by what it is", () => {
  it("returns the kind alongside the path", () => {
    const fn = SQL.slice(
      SQL.lastIndexOf("CREATE OR REPLACE FUNCTION public.portal_list_recent_visits"),
    );
    const body = fn.slice(0, fn.indexOf("$function$;"));
    expect(body).toMatch(/photo_kinds text\[\]/);
    expect(body).toMatch(/SELECT vp\.kind::text FROM public\.visit_photos vp/);
  });

  it("orders both arrays by the same total order", () => {
    // Parallel arrays are only safe if index i means the same thing in both.
    // `created_at` alone is not a total order — a seeder writes a visit's
    // photos in one statement, so they share a timestamp to the microsecond.
    const fn = SQL.slice(
      SQL.lastIndexOf("CREATE OR REPLACE FUNCTION public.portal_list_recent_visits"),
    );
    const body = fn.slice(0, fn.indexOf("$function$;"));
    expect(body.match(/ORDER BY vp\.created_at, vp\.id/g) ?? []).toHaveLength(2);
  });

  it("stops counting positions to decide what a photo shows", () => {
    const ui = strip(read("src/lib/portal-ui.tsx"));
    expect(ui).not.toMatch(/i % 2 === 0 \? "Before" : "After"/);
    // `\s*` rather than a literal space: the rule is that the caption comes
    // from the photo's KIND and not from its position in the array, and that
    // is true however prettier chooses to break the ternary. It got broken
    // across lines when the caption moved to module scope so the full-size
    // viewer could show the same word as the thumbnail -- a customer tapping
    // "After" must not be handed a heading that says "completion".
    expect(ui).toMatch(/kind === "before"\s*\? "Before"/);
    expect(ui).toMatch(/kind === "completion"\s*\? "After"/);
    expect(ui).toMatch(/kind === "issue"\s*\? "Issue"/);
  });

  it("says nothing rather than guessing at an unknown kind", () => {
    const ui = strip(read("src/lib/portal-ui.tsx"));
    expect(ui).toMatch(/: null;/);
    expect(ui).toMatch(/\{caption && \(/);
  });

  it("has a third state for a photo that will not load", () => {
    // A signed URL that 404s used to render the browser's broken-image glyph
    // to a paying customer, and no URL at all rendered a skeleton that pulses
    // for ever. My Day's PhotoThumb has had this split for a while.
    const ui = strip(read("src/lib/portal-ui.tsx"));
    expect(ui).toMatch(/onError=\{\(\) => setBroken\(true\)\}/);
    expect(ui).toMatch(/Photo unavailable/);
    expect(ui).toMatch(/disabled=\{!url \|\| broken\}/);
  });
});
