// One rule for what a price is called, implemented twice.
//
// ── WHY TWICE ─────────────────────────────────────────────────────────────
//
// The app resolves a Stripe price by `lookup_key` rather than by the id in
// `platform_plans`, because every stored id is a LIVE id and a test key cannot
// see one. `scripts/check-stripe-catalog.mjs` is the gate that keeps those keys
// correct — and it runs under plain node, with no bundler and `allowJs: false`,
// so it cannot import the TypeScript module the app uses.
//
// That leaves two implementations of one naming rule. This repo has been bitten
// by exactly that shape before (the TS↔SQL permission list), and the fix is the
// same: a test that imports BOTH and fails the moment they disagree. Without it
// the failure is silent in the worst possible direction — the checker says the
// catalog is fine, using its own idea of the name, while the app asks Stripe for
// a different one and gets nothing.
//
// The slugs below are the real ones, taken from the migrations rather than
// invented, so the parity is asserted over the keys that actually exist in both
// Stripe accounts.

import { describe, expect, it } from "vitest";
import {
  PLAN_PRICE_ID_COLUMN,
  PLAN_PRICE_KINDS,
  addonLookupKey,
  planLookupKey,
} from "../src/lib/stripe-lookup-keys";
import {
  PLAN_PRICE_ID_COLUMN as MJS_COLUMN,
  PLAN_PRICE_KINDS as MJS_KINDS,
  // @ts-expect-error - plain ESM twin, no types
  addonLookupKey as mjsAddonLookupKey,
  // @ts-expect-error - plain ESM twin, no types
  planLookupKey as mjsPlanLookupKey,
} from "../scripts/stripe-lookup-keys.mjs";
import {
  loadPriceCatalog,
  resolvePriceId,
  resolvePriceIdSet,
} from "../src/lib/stripe-price-catalog.server";

const PLAN_SLUGS = ["launch", "growth", "scale", "enterprise"];
const ADDON_SLUGS = [
  "ai-receptionist",
  "managed-sms",
  "white-label-portal",
  "white-label-emails",
  "priority-support",
  "developer-setup",
];

describe("the app and the checker agree on every name", () => {
  it("produces the same key for every real plan slug and kind", () => {
    for (const slug of PLAN_SLUGS) {
      for (const kind of PLAN_PRICE_KINDS) {
        expect(mjsPlanLookupKey(slug, kind)).toBe(planLookupKey(slug, kind));
      }
    }
  });

  it("produces the same key for every real add-on slug", () => {
    for (const slug of ADDON_SLUGS) {
      expect(mjsAddonLookupKey(slug)).toBe(addonLookupKey(slug));
    }
  });

  it("agrees on the odd shapes too, not just the tidy ones", () => {
    // Normalisation is where two implementations of one rule drift first: a
    // regex that says `[-\s]+` in one file and `-` in the other agrees on
    // every slug in the catalog today and diverges on the first one with two
    // hyphens or a stray space.
    for (const s of ["  Launch  ", "White-Label-Portal", "a b", "a--b", "A_B", "x - y"]) {
      expect(mjsAddonLookupKey(s)).toBe(addonLookupKey(s));
      expect(mjsPlanLookupKey(s, "base_monthly")).toBe(planLookupKey(s, "base_monthly"));
    }
  });

  it("agrees on the list of kinds and on which column holds each one", () => {
    // A kind added to one file and not the other would make the checker
    // validate three prices while the app resolves four.
    expect([...MJS_KINDS]).toEqual([...PLAN_PRICE_KINDS]);
    expect(MJS_COLUMN).toEqual(PLAN_PRICE_ID_COLUMN);
  });
});

describe("the naming rule itself", () => {
  it("normalises hyphens to underscores so one add-on has one key", () => {
    // Stripe would accept `white-label-portal` and `white_label_portal` as two
    // distinct keys. Only one of them is in the account, and a checkout asking
    // for the other gets nothing.
    expect(addonLookupKey("white-label-portal")).toBe("addon_white_label_portal");
    expect(addonLookupKey("white_label_portal")).toBe("addon_white_label_portal");
  });

  it("keeps add-ons out of the plans' namespace", () => {
    // Nothing stops a future add-on being slugged `launch`. Without the prefix
    // it would silently take the plan's key, and the symptom would be a
    // subscription billed the wrong amount rather than an error.
    expect(addonLookupKey("launch")).not.toBe(planLookupKey("launch", "base_monthly"));
    expect(addonLookupKey("launch")).toBe("addon_launch");
  });

  it("gives the twelve plan prices twelve distinct names", () => {
    const keys = ["launch", "growth", "scale"].flatMap((s) =>
      PLAN_PRICE_KINDS.map((k) => planLookupKey(s, k)),
    );
    expect(new Set(keys).size).toBe(12);
    expect(keys).toContain("launch_base_monthly");
    expect(keys).toContain("scale_seat_annual");
  });
});

// ── The resolver ──────────────────────────────────────────────────────────

const catalogOf = (byLookupKey: Record<string, string>, extraIds: string[] = []) => ({
  byLookupKey: new Map(Object.entries(byLookupKey)),
  ids: new Set([...Object.values(byLookupKey), ...extraIds]),
  truncated: false,
});

describe("resolving a price in whichever account is in hand", () => {
  it("prefers the account's own price over the stored id", () => {
    // The whole point: the database holds a live id, the key in use is a test
    // key, and the sandbox has its own price under the same name.
    const c = catalogOf({ launch_base_monthly: "price_sandbox" });
    expect(resolvePriceId(c, "launch_base_monthly", "price_live")).toBe("price_sandbox");
  });

  it("prefers the key even when this account also holds the stored id", () => {
    // The case that actually decides the order, and the first draft of this
    // test did not cover it: with the stored id absent from the account, both
    // orderings return the keyed price and the assertion above passes either
    // way. Both present is a real state — a price replaced in Stripe with the
    // key transferred to its successor, `platform_plans` still naming the old
    // one. The key is the newer statement of intent; the stored id is a
    // fallback, and a fallback that wins is not a fallback.
    const c = catalogOf({ launch_base_monthly: "price_new" }, ["price_superseded"]);
    expect(resolvePriceId(c, "launch_base_monthly", "price_superseded")).toBe("price_new");
  });

  it("falls back to the stored id when this account has it", () => {
    // Keeps today's behaviour as the floor: a price created without a key —
    // a new SKU added by hand — must not become unsellable the moment this
    // code ships.
    const c = catalogOf({}, ["price_live"]);
    expect(resolvePriceId(c, "launch_base_monthly", "price_live")).toBe("price_live");
  });

  it("refuses a stored id that belongs to the other account", () => {
    // Returning it anyway would hand Stripe an id from another account. The
    // failure would surface at checkout, in front of the customer, instead of
    // here where the caller can say which price it wanted.
    const c = catalogOf({ growth_base_monthly: "price_other" });
    expect(resolvePriceId(c, "launch_base_monthly", "price_from_live")).toBeNull();
  });

  it("returns null rather than undefined for nothing at all", () => {
    // `undefined` sent to Stripe as `{ price: undefined }` creates a
    // subscription missing a line item — a customer subscribed and not billed.
    const c = catalogOf({});
    expect(resolvePriceId(c, "launch_base_monthly", null)).toBeNull();
    expect(resolvePriceId(c, "launch_base_monthly", undefined)).toBeNull();
  });
});

describe("classifying the items already on a subscription", () => {
  it("includes both the resolved and the stored ids", () => {
    // This is a membership test, not something sent to Stripe. A live id in
    // the set while running in test mode matches nothing and costs nothing.
    const c = catalogOf({ launch_base_monthly: "price_sandbox" });
    const s = resolvePriceIdSet(c, ["launch_base_monthly"], ["price_live"]);
    expect(s).toEqual(new Set(["price_sandbox", "price_live"]));
  });

  it("keeps a stored id this account does not have", () => {
    // Dropping it would misclassify a live subscription created before the
    // lookup keys existed: its plan item would fall through to the "bolt-on
    // add-on" branch, and a plan switch would delete the plan line.
    const c = catalogOf({});
    expect(resolvePriceIdSet(c, ["launch_base_monthly"], ["price_live"])).toEqual(
      new Set(["price_live"]),
    );
  });

  it("skips nulls instead of putting them in the set", () => {
    // `platform_plans` rows legitimately have null annual columns, and a null
    // in the set would match an item whose price failed to expand.
    const c = catalogOf({});
    expect(resolvePriceIdSet(c, ["nope"], [null, undefined, ""])).toEqual(new Set());
  });
});

describe("reading the catalog out of Stripe", () => {
  const pagedStripe = (pages: any[][]) => {
    const calls: any[] = [];
    return {
      calls,
      stripe: {
        prices: {
          list: async (params: any) => {
            calls.push(params);
            const page = pages[calls.length - 1] ?? [];
            return { data: page, has_more: calls.length < pages.length };
          },
        },
      } as any,
    };
  };

  it("indexes active prices by key and by id", async () => {
    const { stripe } = pagedStripe([
      [
        { id: "price_a", lookup_key: "launch_base_monthly" },
        { id: "price_b", lookup_key: null },
      ],
    ]);
    const c = await loadPriceCatalog(stripe);
    expect(c.byLookupKey.get("launch_base_monthly")).toBe("price_a");
    expect(c.ids).toEqual(new Set(["price_a", "price_b"]));
    expect(c.truncated).toBe(false);
  });

  it("asks Stripe only for active prices", async () => {
    // An archived price cannot be subscribed to. Resolving one would fail at
    // checkout with an error naming a price the operator archived on purpose.
    const { stripe, calls } = pagedStripe([[]]);
    await loadPriceCatalog(stripe);
    expect(calls[0].active).toBe(true);
  });

  it("follows every page rather than stopping at the first hundred", async () => {
    // A reader that silently stops at page one reports "all of them" for as
    // long as the catalog is small, then starts missing prices with no signal.
    const { stripe, calls } = pagedStripe([
      [{ id: "price_1", lookup_key: "a" }],
      [{ id: "price_2", lookup_key: "b" }],
    ]);
    const c = await loadPriceCatalog(stripe);
    expect(c.ids).toEqual(new Set(["price_1", "price_2"]));
    expect(calls[1].starting_after).toBe("price_1");
  });

  it("stops at the page cap and says so instead of spinning", async () => {
    // `has_more` that never goes false — a pagination bug on either side —
    // must not become an infinite loop inside a checkout request.
    const pages = Array.from({ length: 20 }, (_, i) => [{ id: `price_${i}`, lookup_key: `k${i}` }]);
    const { stripe, calls } = pagedStripe(pages);
    const c = await loadPriceCatalog(stripe);
    expect(calls).toHaveLength(10);
    expect(c.truncated).toBe(true);
  });
});
