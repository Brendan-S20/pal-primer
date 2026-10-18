// A US business reads its stops in miles (#496).
//
// The board card and the visit drawer printed `travel_km` as "1.6 km" to the
// demo business in Michigan. Storage stays metric; what changed is that the
// label now follows the business's country (organizations.country), then the
// browser's region, then the currency, through one helper that the card, the
// drawer and the route warnings all call.
//
// Same shape as a-forecast-in-degrees-nobody-here-uses.test.ts: the new
// module is imported per test and files are read lazily, so a mutation check
// that stashes the source reports failures with names on them rather than
// "no tests".

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { formatDistance } from "@/lib/measures";
import { findRouteWarnings } from "@/lib/route-plausibility";

const distanceUnit = () => import("@/lib/distance-unit");

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--"));
    })
    .join("\n");

describe("orgDistanceUnit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads miles for a US business, whatever the browser says", async () => {
    const { orgDistanceUnit } = await distanceUnit();
    expect(orgDistanceUnit({ country: "US" }, { locale: "en-GB" })).toBe("mi");
    expect(orgDistanceUnit({ country: "US", currency: "eur" }, { locale: null })).toBe("mi");
  });

  it("reads miles for a US territory", async () => {
    const { orgDistanceUnit } = await distanceUnit();
    expect(orgDistanceUnit({ country: "PR" }, { locale: "es-ES" })).toBe("mi");
    expect(orgDistanceUnit({ country: "GU" }, { locale: null })).toBe("mi");
  });

  it("reads km for any other known country, whatever the browser says", async () => {
    const { orgDistanceUnit } = await distanceUnit();
    expect(orgDistanceUnit({ country: "GB" }, { locale: "en-US" })).toBe("km");
    expect(orgDistanceUnit({ country: "CA", currency: "usd" }, { locale: "en-US" })).toBe("km");
  });

  it("asks the browser when the country is unknown", async () => {
    const { orgDistanceUnit } = await distanceUnit();
    expect(orgDistanceUnit({ country: null }, { locale: "en-US" })).toBe("mi");
    expect(orgDistanceUnit({ country: null, currency: "usd" }, { locale: "en-GB" })).toBe("km");
    expect(orgDistanceUnit({ country: null, currency: "usd" }, { locale: "en-CA" })).toBe("km");
    // A bare language maximizes to its likely region: "en" is en-Latn-US.
    expect(orgDistanceUnit({ country: null }, { locale: "en" })).toBe("mi");
  });

  it("reads navigator.language when no locale is passed", async () => {
    const { orgDistanceUnit } = await distanceUnit();
    vi.stubGlobal("navigator", { language: "en-GB" });
    expect(orgDistanceUnit({ country: null, currency: "usd" })).toBe("km");
    vi.stubGlobal("navigator", { language: "en-US" });
    expect(orgDistanceUnit({ country: null, currency: "eur" })).toBe("mi");
  });

  it("falls back to the currency with no locale at all", async () => {
    const { orgDistanceUnit } = await distanceUnit();
    expect(orgDistanceUnit({ country: null, currency: "usd" }, { locale: null })).toBe("mi");
    expect(orgDistanceUnit({ country: null, currency: "cad" }, { locale: null })).toBe("km");
    // A malformed tag is no locale, not a throw.
    expect(orgDistanceUnit({ currency: "usd" }, { locale: "not a locale!!" })).toBe("mi");
  });

  it("reads km when nothing at all is known", async () => {
    const { orgDistanceUnit } = await distanceUnit();
    expect(orgDistanceUnit(null, { locale: null })).toBe("km");
    expect(orgDistanceUnit(undefined, { locale: null })).toBe("km");
    expect(orgDistanceUnit({}, { locale: null })).toBe("km");
  });
});

describe("formatDistance", () => {
  it("converts and rounds to one decimal", () => {
    // The issue's own example: the Michigan card that read 1.6 km.
    expect(formatDistance(1.6, "mi")).toBe("1.0 mi");
    expect(formatDistance(1.6, "km")).toBe("1.6 km");
    expect(formatDistance(0.6, "mi")).toBe("0.4 mi");
    expect(formatDistance(1.66, "km")).toBe("1.7 km");
    expect(formatDistance(1.609344, "mi")).toBe("1.0 mi");
  });

  it("prints zero as zero", () => {
    expect(formatDistance(0, "mi")).toBe("0.0 mi");
    expect(formatDistance(0, "km")).toBe("0.0 km");
  });

  it("prints nothing for nothing", () => {
    expect(formatDistance(null, "mi")).toBe("");
    expect(formatDistance(undefined, "km")).toBe("");
    expect(formatDistance(Number.NaN, "mi")).toBe("");
    expect(formatDistance("", "mi")).toBe("");
    expect(formatDistance("abc", "km")).toBe("");
  });

  it("accepts the string a numeric column arrives as", () => {
    expect(formatDistance("1.6", "km")).toBe("1.6 km");
    expect(formatDistance("1.6", "mi")).toBe("1.0 mi");
  });

  it("takes fewer digits when asked", () => {
    expect(formatDistance(1854.2, "mi", { digits: 0 })).toBe("1152 mi");
    expect(formatDistance(1854.2, "km", { digits: 0 })).toBe("1854 km");
  });
});

describe("countryFromAddress", () => {
  it("knows a US state and ZIP", async () => {
    const { countryFromAddress } = await distanceUnit();
    expect(countryFromAddress("123 Main St, Austin, TX 78701")).toBe("US");
    expect(countryFromAddress("123 Main St, Grand Rapids, MI 49503-1234, USA")).toBe("US");
    expect(countryFromAddress("4413 Ravenswood, Chicago, IL 60611, United States")).toBe("US");
  });

  it("keeps a territory's own code", async () => {
    const { countryFromAddress } = await distanceUnit();
    expect(countryFromAddress("1 Calle Fortaleza, San Juan, PR 00901")).toBe("PR");
  });

  it("knows a Canadian province and postal code", async () => {
    const { countryFromAddress } = await distanceUnit();
    expect(countryFromAddress("100 King St W, Toronto, ON M5X 1A9, Canada")).toBe("CA");
    expect(countryFromAddress("100 King St W, Toronto, ON M5X1A9")).toBe("CA");
  });

  it("says nothing about anything else", async () => {
    const { countryFromAddress } = await distanceUnit();
    expect(countryFromAddress("10 Downing St, London SW1A 2AA")).toBeNull();
    expect(countryFromAddress("123 Main St")).toBeNull();
    expect(countryFromAddress("")).toBeNull();
    expect(countryFromAddress(null)).toBeNull();
  });
});

describe("the route warning prints the business's unit", () => {
  const far = [
    {
      id: "v1",
      clientName: "Far Away Co",
      travel_km: 1854.2,
      travel_min: 3708,
      scheduled_on: "2026-07-08",
    },
  ];

  it("in km when the board says km", () => {
    const [w] = findRouteWarnings(far, { distanceUnit: "km" });
    expect(w.message).toContain("(1854 km)");
    expect(w.message).not.toMatch(/\bmi\b/);
    expect(w.travelKm).toBe(1854.2);
  });

  it("in miles when the board says miles, and when it says nothing", () => {
    expect(findRouteWarnings(far, { distanceUnit: "mi" })[0].message).toContain("(1152 mi)");
    expect(findRouteWarnings(far)[0].message).toContain("(1152 mi)");
  });

  it("is handed the unit the cards use", () => {
    const routes = codeOnly(read("src/routes/_authenticated/routes.tsx"));
    expect(routes).toMatch(/const distanceUnit = useDistanceUnit\(\);/);
    expect(routes).toMatch(/^\s*distanceUnit,\s*$/m);
  });
});

describe("no display site spells the unit itself", () => {
  const SITES = ["src/routes/_authenticated/routes.tsx", "src/components/VisitDetailDrawer.tsx"];

  it("has no hard-coded km label on the board or in the drawer", () => {
    for (const f of SITES) {
      const src = codeOnly(read(f));
      expect(src, f).not.toMatch(/toFixed\(1\)\}\s*km/);
      expect(src, f).not.toMatch(/\}\s*km\b/);
      expect(src, f).not.toMatch(/" km"/);
      expect(src, f).not.toMatch(/\bkm</);
    }
  });

  it("prints travel_km through formatDistance with the org's unit", () => {
    for (const f of SITES) {
      const src = codeOnly(read(f));
      expect(src, f).toMatch(/import \{ formatDistance \} from "@\/lib\/measures";/);
      expect(src, f).toMatch(/import \{ useDistanceUnit \} from "@\/hooks\/useDistanceUnit";/);
      expect(src, f).toMatch(/formatDistance\((visit|v)\.travel_km, distanceUnit\)/);
    }
  });

  it("reads the unit off the same org row the timezone comes from", () => {
    const fns = read("src/lib/org.functions.ts");
    const select = /"id, name, portal_slug, timezone,[^"]*"/.exec(fns)?.[0] ?? "";
    expect(select).toMatch(/\bcountry\b/);
    expect(select).toMatch(/\bcurrency\b/);
    const hook = codeOnly(read("src/hooks/useDistanceUnit.ts"));
    expect(hook).toMatch(/queryKey: \["my-org"\]/);
    expect(hook).toMatch(/orgDistanceUnit\(/);
  });
});

describe("organizations.country", () => {
  const migration = () => {
    const dir = join(root, "supabase/migrations");
    const f = readdirSync(dir).find((n) =>
      n.endsWith("_a-us-business-reads-its-stops-in-miles.sql"),
    );
    expect(f, "the country migration is missing").toBeTruthy();
    return readFileSync(join(dir, f!), "utf8");
  };

  it("is added idempotently, nullable, two uppercase letters", () => {
    const sql = migration();
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS country text;/);
    expect(sql).toMatch(/CHECK \(country IS NULL OR country ~ '\^\[A-Z\]\{2\}\$'\)/);
    expect(sql).toMatch(/COMMENT ON COLUMN public\.organizations\.country IS/);
  });

  it("backfills only what nobody has set", () => {
    const sql = codeOnly(migration());
    const updates = sql
      .split(/(?=UPDATE public\.organizations)/)
      .filter((s) => s.startsWith("UPDATE"));
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u.slice(0, u.indexOf(";"))).toMatch(/WHERE country IS NULL/);
  });

  it("is written with the rule the column enforces", () => {
    const fns = read("src/lib/org.functions.ts");
    expect(fns).toMatch(/country: z\s*\.string\(\)\s*\.regex\(\/\^\[A-Z\]\{2\}\$\//);
    expect(fns).toMatch(/if \(data\.country !== undefined\) patch\.country = data\.country;/);
  });

  it("is in the generated types", () => {
    const types = read("src/integrations/supabase/types.ts");
    const org = types.slice(types.indexOf("      organizations: {"));
    const block = org.slice(0, org.indexOf("Relationships"));
    expect(block).toMatch(/\n {10}country: string \| null\n/);
    expect(block.match(/\n {10}country\?: string \| null\n/g)).toHaveLength(2);
  });
});
