// Managed texting goes on sale (2026-10-29): the catalog half of the launch.
// The code half is ADDON_LAUNCHED in src/lib/addon-launch.ts, pinned by
// a-held-add-on-never-reaches-stripe.test.ts. Neither alone sells it.
//
// The description is A-P0-2, which the Twilio Specialist approved as an exact
// string (see the-catalog-carries-the-oct-9-prices.test.ts), less its opening
// "Coming soon. " and nothing else.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADDON_LAUNCHED } from "@/lib/addon-launch";

const read = (file: string) => readFileSync(join(import.meta.dirname, "..", file), "utf8");
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const SQL = strip(read("supabase/migrations/20261029170000_managed-texting-goes-on-sale.sql"));
const OCT9 = strip(
  read("supabase/migrations/20261009150000_the-catalog-carries-the-oct-9-prices.sql"),
);

/** Adjacent SQL string literals joined, '' unescaped — what Postgres stores. */
function literalOf(statement: string): string {
  return [...statement.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'")).join("");
}

function descriptionIn(sql: string): string {
  const st = sql.match(
    /UPDATE public\.platform_addons(?:(?!UPDATE)[\s\S])*?WHERE slug = 'managed-sms';/g,
  );
  expect(st, "one UPDATE for managed-sms").toHaveLength(1);
  const s = st![0];
  return literalOf(s.slice(s.indexOf("description"), s.indexOf("updated_at")));
}

describe("managed texting goes on sale", () => {
  it("the code flag and the catalog row move together", () => {
    expect(ADDON_LAUNCHED["managed-sms"]).toBe(true);
    expect(SQL).toMatch(/SET status = 'active',[\s\S]*?WHERE slug = 'managed-sms';/);
  });

  it("keeps the approved description, less 'Coming soon. '", () => {
    const approved = descriptionIn(OCT9);
    expect(approved.startsWith("Coming soon. ")).toBe(true);
    expect(descriptionIn(SQL)).toBe(approved.slice("Coming soon. ".length));
  });

  it("writes nothing a customer owns and pins no row count", () => {
    for (const table of ["org_platform_addons", "organizations", "subscriptions", "staff"]) {
      expect(SQL, table).not.toMatch(
        new RegExp(String.raw`(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?${table}\b`, "i"),
      );
    }
    expect(SQL).not.toMatch(/count\(\*\)/i);
    expect(SQL).toMatch(/RAISE WARNING 'no managed-sms add-on/);
  });
});
