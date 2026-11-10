// A deploy ahead of the country column still signs in (#496).
//
// loadMyOrg and getOrgBranding select `organizations.country`. If the app
// deploys before 20261018120000 is applied, that select fails and every
// signed-in page with it. The readers and updateOrgBranding retry once
// without `country`, but only for the error that names it: this pins which
// errors those are, with the real messages Postgres and PostgREST send. And
// both say when they did it, so the Country card never reports a save that
// stored nothing (the card's half is the-country-card-says-when-it-cannot-save).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isMissingCountryColumn,
  selectWithCountryFallback,
  updateWithCountryFallback,
  withoutCountry,
} from "@/lib/org-country-column";

describe("isMissingCountryColumn", () => {
  it("is the Postgres undefined column error on a select", () => {
    expect(
      isMissingCountryColumn({
        code: "42703",
        message: "column organizations.country does not exist",
      }),
    ).toBe(true);
  });

  it("is PostgREST's schema cache error on a write", () => {
    expect(
      isMissingCountryColumn({
        code: "PGRST204",
        message: "Could not find the 'country' column of 'organizations' in the schema cache",
      }),
    ).toBe(true);
  });

  it("is the same error rethrown as a plain Error by updateOwnOrg, with no code", () => {
    expect(isMissingCountryColumn(new Error("column organizations.country does not exist"))).toBe(
      true,
    );
    expect(
      isMissingCountryColumn(
        new Error("Could not find the 'country' column of 'organizations' in the schema cache"),
      ),
    ).toBe(true);
  });

  it("is not a missing column that is some other column", () => {
    expect(
      isMissingCountryColumn({
        code: "42703",
        message: "column organizations.currency does not exist",
      }),
    ).toBe(false);
    expect(
      isMissingCountryColumn(new Error("column organizations.country_code does not exist")),
    ).toBe(false);
  });

  it("is not a different error that happens to mention country", () => {
    expect(
      isMissingCountryColumn({
        code: "23514",
        message:
          'new row for relation "organizations" violates check constraint "organizations_country_check"',
      }),
    ).toBe(false);
    expect(isMissingCountryColumn(new Error("Choose a country"))).toBe(false);
  });

  it("is not nothing", () => {
    expect(isMissingCountryColumn(null)).toBe(false);
    expect(isMissingCountryColumn(undefined)).toBe(false);
    expect(isMissingCountryColumn({})).toBe(false);
  });
});

describe("withoutCountry", () => {
  it("takes country out and leaves every other column in order", () => {
    expect(withoutCountry("id, name, country, currency")).toBe("id, name, currency");
    expect(withoutCountry("country,id")).toBe("id");
  });
});

describe("selectWithCountryFallback", () => {
  const missing = { code: "42703", message: "column organizations.country does not exist" };

  it("asks once when the column is there", async () => {
    const asked: string[] = [];
    const out = await selectWithCountryFallback("id, country", async (c) => {
      asked.push(c);
      return { data: { id: "o1", country: "US" }, error: null };
    });
    expect(asked).toEqual(["id, country"]);
    expect(out.data).toEqual({ id: "o1", country: "US" });
  });

  it("asks again without country and answers null when the column is not there yet", async () => {
    const asked: string[] = [];
    const out = await selectWithCountryFallback("id, country, currency", async (c) => {
      asked.push(c);
      return c.includes("country")
        ? { data: null, error: missing }
        : { data: { id: "o1", currency: "usd" }, error: null };
    });
    expect(asked).toEqual(["id, country, currency", "id, currency"]);
    expect(out).toEqual({
      data: { id: "o1", currency: "usd", country: null, country_column_missing: true },
      error: null,
    });
  });

  it("does not mark a row whose column is there, even when the country is null", async () => {
    const out = await selectWithCountryFallback("id, country", async () => ({
      data: { id: "o1", country: null },
      error: null,
    }));
    expect(out.data).not.toHaveProperty("country_column_missing");
  });

  it("does not retry any other error", async () => {
    let calls = 0;
    const other = {
      code: "PGRST116",
      message: "JSON object requested, multiple (or no) rows returned",
    };
    const out = await selectWithCountryFallback("id, country", async () => {
      calls++;
      return { data: null, error: other };
    });
    expect(calls).toBe(1);
    expect(out.error).toBe(other);
  });
});

describe("updateWithCountryFallback", () => {
  const missing = () =>
    new Error("Could not find the 'country' column of 'organizations' in the schema cache");

  it("writes once and says the country was stored when the column is there", async () => {
    const wrote: Record<string, unknown>[] = [];
    const out = await updateWithCountryFallback({ country: "US", name: "Acme" }, async (p) => {
      wrote.push(p);
    });
    expect(wrote).toEqual([{ country: "US", name: "Acme" }]);
    expect(out).toEqual({ countryColumnMissing: false });
  });

  it("writes the rest without country and says so when the column is not there yet", async () => {
    const wrote: Record<string, unknown>[] = [];
    const out = await updateWithCountryFallback({ country: "US", name: "Acme" }, async (p) => {
      wrote.push(p);
      if ("country" in p) throw missing();
    });
    expect(wrote).toEqual([{ country: "US", name: "Acme" }, { name: "Acme" }]);
    expect(out).toEqual({ countryColumnMissing: true });
  });

  it("does not write an empty patch when country was all there was", async () => {
    let calls = 0;
    const out = await updateWithCountryFallback({ country: "US" }, async () => {
      calls++;
      throw missing();
    });
    expect(calls).toBe(1);
    expect(out).toEqual({ countryColumnMissing: true });
  });

  it("rethrows any other error, and the same error on a patch with no country", async () => {
    const check = new Error(
      'new row for relation "organizations" violates check constraint "organizations_country_iso2"',
    );
    await expect(
      updateWithCountryFallback({ country: "us" }, async () => {
        throw check;
      }),
    ).rejects.toBe(check);
    const err = missing();
    await expect(
      updateWithCountryFallback({ name: "Acme" }, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });

  it("is what updateOrgBranding writes through, and its answer is returned", () => {
    const fns = readFileSync(join(import.meta.dirname, "..", "src/lib/org.functions.ts"), "utf8");
    const fn = fns.slice(fns.indexOf("export const updateOrgBranding"));
    const body = fn.slice(0, fn.indexOf("\n  });"));
    expect(body).toMatch(
      /const \{ countryColumnMissing \} = await updateWithCountryFallback\(patch,/,
    );
    // Other fields may follow it (profilePhoneWarning, #787); this one stays.
    expect(body).toMatch(/return \{ ok: true, countryColumnMissing(, \w+)* \};/);
    expect(body).not.toMatch(/updateOwnOrg\(supabase, orgId, patch\)/);
  });
});
