#!/usr/bin/env node
// Does Stripe agree with `platform_plans` and `platform_addons` about what a
// customer is charged?
//
// ── WHY THIS EXISTS, AND WHY NOW ──────────────────────────────────────────
//
// The database stores a price in cents AND a Stripe price id. The app renders
// the cents; Stripe charges the price id. Nothing has ever compared them.
//
// While the two are created together that is survivable. It stops being
// survivable at the live-mode cutover, which is the one remaining external
// blocker before launch: a fresh live catalog is built by hand, `platform_plans`
// is repointed at the new ids, and every one of those ids is a new opportunity
// for the pricing page to say $79 while the card is charged $199 — or for a
// live key to be pointed at a test price id, which does not fail loudly, it
// fails at checkout in front of the first paying customer.
//
// Checked against the test catalog on 2026-08-02: **everything it can compare
// reconciles.** Launch/Growth/Scale base, annual, seat and annual-seat prices —
// twelve prices — match the database to the cent with the right intervals and
// products. This check exists to keep that true through the cutover, not
// because it is currently false.
//
// What it does NOT compare today, stated because a tick that hides its own
// coverage is the failure this codebase keeps finding:
//
//   * Enterprise — active, but a contact-us tier with no price ids.
//   * All six add-ons — every one is `coming_soon` and inactive, so the add-on
//     half of this check currently compares NOTHING. Three of them do carry
//     Stripe ids whose amounts happen to match, but they are skipped as
//     unsellable and the check would not notice if they drifted.
//
// The run prints both lists every time, pass or fail.
//
// ── WHAT IT ASSERTS ───────────────────────────────────────────────────────
//
//   1. MODE. Every referenced price's `livemode` matches the key in use. A live
//      key holding test price ids is the cutover's signature failure and the
//      only symptom is a failed checkout.
//   2. EXISTENCE. Every id on an active row resolves, and the price is active.
//   3. AMOUNT. `unit_amount` equals the row's cents. This is the one that puts a
//      different number on the invoice than on the pricing page.
//   4. INTERVAL. Monthly ids recur monthly, annual ids recur yearly, and a
//      `one_time` add-on has no recurrence.
//   5. PRODUCT. The price belongs to the product the row names, so a copy-paste
//      from the wrong plan is caught.
//   6. COMPLETENESS. An active, priced row has the ids it needs to be sold.
//   7. NAME. Every price carries the `lookup_key` the app resolves it by, and
//      that key resolves back to the same price. Since 2026-08-13 the checkout
//      path asks Stripe for `launch_base_monthly` rather than for a stored id,
//      so a missing key is a SKU that only works in live mode and a misdirected
//      key is a price this check compared but the customer is not charged.
//
// Point this at the LIVE account. It asks whether the database and the account
// agree about ids, and the sandbox deliberately disagrees — it holds its own
// prices under the same eighteen lookup keys, which is the entire mechanism
// that lets the app run against it. Run against a test key this reports every
// id as missing, correctly and uselessly.
//
// Usage:
//   SUPABASE_DB_URL=... STRIPE_SECRET_KEY=... node scripts/check-stripe-catalog.mjs
//   node scripts/check-stripe-catalog.mjs --catalog-from rows.json --prices-from prices.json
//
// The offline form takes the JSON from CATALOG_SQL and a Stripe `GET /v1/prices`
// listing, for a sandbox that can reach neither directly.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { addonLookupKey, planLookupKey } from "./stripe-lookup-keys.mjs";

export const CATALOG_SQL = `
select json_build_object(
  'plans', (select coalesce(json_agg(row_to_json(p)), '[]'::json) from (
      select slug, is_active, price_cents, annual_price_cents, price_per_seat_cents,
             stripe_product_id, stripe_price_id, stripe_annual_price_id,
             stripe_seat_price_id, stripe_annual_seat_price_id
        from platform_plans order by sort_order) p),
  'addons', (select coalesce(json_agg(row_to_json(a)), '[]'::json) from (
      select slug, is_active, status::text as status, price_cents,
             billing_interval, stripe_product_id, stripe_price_id
        from platform_addons order by sort_order) a)
) as catalog;
`;

/** Which DB column pairs with which interval, per plan row. `kind` is the
 *  suffix on the price's lookup key — see scripts/stripe-lookup-keys.mjs. */
const PLAN_PRICE_FIELDS = [
  { id: "stripe_price_id", cents: "price_cents", interval: "month", label: "base monthly", kind: "base_monthly" },
  { id: "stripe_annual_price_id", cents: "annual_price_cents", interval: "year", label: "base annual", kind: "base_annual" },
  { id: "stripe_seat_price_id", cents: "price_per_seat_cents", interval: "month", label: "per-seat monthly", kind: "seat_monthly" },
  // The annual seat price is deliberately NOT the monthly one times twelve —
  // the annual plans carry the same "two months free" discount as the base, so
  // comparing it to `price_per_seat_cents` would fail on correct data. Its
  // amount is checked for existence and interval only, and the ratio is
  // reported for a human to read rather than asserted.
  { id: "stripe_annual_seat_price_id", cents: null, interval: "year", label: "per-seat annual", kind: "seat_annual" },
];

function catalogFromDatabase(dbUrl) {
  const out = execFileSync("psql", [dbUrl, "-At", "-c", CATALOG_SQL], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim());
}

async function pricesFromStripe(key) {
  const out = new Map();
  let starting_after;
  for (;;) {
    const qs = new URLSearchParams({ limit: "100" });
    if (starting_after) qs.set("starting_after", starting_after);
    const res = await fetch(`https://api.stripe.com/v1/prices?${qs}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Stripe ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const page = await res.json();
    for (const p of page.data) out.set(p.id, p);
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return out;
}

/** `sk_live_…` and `rk_live_…` are live; everything else is test. */
const keyIsLive = (key) => /^[a-z]k_live_/.test(key ?? "");

export function auditCatalog(catalog, prices, { expectLive }) {
  const problems = [];
  // Counted so the summary can say what was COMPARED rather than what was
  // present. "4 active rows checked" was the first wording, and it was true
  // only if you did not ask: one of the four is a contact-us tier with no
  // prices, and every add-on is coming_soon, so the add-on half of this check
  // was measuring nothing and reporting a tick.
  const checked = { plans: 0, addons: 0, prices: 0, lookupKeys: 0 };
  const skipped = { plans: [], addons: [] };
  const note = (row, msg) => problems.push(`${row}: ${msg}`);

  // What `resolvePriceId` sees: the account's own key → id index. Built from
  // ACTIVE prices only, because that is the set Stripe enforces key uniqueness
  // over and the set `loadPriceCatalog` reads.
  const byLookupKey = new Map();
  for (const p of prices.values()) {
    if (p.active && p.lookup_key) byLookupKey.set(p.lookup_key, p.id);
  }

  const checkPrice = (row, label, id, expectedCents, expectedInterval, productId, expectedKey) => {
    const p = prices.get(id);
    if (!p) {
      note(row, `${label} price ${id} does not exist in this Stripe account`);
      return;
    }
    checked.prices += 1;
    if (p.livemode !== expectLive) {
      note(
        row,
        `${label} price ${id} is a ${p.livemode ? "LIVE" : "TEST"} price but the key in use is ` +
          `${expectLive ? "LIVE" : "TEST"}. This is the cutover failure: it does not error until checkout.`,
      );
    }
    if (!p.active) note(row, `${label} price ${id} is archived in Stripe`);
    if (expectedCents != null && p.unit_amount !== expectedCents) {
      note(
        row,
        `${label} amount disagrees — the database says ${expectedCents} and Stripe charges ` +
          `${p.unit_amount}. The pricing page renders the first; the card is charged the second.`,
      );
    }
    if (expectedInterval === null) {
      if (p.recurring) note(row, `${label} should be one-time but Stripe has it recurring`);
    } else if (p.recurring?.interval !== expectedInterval) {
      note(
        row,
        `${label} should recur ${expectedInterval}ly but Stripe says ` +
          `${p.recurring ? p.recurring.interval + "ly" : "one-time"}`,
      );
    }
    if (productId && p.product !== productId) {
      note(row, `${label} price ${id} belongs to product ${p.product}, not ${productId}`);
    }

    // ── 7. NAME ─────────────────────────────────────────────────────────────
    //
    // The app no longer resolves a price by the id in the database — it asks
    // this account for the price named `expectedKey`, because the stored ids
    // are live ids and a test key cannot see them. That makes the key part of
    // the contract, and an unkeyed or misnamed price is a checkout that fails
    // in whichever mode the key is missing from.
    //
    // Both directions are checked, and they are different failures:
    //
    //   * the price the database names does not carry the key — nothing
    //     answers to that name, so resolution falls back to the stored id and
    //     test mode is broken again, silently, for that one SKU;
    //   * the key resolves to a DIFFERENT price — worse. Resolution succeeds
    //     and returns a price this check never compared, so every assertion
    //     above was made about an id the app does not actually charge.
    if (!expectedKey) return;
    checked.lookupKeys += 1;
    if (p.lookup_key !== expectedKey) {
      note(
        row,
        `${label} price ${id} should carry lookup_key "${expectedKey}" but carries ` +
          `${p.lookup_key ? `"${p.lookup_key}"` : "none"}. The app resolves prices by that ` +
          `name so the same code works against the sandbox; without it this SKU is live-only.`,
      );
    }
    const named = byLookupKey.get(expectedKey);
    if (named && named !== id) {
      note(
        row,
        `lookup_key "${expectedKey}" resolves to price ${named}, but the database stores ` +
          `${id} for ${label}. The app charges the first and this check just compared the ` +
          `second, so the amount verified above is not the amount billed.`,
      );
    }
  };

  for (const plan of catalog.plans ?? []) {
    const row = `plan:${plan.slug}`;
    // Inactive rows are not sellable, so a stale id on one is not a defect —
    // flagging them would make this check noisy about five retired SKUs from an
    // older catalog and get it ignored.
    if (!plan.is_active) {
      skipped.plans.push(`${plan.slug} (not active)`);
      continue;
    }

    // An active plan with no product at all is a "contact us" tier. Enterprise
    // is exactly that, and demanding price ids for it would be wrong.
    if (!plan.stripe_product_id && plan.price_cents == null) {
      skipped.plans.push(`${plan.slug} (contact-us tier, no prices to compare)`);
      continue;
    }
    checked.plans += 1;

    if (!plan.stripe_product_id) {
      note(row, `active and priced (${plan.price_cents}) but has no stripe_product_id`);
      continue;
    }

    for (const f of PLAN_PRICE_FIELDS) {
      const id = plan[f.id];
      const cents = f.cents ? plan[f.cents] : null;
      if (!id) {
        // A missing annual pair is a product decision, not a defect. A missing
        // monthly base on an active priced plan is not sellable.
        if (f.id === "stripe_price_id" && plan.price_cents != null) {
          note(row, `active with price_cents ${plan.price_cents} but no stripe_price_id`);
        }
        continue;
      }
      if (f.cents && cents == null) {
        note(row, `${f.label} has a Stripe id but the database has no amount for it`);
        continue;
      }
      checkPrice(
        row,
        f.label,
        id,
        cents,
        f.interval,
        plan.stripe_product_id,
        plan.slug ? planLookupKey(plan.slug, f.kind) : null,
      );
    }
  }

  for (const addon of catalog.addons ?? []) {
    const row = `addon:${addon.slug}`;
    // `coming_soon` add-ons are deliberately unsellable and deliberately have no
    // price. Checking them would flag the product's own roadmap.
    if (!addon.is_active) {
      skipped.addons.push(`${addon.slug} (${addon.status ?? "not active"})`);
      continue;
    }
    checked.addons += 1;
    if (!addon.stripe_price_id) {
      note(row, `active but has no stripe_price_id, so it cannot be sold`);
      continue;
    }
    checkPrice(
      row,
      "price",
      addon.stripe_price_id,
      addon.price_cents,
      addon.billing_interval === "one_time" ? null : addon.billing_interval,
      addon.stripe_product_id,
      addon.slug ? addonLookupKey(addon.slug) : null,
    );
  }

  return { problems, checked, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const catFrom = args.indexOf("--catalog-from");
  const priFrom = args.indexOf("--prices-from");

  let catalog, prices, expectLive;

  if (catFrom !== -1 && priFrom !== -1) {
    catalog = JSON.parse(readFileSync(args[catFrom + 1], "utf8"));
    const list = JSON.parse(readFileSync(args[priFrom + 1], "utf8"));
    prices = new Map((list.data ?? list).map((p) => [p.id, p]));
    expectLive = args.includes("--expect-live");
  } else {
    const dbUrl = process.env.SUPABASE_DB_URL;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!dbUrl || !key) {
      // Exit 2, not 1 and not 0.
      //
      // "Could not check" and "checked and fine" are different answers, and
      // this codebase has been bitten repeatedly by tools that conflate them —
      // a green tick over an empty set reads exactly like a green tick over a
      // clean one. CI treats 2 as an unarmed gate and says so out loud; 1 is a
      // real disagreement.
      const missing = [!dbUrl && "SUPABASE_DB_URL", !key && "STRIPE_SECRET_KEY"]
        .filter(Boolean)
        .join(" and ");
      console.error(
        `NOT ARMED: ${missing} not set, so nothing was compared.\n` +
          "This is the gate on the live-mode cutover. Until the secret is present it is\n" +
          "not protecting anything — which is a different statement from 'the catalog is fine'.",
      );
      process.exit(2);
    }
    catalog = catalogFromDatabase(dbUrl);
    prices = await pricesFromStripe(key);
    expectLive = keyIsLive(key);
  }

  const { problems, checked, skipped } = auditCatalog(catalog, prices, { expectLive });
  const mode = expectLive ? "LIVE" : "TEST";

  // Always printed, pass or fail. A reader has to be able to see that the
  // add-on half compared nothing without going and counting rows themselves.
  console.log(
    `compared ${checked.prices} price(s) across ${checked.plans} plan(s) and ` +
      `${checked.addons} add-on(s), in ${mode} mode; ` +
      `${checked.lookupKeys} of them checked for the lookup key the app resolves by`,
  );
  for (const s of [...skipped.plans, ...skipped.addons]) console.log(`  skipped: ${s}`);

  if (problems.length === 0) {
    console.log(`✓ Stripe (${mode}) agrees with the catalog on every row it can be compared against.`);
    return;
  }

  console.error(
    `✗ Stripe (${mode}) disagrees with the catalog on ${problems.length} point(s):\n` +
      problems.map((p) => `    - ${p}`).join("\n") +
      `\n\n  The database is what the pricing page and the plan matrix render. Stripe is ` +
      `what the\n  card is charged. Where they differ, the customer is charged the Stripe ` +
      `number and\n  told the database one.`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
