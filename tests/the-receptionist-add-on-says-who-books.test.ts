// The AI Receptionist add-on says who books the visit (#537).
//
// Plan & billing said it "books visits into your calendar"; the pricing page
// said it passes the lead to the office. The receptionist does both,
// depending on who texts and on one owner setting (receptionist-booking.ts).
// The add-on's description lives in platform_addons, so the last migration
// to write it is what an owner reads.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(process.cwd(), "supabase/migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** The text of the last UPDATE that sets the ai-receptionist description,
 *  with the SQL string pieces joined back into one sentence. */
function lastDescription(): { file: string; text: string } {
  let found: { file: string; text: string } | null = null;
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    const re =
      /UPDATE public\.platform_addons\s+SET[\s\S]*?description\s*=\s*((?:\s*'(?:[^']|'')*')+)[\s\S]*?WHERE slug = 'ai-receptionist'/g;
    for (const m of sql.matchAll(re)) {
      const text = [...m[1].matchAll(/'((?:[^']|'')*)'/g)]
        .map((p) => p[1].replace(/''/g, "'"))
        .join("");
      found = { file: f, text };
    }
  }
  if (!found) throw new Error("no migration sets the ai-receptionist description");
  return found;
}

describe("the receptionist add-on description", () => {
  const { file, text } = lastDescription();

  it("is the one #537 wrote", () => {
    expect(file).toBe("20261027220000_the-receptionist-add-on-says-who-books.sql");
  });

  it("no longer promises that every text ends in a booked visit", () => {
    expect(text).not.toMatch(/books visits into your calendar/i);
  });

  it("says when it books and when the office does, in the owner's one sentence", () => {
    expect(text).toContain(
      "It will book the visit if you turn on Book requests automatically and the service has a price; otherwise it sends the request to your office.",
    );
  });

  it("does not claim it offers times", () => {
    expect(text).not.toMatch(/open day|offers? (a )?(time|day)s?/i);
  });

  it("is in the future tense while it is coming soon, and keeps what 20261009210000 checks", () => {
    expect(text).toMatch(/^Coming soon\. Will answer/);
    expect(text).toMatch(/carrier registration/);
    expect(text).not.toMatch(/day and night|—/);
  });

  it("matches booksStraightIn: the auto-book switch and a price", () => {
    const rules = readFileSync(join(process.cwd(), "src/lib/receptionist-booking.ts"), "utf8");
    expect(rules).toMatch(/if \(!org\.portal_auto_accept_bookings\) return false;/);
    expect(rules).toMatch(/return service\.base_price_cents != null;/);
    expect(rules).toMatch(/return org\.one_off_price_cents != null;/);
  });
});
