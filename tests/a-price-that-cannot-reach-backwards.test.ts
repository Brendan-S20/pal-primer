// The invoice priced work that was already done.
//
// `admin_generate_invoice_for_client` joined the SUBSCRIPTION to price a line
// item, so the amount was whatever the subscription carried at INVOICE time,
// not what it carried when the technician finished the yard. Raise a postpaid
// client's rate mid-cycle and every completed-but-uninvoiced visit is billed
// at the new rate.
//
// The repo already knew the rule and applied it twice in the same loop: the
// deep-clean surcharge is read off the visit row "so a later settings change
// cannot retro-price a done deep clean", and a skip is stamped as
// `skip_charge_cents`. The surcharge and the skip were frozen; the price they
// are added to was not.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const migDir = join(root, "supabase/migrations");
const files = readdirSync(migDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const read = (f: string) => readFileSync(join(migDir, f), "utf8");
const SQL = files.map(read).join("\n");

const FREEZE = "20260903150000_the-invoice-priced-work-that-was-already-done.sql";

describe("a completed visit carries its own price", () => {
  const mig = read(FREEZE);

  it("adds the column that holds it", () => {
    expect(mig).toMatch(
      /ALTER TABLE public\.visits\s+ADD COLUMN IF NOT EXISTS price_cents integer/,
    );
  });

  it("stamps the price at the one chokepoint every completion path uses", () => {
    // complete_visit, office_complete_visit, confirm_open_visit and
    // seed_demo_org all PERFORM finalize_visit_completion. Stamping anywhere
    // else would mean four places to keep in step.
    const fn = mig.slice(
      mig.indexOf("CREATE OR REPLACE FUNCTION public.finalize_visit_completion"),
    );
    expect(fn).toMatch(/UPDATE public\.visits\s+SET price_cents = _price/);
  });

  it("never re-prices a visit that already has a price", () => {
    // finalize_visit_completion is reachable more than once for one visit:
    // complete_visit and confirm_open_visit are both idempotent by design, and
    // a replayed offline close-out can land after an office one. Without the
    // guard the LAST completion would price the job.
    const fn = mig.slice(
      mig.indexOf("CREATE OR REPLACE FUNCTION public.finalize_visit_completion"),
    );
    expect(fn).toMatch(/SET price_cents = _price\s+WHERE id = _visit_id AND price_cents IS NULL/);
  });

  it("bills from the visit, falling back to the subscription for older work", () => {
    // The fallback is what makes this safe to ship with no backfill: a visit
    // completed before the column existed bills exactly as it does today.
    expect(mig).toMatch(/COALESCE\(v\.price_cents, s\.price_cents\) AS price_cents/);
  });

  it("is a no-op on a second run rather than a failure", () => {
    // The splice consumes its own anchor, so a missing anchor means one of two
    // opposite things. Migrations normally run once, but this repo applies
    // them to production by hand, and a retry after a partial failure must not
    // be the thing that stops the fix landing.
    const splice = mig.slice(mig.indexOf("DO $splice$"), mig.indexOf("$splice$;"));
    const alreadyAt = splice.indexOf("strpos(_def, _to) > 0");
    const missingAt = splice.indexOf("strpos(_def, _from) = 0");
    expect(alreadyAt, "no already-applied branch").toBeGreaterThan(-1);
    expect(missingAt, "no anchor-moved branch").toBeGreaterThan(-1);
    expect(alreadyAt, "already-applied must be tested first").toBeLessThan(missingAt);
  });

  it("narrows pg_get_functiondef to one named function", () => {
    // Working agreement: it raises on any pg_proc row that is not a plain
    // function, and what lives in public is not the same on every database.
    // Not a balanced-paren match: the argument here is a regprocedure
    // literal that contains its own parens, so read a window after each call
    // site instead and require the cast inside it.
    const sites = [...mig.matchAll(/pg_get_functiondef\(/g)];
    expect(sites.length, "no pg_get_functiondef call to check").toBeGreaterThan(0);
    for (const m of sites) {
      const window = mig.slice(m.index!, m.index! + 160);
      expect(window, `unnarrowed pg_get_functiondef at offset ${m.index}`).toMatch(
        /::regprocedure|proname\s*=\s*'/,
      );
    }
  });

  it("asserts only what a replay into an empty database can prove", () => {
    // No row counts, no tenants, no cron jobs -- every RAISE EXCEPTION here is
    // about an object this file just created or replaced.
    const verify = mig.slice(mig.indexOf("DO $verify$"), mig.indexOf("$verify$;"));
    expect(verify).not.toMatch(/FROM public\.(visits|subscriptions|clients|organizations)\b/);
    expect(verify).not.toMatch(/cron\.job/);
  });
});

describe("nothing else still prices finished work from the subscription", () => {
  it("leaves no later migration that reverts the splice", () => {
    // A later file recreating admin_generate_invoice_for_client from scratch
    // would silently undo this, and nothing else would notice.
    const after = files.filter((f) => f > FREEZE);
    const reverts = after.filter((f) => {
      const body = read(f);
      return (
        body.includes("CREATE OR REPLACE FUNCTION public.admin_generate_invoice_for_client") &&
        !body.includes("COALESCE(v.price_cents, s.price_cents)")
      );
    });
    expect(reverts, `these recreate the invoice function without the freeze: ${reverts}`).toEqual(
      [],
    );
  });

  it("still has the deep-clean surcharge priced off the visit row", () => {
    // The precedent this change follows. If this ever stops being true the
    // rule has been abandoned, not just this one application of it.
    expect(SQL).toMatch(/_v\.deepclean_charge_cents/);
  });
});
