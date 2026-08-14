// Soft-deleting a tenant stopped them receiving a free lead and left their
// signup page able to charge a homeowner's card.
//
// ── HOW IT WAS FOUND ──────────────────────────────────────────────────────
//
// By walking the six SECURITY DEFINER functions `anon` may execute, because
// those are the entire unauthenticated, RLS-bypassing surface of the product.
// All six pin `search_path` and all six return narrow explicit column lists.
// The interesting question turned out not to be whether they were gated, but
// WHICH gate each one had.
//
// ── WHAT `deleted_at` MEANT IN PRACTICE ───────────────────────────────────
//
// `softDeleteTenant` is the only delete the platform has and there is no
// undelete. It patches exactly one column:
//
//     const patch = { deleted_at: new Date().toISOString() };
//
// `plan_status` keeps whatever it was — usually `active`. So does
// `public_signup_enabled`.
//
// `deleted_at` was honoured in nine platform-side reporting reads in `src/`
// and in exactly one database function: `org_accepts_public_leads`, the
// predicate on the anon INSERT policy for `leads`. Nothing on the money path
// looked at it — `public_get_org_by_slug` and `public_quote` gated on
// `public_signup_enabled`, and `org_can_add_client` on `plan_status`.
//
// That is the whole chain behind `createSignupPaymentIntent`, and for a
// deleted tenant every link said yes: the page rendered with their name and
// logo, the quote priced the yard, the entitlement gate passed on an untouched
// `plan_status`, a `signup_requests` row was written, and a PaymentIntent was
// created against their still-connected Stripe account with our 50bps
// application fee on it.
//
// The free thing was gated. The paid thing was not.
//
// ── MEASURED, NOT ASSUMED ─────────────────────────────────────────────────
//
// Proved against the live database by soft-deleting a real org inside a single
// statement that ends in an unconditional RAISE, so the write could not
// survive it:
//
//     LIVE    by_slug=1 lead_form=1 quote=1 can_add_client=t
//     DELETED by_slug=0 lead_form=0 quote=0 can_add_client=f
//
// Before the migration that second row read 1 / 1 / 1 / t.
//
// Latent rather than live: no tenant has ever been soft-deleted, so nobody was
// charged this way and the fix changed the answer for zero existing rows.
//
// ── WHAT THIS TEST PINS, AND WHY IT IS SHAPED THIS WAY ────────────────────
//
// Not the four function bodies — the RULE. A function here is defined by
// CREATE OR REPLACE across many migrations, so the only definition that
// matters is the LAST one, and the way this regresses is somebody replacing
// one of these later for an unrelated reason and dropping a line they did not
// know was load-bearing. So the test finds whichever migration defines each
// function last and asserts against that, which is what the database actually
// has.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(import.meta.dirname, "..", "supabase", "migrations");

const files = () =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();

/**
 * The body of the LAST `CREATE OR REPLACE FUNCTION public.<name>` in migration
 * order — i.e. the definition the live database ends up with.
 *
 * Returns the text from the CREATE through its closing `$$;`, so an assertion
 * cannot accidentally match a neighbouring function in the same file. This
 * migration defines five functions in one file, and a whole-file `toMatch`
 * would pass on any one of them carrying the filter.
 */
function currentDefinition(name: string): { file: string; body: string } {
  let found: { file: string; body: string } | null = null;
  for (const f of files()) {
    const src = readFileSync(join(MIGRATIONS, f), "utf8");
    // Last occurrence within the file too — a file may replace one twice.
    const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\b`, "g");
    let start = -1;
    for (const m of src.matchAll(re)) start = m.index!;
    if (start === -1) continue;
    const end = src.indexOf("$$;", start);
    found = { file: f, body: src.slice(start, end === -1 ? undefined : end + 3) };
  }
  if (!found) throw new Error(`no CREATE OR REPLACE for public.${name} in any migration`);
  return found;
}

describe("a closed account resolves to nothing on every public path", () => {
  // The two that actually take the money. `public_quote` is the one
  // `createSignupPaymentIntent` calls first and throws on, so it is the link
  // that stops the charge; `public_get_org_by_slug` is what stops the deleted
  // business's storefront rendering at all.
  it.each(["public_get_org_by_slug", "public_quote"])(
    "%s will not resolve a soft-deleted org",
    (fn) => {
      const { body } = currentDefinition(fn);
      expect(body).toMatch(/o\.deleted_at IS NULL/);
      // The signup gate is a SEPARATE decision and must stay — dropping it
      // would open every deleted-and-live org's signup page instead.
      expect(body).toMatch(/o\.public_signup_enabled = true/);
    },
  );

  it("the lead form agrees with the policy that already blocked it", () => {
    // Not a hole: the anon INSERT policy on `leads` calls
    // `org_accepts_public_leads`, which has always checked deleted_at. But the
    // endpoint resolved the org through this function and then inserted, so
    // the block arrived as an RLS error and /api/public/leads answered 500
    // with a Postgres message instead of the 404 it has for exactly this case.
    const { body } = currentDefinition("public_get_org_for_lead_form");
    expect(body).toMatch(/o\.deleted_at IS NULL/);
  });

  it("parenthesises the slug OR, which is where this fix could silently fail", () => {
    // The original read `where o.portal_slug = _slug or o.slug = _slug`. AND
    // binds tighter than OR, so appending the filter without adding brackets
    // gives
    //     portal_slug = _slug OR (slug = _slug AND deleted_at IS NULL)
    // and a deleted org still matches on portal_slug — the exact case this is
    // for, still open, with the reassuring line present in the diff.
    for (const fn of ["public_get_org_by_slug", "public_quote", "public_get_org_for_lead_form"]) {
      const { body } = currentDefinition(fn);
      expect(body, `${fn} must bracket the portal_slug/slug OR`).toMatch(
        /\(\s*o\.portal_slug = _slug OR o\.slug = _slug\s*\)/,
      );
    }
  });
});

describe("and no new customers behind the scenes either", () => {
  it("org_can_add_client refuses a closed account before it reads the plan", () => {
    // Order matters. The soft delete does not touch plan_status, so a deleted
    // tenant reads as 'active' here for ever; the deleted branch has to come
    // FIRST or it never decides anything.
    const { body } = currentDefinition("org_can_add_client");
    const deleted = body.indexOf("deleted_at IS NOT NULL");
    const planStatus = body.indexOf("plan_status IN ('active', 'past_due')");
    expect(deleted).toBeGreaterThan(-1);
    expect(planStatus).toBeGreaterThan(-1);
    expect(deleted).toBeLessThan(planStatus);
  });

  it("keeps every reason a live tenant is allowed to add customers", () => {
    // The failure mode of tightening a gate is tightening it too far. A
    // past_due tenant, one mid-trial, a free plan and an admin grace window
    // must all still pass — this is the check that runs before a signup and
    // inside the trigger on `clients`, so a mistake here stops working
    // businesses from taking on customers.
    const { body } = currentDefinition("org_can_add_client");
    expect(body).toMatch(/plan_status IN \('active', 'past_due'\)/);
    expect(body).toMatch(/plan_status = 'trialing'/);
    expect(body).toMatch(/plan_status = 'free'/);
    expect(body).toMatch(/grace_expires_at IS NOT NULL AND o\.grace_expires_at > now\(\)/);
    // And it still refuses to answer about someone else's tenant.
    expect(body).toMatch(/is_org_member\(auth\.uid\(\), _org_id\)/);
  });

  it("the trigger explains a closed account instead of blaming the plan", () => {
    // tg_clients_enforce_plan_limit explains a refusal by re-reading
    // plan_status. A deleted tenant's is still 'active', so without its own
    // branch the message would have been "Your current plan status (active)
    // doesn't allow adding customers. Visit Settings → Billing to update your
    // plan." — an error naming a healthy plan and pointing at a page that
    // cannot fix it. A support ticket manufactured by an error message.
    const { body } = currentDefinition("tg_clients_enforce_plan_limit");
    expect(body).toMatch(/_deleted/);
    expect(body).toMatch(/business account has been closed/);
    const deletedBranch = body.indexOf("IF _deleted THEN");
    const canceledBranch = body.indexOf("_status = 'canceled'");
    expect(deletedBranch).toBeGreaterThan(-1);
    expect(deletedBranch).toBeLessThan(canceledBranch);
    // The three existing messages are still there and still distinguishable.
    expect(body).toMatch(/subscription is canceled/);
    expect(body).toMatch(/free trial has ended/);
  });

  it("does not turn the trigger function into a callable RPC", () => {
    // 20260810140000 revoked exactly this class, and a CREATE OR REPLACE in a
    // later migration is a normal way to hand the grant back by accident.
    const { file } = currentDefinition("tg_clients_enforce_plan_limit");
    const src = readFileSync(join(MIGRATIONS, file), "utf8");
    expect(src).toMatch(
      /REVOKE ALL ON FUNCTION public\.tg_clients_enforce_plan_limit\(\) FROM anon, authenticated/,
    );
    expect(src).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.tg_clients_enforce_plan_limit\(\)[^;]*(anon|authenticated)/,
    );
  });
});
