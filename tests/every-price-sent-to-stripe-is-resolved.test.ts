// The fifth send-site, found the day after the other four were converted.
//
// ── WHAT HAPPENED ─────────────────────────────────────────────────────────
//
// Every price id in `platform_plans` and `platform_addons` is a LIVE id, so
// nothing on the money path may send one to Stripe directly — it has to go
// through `resolvePriceId`, which asks the account in hand for the price by
// name and only falls back to the stored id when that account actually has it.
//
// Four paths were converted: the plan price, the seat price, the seat item in
// `seat-sync.server.ts`, and the add-on purchase in
// `platform-addons.functions.ts`. A fifth was missed:
//
//     const { data: addonRows } = await supabaseAdmin
//       .from("platform_addons")
//       .select("stripe_product_id, stripe_price_id, billing_interval");
//     ...
//       monthlyAddonPriceByProduct.set(a.stripe_product_id, a.stripe_price_id);
//     ...
//       itemUpdates.push({ price: storedMonthly, quantity: it.quantity ?? 1 });
//
// It survived because of how narrow its trigger is: it only fires when a
// subscription carries a bolt-on add-on AND the plan changes interval from
// year to month. Neither the type checker nor any test could see it, because a
// live price id and a test price id are both strings.
//
// ── WHY THIS TEST IS AN ALLOWLIST ─────────────────────────────────────────
//
// The bug is not "this one line is wrong", it is "a new line can be added that
// is wrong, and nothing notices". Pinning the four correct call sites would
// not have caught the fifth, because the fifth was NEW. So the test enumerates
// every identifier the money modules send to Stripe as a price, and requires
// each one to be listed here with a reason. Adding a send-site fails until
// somebody writes down where its value came from — which is exactly the moment
// to notice it came from a database column.
//
// Same shape as ALLOWED_FOR_ANON in the lockdown test, and for the same
// reason: the list is the point, not the assertions around it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Strip comments — the prose above and in the modules quotes the very
 *  pattern being banned, so a raw scan would match its own explanation. */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

/** Files that may send a `price:` to Stripe at all. */
const MONEY_MODULES = [
  "src/lib/billing.functions.ts",
  "src/lib/seat-sync.server.ts",
  "src/lib/platform-addons.functions.ts",
];

/**
 * Every expression this codebase is allowed to hand Stripe as a price id, and
 * where its value comes from. A new one fails until it is written down.
 */
const ALLOWED_PRICE_SENDS: Record<string, string> = {
  targetPlanPriceId:
    "resolvePriceId(catalog, planLookupKey(slug, base_monthly|base_annual), stored) — throws when null rather than sending undefined",
  targetSeatPriceId:
    "resolvePriceId(catalog, planLookupKey(slug, seat_monthly|seat_annual), stored) — only used when overage > 0",
  storedMonthly:
    "monthlyAddonPriceByProduct, whose values are resolvePriceId(catalog, addonLookupKey(slug), stored). THIS IS THE ONE THAT WAS WRONG: it used to be the raw platform_addons.stripe_price_id column",
  seatPriceToCreate:
    "resolvePriceId in seat-sync.server.ts — null means skipped('seat_price_not_in_account') rather than sending a foreign id",
  "await ensureStoredPrice()":
    "platform-addons.functions.ts — resolves by addonLookupKey first, mints only when the account has neither the key nor the stored id",
};

/** `price: <expr>,` and `pricing: { price: <expr> }` — what actually reaches Stripe. */
function priceSends(src: string): string[] {
  const out: string[] = [];
  for (const m of codeOnly(src).matchAll(/(?:pricing:\s*\{\s*)?\bprice:\s*([^,\n}]+)/g)) {
    const expr = m[1].trim();
    // `price:` inside a price_data literal is a currency/product spec, not an
    // id being sent, and a TS type annotation is not a send either.
    if (/^["'`]/.test(expr) || expr.startsWith("string")) continue;
    out.push(expr);
  }
  return out;
}

describe("no live price id reaches Stripe unresolved", () => {
  it("sends only prices that are written down as resolved", () => {
    const offenders: string[] = [];
    for (const f of MONEY_MODULES) {
      for (const expr of priceSends(read(f))) {
        if (!(expr in ALLOWED_PRICE_SENDS)) {
          offenders.push(
            `${f}: sends \`price: ${expr}\` — add it to ALLOWED_PRICE_SENDS with where its ` +
              `value comes from, and make sure that is resolvePriceId and not a database column`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every allowlist entry states a provenance, not just a name", () => {
    for (const [expr, why] of Object.entries(ALLOWED_PRICE_SENDS)) {
      expect(why.length, `${expr} has no stated provenance`).toBeGreaterThan(30);
    }
  });

  it("the add-on map is populated by the resolver, not by the column", () => {
    // The specific regression. `monthlyAddonPriceByProduct` is one hop away
    // from the send, so the allowlist above can only say the map is correct —
    // this asserts it actually is.
    const src = codeOnly(read("src/lib/billing.functions.ts"));
    const block = src.slice(
      src.indexOf("monthlyAddonPriceByProduct = new Map"),
      src.indexOf("const existingItems"),
    );
    expect(block).toMatch(/resolvePriceId\(/);
    expect(block).toMatch(/addonLookupKey\(/);
    // The shape of the original bug, verbatim: the raw column going into the map.
    expect(block).not.toMatch(/\.set\([^)]*\.stripe_price_id\s*\)/);
  });

  it("selects the slug it needs to derive the key", () => {
    // Resolving by name needs the slug, and the original select did not ask
    // for it — so a fix that forgot the column would silently resolve nothing
    // and fall back to the stored id every time, looking like it worked.
    const src = codeOnly(read("src/lib/billing.functions.ts"));
    const sel = src.slice(src.indexOf('.from("platform_addons")'));
    expect(sel.slice(0, 200)).toMatch(/\.select\("slug,/);
  });
});
