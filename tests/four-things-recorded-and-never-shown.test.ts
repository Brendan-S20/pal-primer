// Four leftovers from the docs audit. Three of them are the same fault: the
// product already had the answer and never put it on the screen.
//
// ── 1. THE TIMELINE KNEW WHAT CHANGED AND SAID ONLY THAT SOMETHING HAD ────
//
// `logActivity` takes a free-form `meta`, and the callers describing an edit
// fill it with a field-level diff — `clients.functions.ts` writes
// `{ fields, before, after }`, `properties.functions.ts` writes before/after
// objects for an address change and for a price change driven by a unit-count
// change. `ActivityTab` rendered `e.summary`. "Updated client name, email,
// phone" was the whole story, on the screen whose job is answering what
// happened to this client.
//
// The uuid rule is the interesting part of the fix rather than an edge case.
// `zone.detected` writes `{ before: <zone id>, after: <zone id> }`, and "Zone
// changed from 7f3a1c94-… to 91b2e0af-…" is worse than the summary alone: it
// is longer, it looks like detail, and nobody can act on it.
//
// ── 2. THE SERVICE DRAWER SHOWED A PRICE WITH NO HISTORY ──────────────────
//
// Same shape. `service.price_changed` entries carry a before/after and nothing
// read them, on the drawer an owner opens when a customer asks why their bill
// went up. Add-on charges were also absent, and `addon_charges` has no
// subscription column — it carries `visit_id`, and a visit carries the
// subscription. That hop is the ONLY exact link; matching on `property_id`
// would sweep in a second service at the same address, which is a real
// configuration.
//
// ── 3. THREE 32px BUTTONS THAT OPEN, EDIT AND DELETE A ROW ────────────────
//
// `RowActions` is the compact desktop trio from the owner's spec, at `h-8 w-8`
// everywhere. 32px is well under the touch floor and these are not cosmetic
// controls. Scoped with `max-md:` rather than by changing `ui/button.tsx`'s
// `size="icon"`, which is 20 other call sites and a density decision that is
// not this component's to make.
//
// ── 4. A PLACEHOLDER IS NOT A LABEL ───────────────────────────────────────
//
// The referral field sits under a heading about the client's OWN code, and
// takes somebody else's. The only thing that said so was placeholder text,
// which disappears the moment anyone types.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { activityChanges, fieldLabel, formatActivityValue } from "../src/lib/activity-diff";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(ROOT + p, "utf8");
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

describe("the diff behind a timeline entry", () => {
  it("reads the field-level shape clients.functions.ts actually writes", () => {
    const changes = activityChanges(
      {
        fields: ["primary_email", "primary_phone"],
        before: { primary_email: "a@x.com", primary_phone: null },
        after: { primary_email: "b@x.com", primary_phone: "555-0100" },
      },
      "client.updated",
    );
    expect(changes.map((c) => c.field)).toEqual(["primary_email", "primary_phone"]);
    expect(changes[0]).toMatchObject({ before: "a@x.com", after: "b@x.com" });
    // A null before is "not set", not a blank that reads as an empty diff.
    expect(changes[1]).toMatchObject({ before: "not set", after: "555-0100" });
  });

  it("drops a field the form resubmitted without changing", () => {
    // clients.functions.ts builds its diff from the whole patch, and a form
    // that posts every field posts the unchanged ones too.
    const changes = activityChanges(
      { before: { city: "Austin", street: "1 Main" }, after: { city: "Austin", street: "2 Main" } },
      "property.updated",
    );
    expect(changes.map((c) => c.field)).toEqual(["street"]);
  });

  it("drops a line whose value is a uuid rather than printing it", () => {
    const changes = activityChanges(
      {
        before: "7f3a1c94-1111-4222-8333-444455556666",
        after: "91b2e0af-1111-4222-8333-444455556666",
      },
      "zone.detected",
    );
    expect(changes).toEqual([]);
  });

  it("renders cents as money, because a raw 4500 is not a price", () => {
    const changes = activityChanges(
      { before: { price_cents: 4500 }, after: { price_cents: 5000 } },
      "service.price_changed",
    );
    expect(changes[0]).toMatchObject({ label: "Price", before: "$45.00", after: "$50.00" });
  });

  it("reads the from/to spelling as well as before/after", () => {
    // visits.functions.ts and the zone re-detect job use from/to for the same
    // idea. One of the two spellings being understood is worse than neither,
    // because it looks like the feature works.
    const changes = activityChanges({ from: "2026-08-01", to: "2026-08-04" }, "visit.rescheduled");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ before: "2026-08-01", after: "2026-08-04" });
  });

  it("returns nothing for the bookkeeping most writers put in meta", () => {
    // request_id, visit_id, review_kind, amount_cents — none of these is a
    // diff, and rendering them as one would put "changed" beside a value that
    // never changed.
    for (const meta of [
      { request_id: "r1", kind: "extra" },
      { visit_id: "v1", completed_at: null },
      { amount_cents: 500, reason: "goodwill" },
      { impersonation: { grant_id: "g", admin_user_id: "a" } },
      null,
      "not an object",
      [],
    ]) {
      expect(activityChanges(meta, "anything"), JSON.stringify(meta)).toEqual([]);
    }
  });

  it("skips the columns nobody edited", () => {
    const changes = activityChanges(
      {
        before: { updated_at: "2026-01-01", notes: "old" },
        after: { updated_at: "2026-02-01", notes: "new" },
      },
      "client.updated",
    );
    expect(changes.map((c) => c.field)).toEqual(["notes"]);
  });

  it("has no honest one-line form for a nested value, so gives none", () => {
    expect(formatActivityValue("tags", ["a", "b"])).toBeNull();
    expect(formatActivityValue("config", { a: 1 })).toBeNull();
  });

  it("labels a field the way the form does", () => {
    expect(fieldLabel("postal_code")).toBe("ZIP");
    expect(fieldLabel("price_cents")).toBe("Price");
    expect(fieldLabel("end_reason")).toBe("End reason");
  });
});

describe("the timeline shows it", () => {
  const src = codeOnly(read("src/components/client-detail/ActivityTab.tsx"));

  it("computes the changes and renders them", () => {
    expect(src).toMatch(/activityChanges\(e\.meta, e\.kind\)/);
    expect(src).toMatch(/changes\.map\(\(c\) =>/);
  });

  it("uses a disclosure that opens on touch and from the keyboard", () => {
    // Fifty entries expanded at once buries the timeline; a hover reveal is
    // unreachable on a phone. <details> is neither.
    expect(src).toMatch(/<details/);
    expect(src).toMatch(/<summary/);
    expect(src).not.toMatch(/group-hover:/);
  });

  it("gives the disclosure a touch target", () => {
    expect(src).toMatch(/touch:min-h-11/);
  });
});

describe("the service drawer says how the price got there", () => {
  const src = codeOnly(read("src/components/client-detail/ServicesTab.tsx"));

  it("asks the server for this one service's history rather than filtering fifty rows", () => {
    // A price change from two years ago is otherwise lost behind newer,
    // unrelated client edits — the limit cuts it off before the filter runs.
    expect(src).toMatch(/listFn\(\{ data: \{ clientId, subscriptionId, limit: 50 \} \}\)/);
    expect(codeOnly(read("src/lib/activity.functions.ts"))).toMatch(
      /if \(data\.subscriptionId\) q = q\.eq\("subscription_id", data\.subscriptionId\)/,
    );
  });

  it("keeps the activity query scoped by client, so RLS is unchanged", () => {
    const fn = codeOnly(read("src/lib/activity.functions.ts"));
    expect(fn).toMatch(/\.eq\("client_id", data\.clientId\)/);
  });

  it("links add-on charges through the visit, the only exact link there is", () => {
    // addon_charges has no subscription column. property_id would sweep in a
    // second service at the same address.
    expect(src).toMatch(/c\.visit_id && ids\.has\(c\.visit_id\)/);
    expect(src).not.toMatch(/c\.property_id === s\.property_id/);
  });

  it("does not count a voided charge toward what the customer was billed", () => {
    expect(src).toMatch(/c\.status !== "void"/);
  });

  it("keeps add-on money behind the billing permission", () => {
    expect(src).toMatch(/if \(!canSeeBilling\) return null;/);
    expect(src).toMatch(/canSeeBilling={canManagePricing}/);
  });

  it("tells invoiced from paid, which are different answers", () => {
    expect(src).toMatch(/billed_invoice_status === "paid"/);
    expect(src).toMatch(/Not yet invoiced/);
  });
});

describe("the row actions are hittable on a phone", () => {
  const src = read("src/components/RowActions.tsx");

  it("gives all three buttons a 44px touch box", () => {
    const sized = src.match(/touch:h-11 touch:w-11/g) ?? [];
    expect(sized).toHaveLength(3);
    // Every h-8 w-8 on this component must carry the escape — a fourth button
    // added later without one is the regression.
    const compact = src.match(/className="h-8 w-8[^"]*"/g) ?? [];
    for (const c of compact) {
      expect(c, `a 32px row action with no touch size: ${c}`).toMatch(/touch:h-11 touch:w-11/);
    }
  });

  it("keeps the desktop trio compact, which was the point of the spec", () => {
    expect(src).toMatch(/h-8 w-8/);
  });
});

describe("the referral field says what it is when someone types in it", () => {
  const src = read("src/components/client-detail/comms-panels.tsx");

  it("has a visible label bound to the input", () => {
    expect(src).toMatch(/htmlFor="redeem-referral-code"/);
    expect(src).toMatch(/id="redeem-referral-code"/);
    // The label has to say whose code it is. The heading above is the client's
    // own, and these are opposite directions.
    expect(src).toMatch(/Referred by another client\? Enter their code/);
  });

  it("no longer leans on a placeholder to carry the meaning", () => {
    expect(src).not.toMatch(/placeholder="Redeem referral code"/);
  });

  it("gives the field and its button a touch height", () => {
    const form = src.slice(src.indexOf("redeem-referral-code") - 600);
    expect((form.match(/touch:min-h-11/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
