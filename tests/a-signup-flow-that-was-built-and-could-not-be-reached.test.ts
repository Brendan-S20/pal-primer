// Step four of the audit: the whole public homeowner signup flow — quote, card
// form, webhook provisioning, welcome email — was finished, tested, deployed,
// and unreachable by any tenant. Six things had to be true at once for it to
// work and four of them were not.
//
//   the second gate     /signup/{slug} resolved on `organizations.slug`, a
//                       column nothing in the product ever writes.
//                       `bootstrap_organization` — the only way a tenant is
//                       created — inserts name, plan_status, billing_status and
//                       trial_ends_at, and no slug. NULL = 'anything' is NULL,
//                       so the lookup matched no row and the page said "this
//                       company isn't taking online signups right now" to
//                       everyone, for ever, with no error anywhere.
//
//   the phone           the same NULL is live today. The AI receptionist's
//                       get_pricing_quote tool calls public_quote with
//                       `(org as any).slug ?? ""`, from both Twilio hooks. With
//                       slug NULL, every caller in every ZIP the tenant serves
//                       is told there is no service in their area, confidently
//                       and instantly, on the tenant's own inbound line.
//
//   the money           a signup that charged the card and then failed to
//                       provision kept the money. `provisionSignup` wrote
//                       status 'failed' and stopped; there is no reconcile job
//                       for signup_requests, and the success page told the
//                       customer "we got your payment, but hit a snag."
//
//   the duplicate       it blind-INSERTed a client, so the same email signing
//                       up twice produced two customers with two portal tokens
//                       and two welcome emails, only one of which showed the
//                       service that had just been bought.
//
//   the empty schedule  every other path that creates a subscription calls
//                       generateVisitHorizon. This one did not, so a homeowner
//                       who had just prepaid saw no visits until the nightly
//                       job.
//
//   the wrong logo      /signup/{slug} rendered inside HoundStack's marketing
//                       shell: our wordmark, our "Sign in" link, houndstack.com
//                       in the footer. A prospect mid-purchase was shown their
//                       supplier's brand and offered a link away to it.
//
// ── THE ONE THING THAT CHANGED THE SHAPE OF THE FIX ───────────────────────
//
// The obvious remedy for the second gate is "make bootstrap_organization write
// a slug". That fixes tenants created after the change and leaves every
// existing one exactly as broken, needing a backfill nobody would remember to
// run. `portal_slug` is the column the product actually maintains — Settings
// writes it, `ensureOrgSlug` backfills it, the portal and the lead form are
// both addressed by it — and 20260711120000 had already hit this identical
// defect on the lead form and solved it by resolving `portal_slug OR slug`.
//
// So the fix is that one, applied to the two functions it was explicitly not
// applied to at the time. The `public_signup_enabled` gate stays, because that
// one is a real decision: capturing a lead and taking a card are not the same
// permission, which is the whole reason the lead form was decoupled.
//
// ── AND ONE CLAIM IN THE PRODUCT THAT WAS SIMPLY FALSE ────────────────────
//
// Settings → Lead form warned owners that the hosted form "won't accept
// submissions" while public signup was off. It has never been true since that
// same 20260711120000: `public_get_org_for_lead_form` does not look at the
// boolean at all. The warning told owners a working feature was broken and
// pointed them at a switch that would not have fixed it.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every file here explains its bug by quoting the broken code, so a bare
 *  `not.toMatch` fails against the prose documenting the fix rather than
 *  against the fix. Negative assertions run on the source with comment lines
 *  stripped. Crude and line-based on purpose: it does not need to be a parser,
 *  it needs to stop comments from impersonating code. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--"));
    })
    .join("\n");

const MIGRATION = readdirSync(join(ROOT, "supabase", "migrations")).find(
  (f) => f.startsWith("20260809001000_") && f.endsWith(".sql"),
);

describe("the signup lookup resolves an address that actually exists", () => {
  it("ships as a migration, not as an edit to an applied one", () => {
    expect(MIGRATION).toBeDefined();
  });

  const sql = read(join("supabase", "migrations", MIGRATION!));

  it("both public RPCs resolve portal_slug as well as the legacy slug", () => {
    // Two functions, and missing either one is its own outage: the page
    // resolves through public_get_org_by_slug, the price through public_quote.
    // A fix applied to one leaves a signup page that loads and cannot quote.
    const byslug = sql.slice(sql.indexOf("CREATE FUNCTION public.public_get_org_by_slug"));
    expect(byslug.slice(0, 900)).toMatch(/o\.portal_slug = _slug OR o\.slug = _slug/);
    const quote = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.public_quote"));
    expect(quote.slice(0, 1200)).toMatch(/o\.portal_slug = _slug OR o\.slug = _slug/);
  });

  it("and keeps the gate that was never the problem", () => {
    // public_signup_enabled is the tenant's decision to sell online. Dropping
    // it while fixing the slug would open every tenant's signup page — the
    // opposite failure, and a worse one.
    const byslug = sql.slice(sql.indexOf("CREATE FUNCTION public.public_get_org_by_slug"));
    expect(byslug.slice(0, 900)).toMatch(/public_signup_enabled = true/);
    const quote = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.public_quote"));
    expect(quote.slice(0, 1200)).toMatch(/public_signup_enabled = true/);
  });

  it("resolves deterministically rather than however the planner feels", () => {
    // One tenant's legacy `slug` can equal another's `portal_slug`. Without an
    // ORDER BY, which business a prospect reaches is a plan detail.
    expect(sql).toMatch(/ORDER BY \(o\.portal_slug = _slug\) DESC NULLS LAST/);
  });

  it("keeps the ZIP normalization public_quote already had", () => {
    // 20260717140000 moved trimming into the RPC so an untrimmed caller — named
    // in its header as the AI receptionist — stops getting "no service".
    // Rewriting the function is exactly how that gets dropped, so the migration
    // asserts it before and after.
    expect(sql).toMatch(/btrim\(coalesce\(_postal_code/);
    expect(sql).toMatch(/lost its ZIP normalization/);
  });

  it("says out loud that this is answering the phone wrong today", () => {
    // The header is the only place a reader learns the defect is not dormant.
    expect(sql).toMatch(/ai-receptionist\.server\.ts/);
    expect(sql).toMatch(/twilio-voice\.ts/);
  });

  it("asserts what it is replacing, and asserts the replacement took", () => {
    expect(sql).toMatch(/DO \$pre\$/);
    expect(sql).toMatch(/DO \$post\$/);
    // The DROP takes the grants with it, and losing anon fails in exactly the
    // same silent way the bug did: an unavailable page.
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.public_get_org_by_slug\(text\) TO anon/);
    expect(sql).toMatch(/has_function_privilege\('anon'/);
  });

  it("the receptionist still reads the org's slug, which is now enough", () => {
    // Nothing changes in TypeScript here — the fix is that `slug ?? ""` stops
    // being the only thing the RPC will match on. Pinned so a later "cleanup"
    // of these call sites is a deliberate decision rather than a silent one.
    expect(read("src/lib/ai-receptionist.server.ts")).toMatch(/_slug: input\.orgSlug/);
    expect(read("src/routes/api/public/hooks/twilio-voice.ts")).toMatch(/orgSlug:/);
    expect(read("src/routes/api/public/hooks/twilio.ts")).toMatch(/orgSlug:/);
  });
});

describe("the card is not charged before the tenant is allowed to take a client", () => {
  const fns = read("src/lib/signup.functions.ts");

  it("the entitlement gate runs before the PaymentIntent exists", () => {
    // org_can_add_client is enforced by a trigger on `clients`, which fires in
    // the webhook — after the money has moved. Checking it here is the
    // difference between declining a sale and refunding one.
    const gateAt = fns.indexOf("org_can_add_client");
    const piAt = fns.indexOf("stripe.paymentIntents.create");
    expect(gateAt).toBeGreaterThan(-1);
    expect(piAt).toBeGreaterThan(gateAt);
  });

  it("and before a signup_requests row is even written", () => {
    const gateAt = fns.indexOf("org_can_add_client");
    const insertAt = fns.indexOf('.from("signup_requests")\n      .insert(');
    expect(insertAt).toBeGreaterThan(gateAt);
  });

  it("an error in the gate does not close every tenant's signup page", () => {
    // "Could not check" is not "no". Only an explicit false stops the flow.
    const block = fns.slice(fns.indexOf("org_can_add_client"), fns.indexOf("const { data: sr,"));
    expect(block).toMatch(/canAdd === false/);
    expect(block).toMatch(/console\.error\("signup entitlement check failed"/);
  });

  it("and what the prospect is told names no plan state", () => {
    // The homeowner cannot act on "their subscription lapsed", and the tenant
    // would rather it not be announced to their prospects.
    const block = codeOnly(fns.slice(fns.indexOf("canAdd === false")));
    expect(block.slice(0, 600)).toMatch(/isn't accepting new online signups right now/);
    expect(block.slice(0, 600)).not.toMatch(/seat|plan|subscription|canceled/i);
  });
});

describe("a signup that cannot be provisioned gives the money back", () => {
  const hook = read("src/routes/api/public/hooks/stripe.ts");
  const provision = hook.slice(0, hook.indexOf("export const Route"));

  it("the refund happens in the catch that marks the request failed", () => {
    // Comments stripped: the prose above the function names refunds.create
    // while explaining why the intent id is carried separately, which would
    // otherwise satisfy this ordering without any refund existing.
    const code = codeOnly(provision);
    const catchAt = code.indexOf('console.error("provisionSignup failed"');
    expect(catchAt).toBeGreaterThan(-1);
    expect(code.indexOf("refunds.create")).toBeGreaterThan(catchAt);
    // And the row is only marked failed after the refund has been attempted,
    // so the write that records the outcome carries the refund's id.
    expect(code.indexOf("refundPatch.stripe_refund_id")).toBeLessThan(
      code.indexOf('.from("signup_requests").update(refundPatch)'),
    );
  });

  it("against the payment intent, not the checkout session id", () => {
    // The legacy Checkout path's stripeRef is a session id, which
    // refunds.create will not accept. It is carried separately for that reason.
    expect(provision).toMatch(/payment_intent: paid\.paymentIntentId/);
    expect(provision).toMatch(/paymentIntentId: string \| null/);
  });

  it("on the tenant's connected account, where a direct charge lives", () => {
    expect(provision).toMatch(/stripeAccount: refundVia\.stripeAccount/);
    // Both call sites have to supply it or the refund silently finds nothing.
    const calls = hook.match(/await provisionSignup\(/g) ?? [];
    expect(calls.length).toBe(2);
    expect(
      (hook.match(/\{ stripe, stripeAccount: event\.account \?\? null \}/g) ?? []).length,
    ).toBe(2);
  });

  it("and reverses our platform fee with it", () => {
    // Keeping 50 bps on a sale that was unwound because WE failed would be
    // charging the tenant for our own defect. This is the one refund the app
    // issues itself, so the fee comes back in the same call rather than through
    // the charge.refunded reconciliation.
    expect(provision).toMatch(/refund_application_fee: true/);
    expect(read("src/lib/platform-fee.ts")).toMatch(/ONE refund this app issues itself/);
  });

  it("exactly once, however many times Stripe redelivers the event", () => {
    // Two independent guards, because they fail differently: the idempotency
    // key protects the Stripe side even if this process dies mid-call, and the
    // refunded_at check stops a redelivery from provisioning a signup whose
    // money has already gone back.
    expect(provision).toMatch(/idempotencyKey: `signup-refund-\$\{signupRequestId\}`/);
    expect(provision).toMatch(/if \(sr\.refunded_at\)/);
  });

  it("a refund that itself fails is written down, not swallowed", () => {
    const block = provision.slice(provision.indexOf("catch (refundErr)"));
    expect(block.slice(0, 800)).toMatch(/refund .*manually|manually/i);
    // And refunded_at stays null, so the success page cannot promise a refund
    // that did not happen.
    expect(codeOnly(block.slice(0, 800))).not.toMatch(/refunded_at/);
  });

  it("and the customer is told which of those actually happened", () => {
    const page = read("src/routes/signup.success.tsx");
    expect(page).toMatch(/refunded your\s*\n?\s*card in full|refunded your card in full/);
    expect(page).toMatch(/You will not be left paying for a service you don't have/);
    // The old page said "Payment received!" over a green tick even when
    // provisioning had failed.
    expect(page).toMatch(/We couldn't finish setting up your account/);
  });
});

describe("the same person does not get two accounts", () => {
  const hook = read("src/routes/api/public/hooks/stripe.ts");
  const provision = hook.slice(0, hook.indexOf("export const Route"));

  it("an existing client with that email in that org is reused", () => {
    const block = provision.slice(provision.indexOf("const email = "));
    expect(block.slice(0, 1200)).toMatch(/\.eq\("organization_id", sr\.organization_id\)/);
    expect(block.slice(0, 1200)).toMatch(/\.ilike\("primary_email", email\)/);
  });

  it("and the ilike is only a pre-filter — the match is exact and lowercased", () => {
    // `_` and `%` are LIKE wildcards and both are legal in an email
    // local-part, so `a_b@x.com` would also match `axb@x.com`. Wildcards can
    // only over-match, so re-checking each candidate in JS is what makes this
    // mean "(organization_id, lower(primary_email))" and not something looser.
    const block = provision.slice(provision.indexOf("const email = "));
    expect(block.slice(0, 1200)).toMatch(
      /\(c\.primary_email \?\? ""\)\.trim\(\)\.toLowerCase\(\) === email/,
    );
  });

  it("attaching does not overwrite what the office has been maintaining", () => {
    // A signup form is not more authoritative than the record the business has
    // been correcting for a year.
    const block = provision.slice(
      provision.indexOf("if (existing) {"),
      provision.indexOf("// Create property"),
    );
    expect(codeOnly(block)).not.toMatch(/\.update\(/);
  });
});

describe("a new customer has a schedule before they close the tab", () => {
  const hook = read("src/routes/api/public/hooks/stripe.ts");
  const provision = hook.slice(0, hook.indexOf("export const Route"));

  it("visits are generated right after the subscription is created", () => {
    const subAt = provision.indexOf('.from("subscriptions").insert(');
    const genAt = provision.indexOf("generateVisitHorizon");
    expect(genAt).toBeGreaterThan(subAt);
  });

  it("and a failure there cannot turn a completed sale into a refund", () => {
    // Provisioning has already succeeded by that line. If generation threw, it
    // would land in the catch below, mark a provisioned signup 'failed' and
    // refund a customer who has an account. The schedule being late must not be
    // able to become the sale being reversed.
    const block = provision.slice(provision.indexOf("generateVisitHorizon") - 200);
    expect(block.slice(0, 800)).toMatch(/try \{[\s\S]*generateVisitHorizon[\s\S]*catch/);
    expect(block).toMatch(/console\.error\("signup visit generation failed"/);
  });
});

describe("an owner can find, turn on and copy their signup link", () => {
  const page = read("src/routes/_authenticated/settings.online-signup.tsx");
  const fns = read("src/lib/signup.functions.ts");

  it("the settings page exists and is registered in the nav", () => {
    expect(read("src/routes/_authenticated/settings.tsx")).toMatch(
      /\{ label: "Online signup", to: "\/settings\/online-signup" \}/,
    );
  });

  it("it writes both gates: the toggle and the address", () => {
    expect(page).toMatch(/publicSignupEnabled: v/);
    expect(page).toMatch(/signupSlug: slug\.trim\(\)/);
    expect(fns).toMatch(/patch\.public_signup_enabled = data\.publicSignupEnabled/);
    expect(fns).toMatch(/patch\.slug = clean \|\| null/);
  });

  it("through the helper that refuses a zero-row update", () => {
    // A bare .update() returns no error when RLS matches nothing, so the toggle
    // would show a success toast and be back off on reload. That is the exact
    // class of bug org-write.server.ts exists to make impossible.
    const setter = fns.slice(fns.indexOf("export const setSignupSettings"));
    expect(setter).toMatch(/updateOwnOrg/);
    expect(codeOnly(setter)).not.toMatch(/\.from\("organizations"\)\s*\n?\s*\.update\(/);
  });

  it("and shows the URL the RPC will actually answer on", () => {
    // Showing the signup slug when portal_slug is what resolves would hand out
    // a link that fails for precisely the reason this page exists.
    expect(page).toMatch(
      /cfg\?\.portalSlug \|\| \(slug\.trim\(\) \? slug\.trim\(\) : cfg\?\.signupSlug\)/,
    );
    expect(page).toMatch(/\/signup\/\$\{effective\}/);
    expect(page).toMatch(/Copy link/);
    expect(page).toMatch(/Preview/);
  });

  it("an address already in use is refused before Postgres says so", () => {
    // organizations.slug is UNIQUE, so a collision would surface as a raw 23505
    // with the constraint name in it. portal_slug is checked too even though it
    // is not unique in the database, because since the migration both columns
    // answer at /signup/{…}.
    const setter = fns.slice(fns.indexOf("export const setSignupSettings"));
    expect(setter).toMatch(/slug\.eq\.\$\{clean\},portal_slug\.eq\.\$\{clean\}/);
    expect(setter).toMatch(/already taken/);
  });
});

describe("a tenant's prospect sees the tenant", () => {
  const signup = read("src/routes/signup.$slug.tsx");
  const success = read("src/routes/signup.success.tsx");

  it("neither signup page wears our marketing shell any more", () => {
    // MarketingLayout renders HoundStack's wordmark linking to houndstack.com,
    // a "Sign in" link into the staff app, and houndstack.com again in the
    // footer — all correct for our own pages, all wrong on a page where
    // somebody is about to hand a card to a different company.
    expect(codeOnly(signup)).not.toMatch(/MarketingLayout/);
    expect(codeOnly(success)).not.toMatch(/MarketingLayout/);
    expect(signup).toMatch(/<TenantSignupShell/);
    expect(success).toMatch(/<TenantSignupShell/);
  });

  it("branding comes from the one lookup the page already makes", () => {
    // The lead form solves this by reading lead_form_config; signup has no such
    // config, so public_get_org_by_slug returns the org's own logo and colour.
    const sql = read(join("supabase", "migrations", MIGRATION!));
    expect(sql).toMatch(/o\.logo_url, o\.brand_color/);
    expect(signup).toMatch(/logoUrl=\{org\.logo_url\} brandColor=\{org\.brand_color\}/);
  });

  it("and the shell carries nothing of ours", () => {
    const shell = read("src/components/marketing/TenantSignupShell.tsx");
    expect(codeOnly(shell)).not.toMatch(/houndstack\.com/);
    expect(codeOnly(shell)).not.toMatch(/APP_NAME|<Logo/);
    // Not even a way out: every link MarketingLayout carried is either a dead
    // end for a homeowner or an exit from the checkout they are in.
    expect(codeOnly(shell)).not.toMatch(/to="\/auth"/);
  });

  it("but the compliance links survive the rebrand", () => {
    // This is the half of the edit that was easy to get wrong. The signup page
    // takes a card AND collects a phone number, and MarketingLayout's footer
    // was the only thing linking Privacy, Terms and SMS Consent from it —
    // PublicFooter's own docstring says Twilio's toll-free reviewers look for
    // exactly those, on exactly the pages where phone numbers are collected.
    // Dropping the branding and the disclosures together would have taken a
    // public page out of compliance while looking like a styling change.
    const shell = read("src/components/marketing/TenantSignupShell.tsx");
    expect(shell).toMatch(/to="\/legal\/privacy"/);
    expect(shell).toMatch(/to="\/legal\/terms"/);
    expect(shell).toMatch(/to="\/legal\/sms"/);
  });

  it("and the layout it replaced is deleted, not left compiled and unreachable", () => {
    // Its only two callers were these routes. scripts/check-dead-machinery.mjs
    // flags a module nothing reachable from src/routes imports, and the honest
    // answer to that flag is deletion rather than a baseline entry.
    expect(() => read("src/components/marketing/MarketingLayout.tsx")).toThrow();
  });
});

describe("the lead form stops calling itself broken", () => {
  const page = read("src/routes/_authenticated/settings.lead-form.tsx");

  it("the claim that submissions are blocked is gone", () => {
    expect(codeOnly(page)).not.toMatch(/won't accept submissions/);
  });

  it("because it was never true", () => {
    // The decoupling is in the migration header and in the endpoint: the lead
    // form resolves through public_get_org_for_lead_form, which does not look
    // at public_signup_enabled at all.
    const leadFormSql = read("supabase/migrations/20260711120000_lead-form-org-resolution.sql");
    expect(leadFormSql).toMatch(/don't gate\s*\n?--\s*on public_signup_enabled/);
    const rpc = leadFormSql.slice(leadFormSql.indexOf("create or replace function"));
    expect(rpc).not.toMatch(/public_signup_enabled/);
    expect(read("src/routes/api/public/leads.ts")).toMatch(/public_get_org_for_lead_form/);
  });

  it("and what replaced it says the true thing", () => {
    expect(page).toMatch(/collects leads whether or not you take signups online/);
    expect(page).toMatch(/to="\/settings\/online-signup"/);
  });
});
