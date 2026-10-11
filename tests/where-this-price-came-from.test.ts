// A subscription's price did not record where it came from.
//
// `price_cents` is captured once, when the service is created, and only
// changes when a human edits it or a frequency change reprices it by the
// multiplier ratio. Nothing beside it said which zone's rate produced the
// number, when, or whether somebody has since typed over it -- so "who is off
// the current rate card, and by how much", the first question any repricing
// screen has to answer, could not be answered from the table.
//
// Measured by hand on 2026-09-03: 18 of 21 active residential subscriptions
// differ from what their zone computes today, with no way to tell an old rate
// from a deliberate discount.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describePriceProvenance,
  formatProvenanceDate,
  type PriceProvenanceFields,
} from "../src/lib/price-provenance";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const mig = read(
  "supabase/migrations/20260904120000_a-price-that-did-not-say-where-it-came-from.sql",
);

const NOTHING: PriceProvenanceFields = {
  priced_at: null,
  priced_from_zone_id: null,
  price_overridden_at: null,
};
const zones = (id: string) => (id === "z-west" ? "Westside Suburb" : undefined);

/** Line and block comments only. Not a parser: it is used on slices of source
 *  where the question is what the CODE does, and this file has no string
 *  literals containing "//" in those slices. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("a price says where it came from, or says that it cannot", () => {
  it("never reads a NULL as a negative claim", () => {
    // The whole point of the columns. An unpriced row must not render as
    // "priced from its zone" or "never overridden" -- those are the two
    // assumptions that made a stale rate invisible for two years.
    const p = describePriceProvenance(NOTHING, zones);
    expect(p.tone).toBe("unknown");
    expect(p.text).toMatch(/before the app recorded/i);
    expect(p.text).not.toMatch(/zone|never|hand/i);
  });

  it("names the zone and the day when it has both", () => {
    const p = describePriceProvenance(
      { ...NOTHING, priced_at: "2026-03-12T09:30:00Z", priced_from_zone_id: "z-west" },
      zones,
    );
    expect(p.tone).toBe("zone");
    expect(p.text).toBe("From the Westside Suburb rate on 12 Mar 2026");
  });

  it("says the zone is gone rather than printing its id", () => {
    const p = describePriceProvenance(
      { ...NOTHING, priced_at: "2026-03-12T09:30:00Z", priced_from_zone_id: "z-deleted" },
      zones,
    );
    expect(p.text).toMatch(/since been deleted/);
    expect(p.text).not.toContain("z-deleted");
  });

  it("lets a hand-set price outrank the zone it started from", () => {
    // Once a person has typed a number, which rate it began as is history --
    // and reporting it as "from the Westside rate" would be actively wrong.
    const p = describePriceProvenance(
      {
        priced_at: "2026-03-12T09:30:00Z",
        priced_from_zone_id: "z-west",
        price_overridden_at: "2026-09-03T18:00:00Z",
      },
      zones,
    );
    expect(p.tone).toBe("manual");
    expect(p.text).toBe("Set by hand on 3 Sep 2026");
  });

  it("still dates a price set with no zone in force", () => {
    const p = describePriceProvenance({ ...NOTHING, priced_at: "2026-03-12T09:30:00Z" }, zones);
    expect(p.tone).toBe("dated");
    expect(p.text).toBe("Set on 12 Mar 2026");
  });

  it("does not transpose the day and the month, in any locale", () => {
    // Not toLocaleDateString on purpose: the office and the field read the
    // same record, and 3/9 means two different days depending on where you
    // are standing.
    expect(formatProvenanceDate("2026-09-03T00:00:00Z")).toBe("3 Sep 2026");
    expect(formatProvenanceDate("not a date")).toBe("an unreadable date");
  });
});

describe("the columns are written where a price is set", () => {
  const fns = read("src/lib/subscriptions.functions.ts");

  it("records the rate card at creation", () => {
    const create = fns.slice(fns.indexOf("export const createSubscription"));
    // ...for a zone-priced plan (pet waste). A plan priced from its service
    // (phase 5: a walk, a sit, a groom) records no zone, because no zone
    // priced it; tests/a-walk-is-priced-as-a-walk.test.ts covers that half.
    expect(create).toMatch(/priced_from_zone_id: zonePriced \? \(data\.zoneId \?\? null\) : null/);
    expect(create).toMatch(/priced_at: new Date\(\)\.toISOString\(\)/);
  });

  it("does not guess an override at creation", () => {
    // The form prefills from the zone and a person may edit it there; the
    // server cannot tell the two apart, and flagging every new service as
    // hand-priced would make the flag meaningless.
    // Comments stripped first: the code carries a comment saying exactly why
    // the column is absent here, and matching prose would fail on the
    // explanation for the very behaviour being asserted.
    const create = stripComments(
      fns.slice(
        fns.indexOf("export const createSubscription"),
        fns.indexOf("export const updateSubscription"),
      ),
    );
    expect(create).not.toMatch(/price_overridden_at/);
  });

  it("stamps an override only when the number actually changed", () => {
    // Re-saving the drawer untouched must not manufacture one, and an earlier
    // override must survive an unrelated edit.
    const upd = fns.slice(fns.indexOf("export const updateSubscription"));
    expect(upd).toMatch(
      /const priceWasTypedOver = !!before && before\.price_cents !== data\.priceCents/,
    );
    expect(upd).toMatch(/\.\.\.\(priceWasTypedOver[\s\S]{0,200}price_overridden_at/);
  });

  it("computes that flag before the row stops being the before-image", () => {
    const upd = fns.slice(fns.indexOf("export const updateSubscription"));
    const flag = upd.indexOf("const priceWasTypedOver");
    const update = upd.indexOf('.from("subscriptions")\n      .update(');
    expect(flag).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(-1);
    expect(flag, "the flag is computed after the update that invalidates it").toBeLessThan(update);
  });

  it("carries the columns through the query that feeds the screen", () => {
    expect(fns).toMatch(/priced_at, priced_from_zone_id, price_overridden_at/);
  });
});

describe("the migration", () => {
  it("adds all three and backfills none of them", () => {
    for (const c of [
      "priced_from_zone_id uuid",
      "priced_at timestamptz",
      "price_overridden_at timestamptz",
    ]) {
      expect(mig).toContain(`ADD COLUMN IF NOT EXISTS ${c}`);
    }
    const updates = mig.split("\n").filter((l) => /^\s*UPDATE\s+public\.subscriptions/i.test(l));
    expect(updates, `this migration backfills: ${updates}`).toEqual([]);
  });

  it("will not let a deleted zone take services with it", () => {
    expect(mig).toMatch(/REFERENCES public\.zones\(id\) ON DELETE SET NULL/);
    expect(mig).toMatch(/confdeltype = 'n'/);
  });

  it("warns rather than asserts on rows it did not create", () => {
    const from = mig.indexOf("INTO _backfilled");
    expect(from).toBeGreaterThan(-1);
    expect(mig.slice(from)).toMatch(/RAISE WARNING/);
    expect(mig.slice(from)).not.toMatch(/RAISE EXCEPTION/);
  });
});
