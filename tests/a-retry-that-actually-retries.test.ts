// The nightly autopay key was `autopay-<invoice>-<amount>`, the same every
// night. Stripe keeps an idempotency key for 24 hours and replays the original
// response, so a retry the next night could get last night's decline back
// without the card being tried. The key now carries the UTC day, so a retry on
// a later day is a new attempt and a second run on the same day still shares
// the key (the double-charge protection the key exists for).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/routes/api/public/hooks/nightly.ts", "utf8");
const keys = [...src.matchAll(/idempotencyKey: `(autopay-[^`]+)`/g)].map((m) => m[1]);

/** The key the nightly run would build, evaluated the way the template does. */
function keyAt(template: string, inv: string, cents: number, at: Date): string {
  return template
    .replace("${inv.id}", inv)
    .replace("${quote.totalCents}", String(cents))
    .replace("${new Date().toISOString().slice(0, 10)}", at.toISOString().slice(0, 10));
}

describe("the nightly autopay idempotency key", () => {
  it("is one template, carrying invoice, charged amount and the UTC day", () => {
    expect(keys).toEqual(["autopay-${inv.id}-${quote.totalCents}-${new Date().toISOString().slice(0, 10)}"]);
  });

  it("is the same for two runs on one day, so a rerun never charges twice", () => {
    const [t] = keys;
    expect(keyAt(t, "inv-1", 3300, new Date("2026-10-07T03:05:00Z"))).toBe(
      keyAt(t, "inv-1", 3300, new Date("2026-10-07T21:40:00Z")),
    );
  });

  it("differs the next night, even inside Stripe's 24-hour window", () => {
    const [t] = keys;
    expect(keyAt(t, "inv-1", 3300, new Date("2026-10-08T03:01:00Z"))).not.toBe(
      keyAt(t, "inv-1", 3300, new Date("2026-10-07T03:05:00Z")),
    );
  });
});
