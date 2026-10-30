// #429: Camille Ueda read "0 dogs" on the Clients list and her record, "2
// dogs" on the quote and My Day; her plan was $34.00 and a new quote priced
// $51.00 with nothing saying why; every past visit from the day her plan
// started read Missed; and the quote's client picker showed five names twice.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientDogTally, propertyDogTally } from "@/lib/pets";
import { dogsLine } from "@/lib/stop-facts";
import { clientPickerLabels } from "@/lib/client-picker-labels";
import { currentPlanNote } from "@/lib/quote-pricing";
import { wasNeverOnARoute } from "@/lib/visit-lifecycle";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("dogs: one count", () => {
  it("uses the records when there are any", () => {
    expect(propertyDogTally(3, [2])).toEqual({ count: 3, source: "records" });
  });

  it("uses what the plan bills for when there are none, as My Day does", () => {
    expect(propertyDogTally(0, [2])).toEqual({ count: 2, source: "plan" });
    expect(dogsLine([], 2)).toEqual({ kind: "count", count: 2 });
  });

  it("says none when there is neither", () => {
    expect(propertyDogTally(0, [null, 0])).toEqual({ count: 0, source: "none" });
    expect(propertyDogTally(0, [])).toEqual({ count: 0, source: "none" });
  });

  it("adds properties up and marks a client whose names are not all on file", () => {
    expect(clientDogTally([propertyDogTally(1, []), propertyDogTally(0, [2])])).toEqual({
      count: 3,
      source: "plan",
    });
    expect(clientDogTally([propertyDogTally(2, [2])])).toEqual({ count: 2, source: "records" });
    expect(clientDogTally([])).toEqual({ count: 0, source: "none" });
  });

  it("is the rule the Clients list and the quote both count with", () => {
    expect(src("src/lib/clients.functions.ts")).toMatch(/propertyDogTally\(/);
    expect(src("src/lib/quote-pricing.functions.ts")).toMatch(/propertyDogTally\(/);
  });
});

describe("quote: a price that is not the plan's says so", () => {
  const plan = { priceCents: 3400, frequency: "weekly", dogCount: 2 };

  it("explains $51.00 against a $34.00 plan", () => {
    const note = currentPlanNote(plan, 5100);
    expect(note).toContain("$34.00 per visit (weekly visit, 2 dogs)");
    expect(note).toContain("Your pricing rules give $51.00");
    expect(note).toContain("higher");
  });

  it("says nothing when they agree or there is no plan", () => {
    expect(currentPlanNote(plan, 3400)).toBeNull();
    expect(currentPlanNote(null, 5100)).toBeNull();
    expect(currentPlanNote(plan, null)).toBeNull();
  });

  it("does not name a frequency a quote cannot price", () => {
    const note = currentPlanNote(
      { priceCents: 3400, frequency: "every_n_days", dogCount: null },
      5100,
    );
    expect(note).toContain("$34.00 per visit.");
  });
});

describe("quote client picker: one row per client, no two the same", () => {
  it("tells two clients with one name apart by street", () => {
    const rows = clientPickerLabels([
      { id: "a1111111-0000", display_name: "Vasquez Landing", street: "12 Elm St" },
      { id: "b2222222-0000", display_name: "Vasquez Landing", street: "40 Oak Ave" },
      { id: "c3333333-0000", display_name: "Camille Ueda", street: "9 Pine Rd" },
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      "Camille Ueda",
      "Vasquez Landing · 12 Elm St",
      "Vasquez Landing · 40 Oak Ave",
    ]);
  });

  it("falls back to the id when the street does not settle it", () => {
    const rows = clientPickerLabels([
      { id: "a1111111-0000", display_name: "Petrov Mews", street: "1 Main St" },
      { id: "b2222222-0000", display_name: "petrov mews ", street: "1 Main St" },
      { id: "c3333333-0000", display_name: "Petrov Mews", street: null },
    ]);
    const labels = rows.map((r) => r.label);
    expect(new Set(labels.map((l) => l.toLowerCase())).size).toBe(3);
    expect(labels).toContain("Petrov Mews · 1 Main St · #a1111111");
    expect(labels).toContain("Petrov Mews");
  });

  it("lists a client id once", () => {
    const c = { id: "a1111111-0000", display_name: "Jansen Court", street: null };
    expect(clientPickerLabels([c, c])).toHaveLength(1);
  });
});

describe("visits: a date added after it passed was never on a route", () => {
  const tz = "America/Detroit";

  it("is a missed visit written after its own day", () => {
    expect(
      wasNeverOnARoute(
        { status: "missed", scheduled_on: "2026-07-31", created_at: "2026-10-10T14:00:00Z" },
        tz,
      ),
    ).toBe(true);
  });

  it("is not a visit that was on the schedule before its day", () => {
    expect(
      wasNeverOnARoute(
        { status: "missed", scheduled_on: "2026-10-09", created_at: "2026-09-20T14:00:00Z" },
        tz,
      ),
    ).toBe(false);
  });

  it("reads the day on the org's clock, not UTC's", () => {
    // 01:30 UTC on Oct 10 is still Oct 9 in Detroit: written on its own day.
    expect(
      wasNeverOnARoute(
        { status: "missed", scheduled_on: "2026-10-09", created_at: "2026-10-10T01:30:00Z" },
        tz,
      ),
    ).toBe(false);
  });

  it("never relabels a visit that is not missed", () => {
    expect(
      wasNeverOnARoute(
        { status: "completed", scheduled_on: "2026-07-31", created_at: "2026-10-10T14:00:00Z" },
        tz,
      ),
    ).toBe(false);
    expect(wasNeverOnARoute({ status: "missed", scheduled_on: "2026-07-31" }, tz)).toBe(false);
  });

  it("is read from created_at, which the client's visit history selects", () => {
    const fn = src("src/lib/clients.functions.ts");
    const at = fn.indexOf("export const listClientVisitHistory");
    expect(fn.slice(at, at + 1200)).toMatch(/scheduled_on, status, created_at/);
  });
});
