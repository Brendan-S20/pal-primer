// The catalog carries the Oct 9 prices (spec NP-1, NP-3, NP-4, NP-8, NP-10,
// A-P0-2, A-P1-7).
//
// The migration was checked inside BEGIN … ROLLBACK against a local database,
// with the rows present and with every row renamed away (the fresh-build case).
// What a static test can hold it to is the part that must never drift:
//
//   * the numbers, exactly as the owner decided them;
//   * the two descriptions, word for word — A-P0-2 was approved by the Twilio
//     Specialist as an exact string, so "close" is wrong;
//   * that it writes catalog rows and NOTHING a customer owns: no
//     org_platform_addons, no organizations, no subscriptions (grandfathering);
//   * that the tier function sizes a plan by its team-size range, because with
//     1/5/20 included, "included_seats covers the org" puts a two-person trial
//     on Growth;
//   * that it never pins a row count, which a fresh build cannot satisfy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FILE = "supabase/migrations/20261009150000_the-catalog-carries-the-oct-9-prices.sql";
const RAW = readFileSync(join(import.meta.dirname, "..", FILE), "utf8");
/** Comments out, so prose about the old behaviour cannot satisfy a check. */
const SQL = RAW.replace(/--[^\n]*/g, "");

/** Adjacent SQL string literals joined, '' unescaped — what Postgres stores. */
function literalOf(statement: string): string {
  return [...statement.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'")).join("");
}

function updateFor(slug: string): string {
  // Bounded so a match cannot start at one UPDATE and end at another's WHERE.
  const re = new RegExp(String.raw`UPDATE public\.platform_addons(?:(?!UPDATE)[\s\S])*?WHERE slug = '${slug}';`, "g");
  const hits = [...SQL.matchAll(re)].map((m) => m[0]);
  expect(hits, `one UPDATE for ${slug}`).toHaveLength(1);
  return hits[0];
}

describe("plans", () => {
  it("includes 1 / 5 / 20, caps at 3 / 15 / none, and charges $15 a person", () => {
    expect(SQL).toMatch(/\('launch', 1, 3\)/);
    expect(SQL).toMatch(/\('growth', 5, 15\)/);
    expect(SQL).toMatch(/\('scale', 20, NULL::integer\)/);
    expect(SQL).toMatch(/price_per_seat_cents = 1500/);
  });

  it("does not move the base or yearly prices", () => {
    const plans = SQL.match(/UPDATE public\.platform_plans(?:(?!UPDATE)[\s\S])*?;/g) ?? [];
    expect(plans).toHaveLength(1);
    expect(plans[0]).not.toMatch(/\bprice_cents\s*=/);
    expect(plans[0]).not.toMatch(/annual_price_cents/);
  });

  it("adds max_team_size with NULL as no cap, and keeps included inside it", () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS max_team_size integer;/);
    expect(SQL).toMatch(/CHECK \(max_team_size IS NULL OR max_team_size >= 1\)/);
    expect(SQL).toMatch(/included_seats <= max_team_size/);
  });

  it("sizes an unpaid org by team-size range, not by what is included", () => {
    const fn = SQL.slice(SQL.indexOf("CREATE OR REPLACE FUNCTION public.assign_billing_tier_for_org"));
    expect(fn).toMatch(/max_team_size IS NULL OR max_team_size >= GREATEST\(_seats, 1\)/);
    expect(fn).not.toMatch(/AND included_seats >= GREATEST/);
    expect(SQL).toMatch(/REVOKE ALL ON FUNCTION public\.assign_billing_tier_for_org\(uuid\) FROM PUBLIC, anon, authenticated/);
  });
});

describe("add-ons", () => {
  it("Priority support is $99 a month and says A-P1-7 exactly", () => {
    const st = updateFor("priority-support");
    expect(st).toMatch(/price_cents = 9900/);
    expect(literalOf(st.slice(st.indexOf("description"), st.indexOf("updated_at")))).toBe(
      "Faster email support, with a reply the same business day.",
    );
  });

  it("done-for-you setup is $199", () => {
    expect(updateFor("developer-setup")).toMatch(/price_cents = 19900/);
  });

  it("the AI Receptionist is $99 and its status is not touched", () => {
    const st = updateFor("ai-receptionist");
    expect(st).toMatch(/price_cents = 9900/);
    expect(st).not.toMatch(/status/);
  });

  it("Managed texting says A-P0-2 exactly, and its status is not touched", () => {
    const st = updateFor("managed-sms");
    expect(st).not.toMatch(/status\s*=/);
    expect(literalOf(st.slice(st.indexOf("description"), st.indexOf("updated_at")))).toBe(
      "Coming soon. Two-way texting with your clients from your own local number, registered with carriers under your business name. HoundStack handles the setup and carrier filing for you, with consent and STOP handling built in. We'll need your business details and approval before registering. No Twilio account of your own required.",
    );
  });
});

describe("what it leaves alone", () => {
  it("writes nothing a customer owns", () => {
    for (const table of ["org_platform_addons", "organizations", "subscriptions", "staff"]) {
      const write = new RegExp(String.raw`(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?${table}\b`, "i");
      // The tier function updates organizations when it RUNS, which is not
      // when this file runs; only statements outside the function body count.
      const outsideFn = SQL.replace(/\$function\$[\s\S]*?\$function\$/g, "");
      expect(outsideFn, table).not.toMatch(write);
    }
  });

  it("never asserts a row count", () => {
    expect(SQL).not.toMatch(/count\(\*\)/i);
    // A missing row is a warning, never an exception.
    expect(SQL).toMatch(/RAISE WARNING 'no % plan on this database/);
    expect(SQL).toMatch(/RAISE WARNING 'no % add-on on this database/);
  });
});
