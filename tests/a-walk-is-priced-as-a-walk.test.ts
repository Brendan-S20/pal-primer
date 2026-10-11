// A walk is priced as a walk: the service catalog, phase 5 (pricing).
//
// Phases 1-4 put a service on every plan and visit and left the PRICE alone.
// This change prices everything that is not pet waste from its service, in
// one rule written twice:
//
//   public.service_price_cents   supabase/migrations/20261011100000_a-walk-is-priced-as-a-walk.sql
//   servicePriceCents            src/lib/services.ts
//
// and the first group below holds the two to ONE table: the rows are read off
// the migration's own check block (which Postgres runs on every replay) and
// run through the TypeScript, the way stop_service_min / visitServiceMinutes
// are held together. A row added to either side without the other fails here.
//
// The owner's decisions, which the rest of the file pins:
//   * each business chooses flat or hourly per service (night for sitting);
//   * pet waste keeps zone and area pricing EXACTLY as today. public_quote
//     with no service, or a pet-waste one, is the 20260929120000 body
//     verbatim; the drift report compares a pet-waste plan as it always did;
//     the portal's extra cleanup is still the org's one-off price.
//
// The database half is tests/sql/a-walk-is-priced-as-a-walk.proof.sql, run
// by tests/a-walk-is-priced-as-a-walk-in-a-real-database.test.ts: it
// captures the public quote BEFORE the migration and compares it after.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isZonePriced, servicePriceCents } from "@/lib/services";
import {
  computePricingDrift,
  driftBasis,
  sortBySeverity,
  type DriftService,
  type DriftSubscription,
} from "@/lib/pricing-drift";
import {
  oneOffRefusalMessage,
  oneOffRequestWord,
  oneOffServiceOptions,
  oneOffVisitNote,
} from "@/lib/one-off-booking";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOnly = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

const PRICING = "supabase/migrations/20261011100000_a-walk-is-priced-as-a-walk.sql";
const INVOICE = "supabase/migrations/20261011100100_an-invoice-names-the-service.sql";
const PORTAL = "supabase/migrations/20261011100200_a-customer-asks-for-a-walk.sql";
const OLD_QUOTE = "supabase/migrations/20260929120000_the-first-cleanup-had-no-price.sql";

// ── the one table ──────────────────────────────────────────────────────────

type Row = {
  unit: "visit" | "hour" | "night";
  base: number | null;
  extra: number;
  dur: number | null;
  pets: number;
  mins: number | null;
  nights: number;
  mult: number;
  want: number | null;
};

/** The VALUES rows of the migration's check block, as data. */
function sqlTable(): Row[] {
  const sql = read(PRICING);
  const block = sql.slice(sql.indexOf("SELECT * FROM (VALUES"), sql.indexOf(") AS t(unit, base"));
  const rows: Row[] = [];
  for (const line of block.split("\n")) {
    const m = /^\s*\('(visit|hour|night)',\s*([^)]*)\)\s*,?\s*(?:--.*)?$/.exec(line);
    if (!m) continue;
    const cells = m[2].split(",").map((c) => c.trim().replace(/::\w+$/, ""));
    const num = (c: string) => (c === "NULL" ? null : Number(c));
    expect(cells, line).toHaveLength(8);
    rows.push({
      unit: m[1] as Row["unit"],
      base: num(cells[0]),
      extra: Number(cells[1]),
      dur: num(cells[2]),
      pets: Number(cells[3]),
      mins: num(cells[4]),
      nights: Number(cells[5]),
      mult: Number(cells[6]),
      want: num(cells[7]),
    });
  }
  return rows;
}

describe("one pricing rule, in SQL and in TypeScript", () => {
  const table = sqlTable();

  it("has the fourteen rows the migration says it has", () => {
    expect(table).toHaveLength(14);
    expect(read(PRICING)).toMatch(/IF _n <> 14 THEN/);
  });

  it.each(table.map((r) => [JSON.stringify(r), r] as const))(
    "servicePriceCents agrees with the SQL on %s",
    (_label, r) => {
      expect(
        servicePriceCents(
          {
            price_unit: r.unit,
            base_price_cents: r.base,
            extra_pet_cents: r.extra,
            default_duration_min: r.dur,
          },
          { pets: r.pets, minutes: r.mins, nights: r.nights, multiplier: r.mult },
        ),
      ).toBe(r.want);
    },
  );

  it("covers every unit, a NULL price, a NULL duration and a rounding tie", () => {
    const units = new Set(table.map((r) => r.unit));
    expect([...units].sort()).toEqual(["hour", "night", "visit"]);
    expect(table.some((r) => r.base === null && r.want === null)).toBe(true);
    expect(table.some((r) => r.unit === "hour" && r.dur === null && r.mins === null)).toBe(true);
    // 1 cent/hour for 30 minutes is exactly half a cent; both sides round up.
    expect(table.some((r) => r.base === 1 && r.mins === 30 && r.want === 1)).toBe(true);
  });

  it("keeps the arithmetic in integers until the one division, in both copies", () => {
    const src = read("src/lib/services.ts");
    expect(src).toMatch(/Math\.round\(\(perUnit \* minutes \* mult\) \/ 60\)/);
    expect(codeOnly(read(PRICING))).toMatch(/round\(_per_unit \* _mins \* _multiplier \/ 60\)::integer/);
  });

  it("is IMMUTABLE and not the publishable key's to call", () => {
    const sql = codeOnly(read(PRICING));
    expect(sql).toMatch(/FUNCTION public\.service_price_cents\([\s\S]*?\)\s*RETURNS integer\s+LANGUAGE plpgsql\s+IMMUTABLE/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.service_price_cents\(text, integer, integer, integer, integer, integer, integer, numeric\) FROM PUBLIC, anon;/,
    );
  });

  it("pet waste is zone-priced and never reaches the rule", () => {
    expect(isZonePriced({ service_line: "pet_waste" })).toBe(true);
    for (const line of ["dog_walking", "pet_sitting", "mobile_grooming", "other"] as const)
      expect(isZonePriced({ service_line: line })).toBe(false);
  });
});

// ── public_quote ───────────────────────────────────────────────────────────

describe("public_quote gains a service and keeps its old answer", () => {
  const sql = read(PRICING);
  const code = codeOnly(sql);

  it("drops the five-argument function and creates the six-argument one, last argument optional", () => {
    expect(code).toMatch(/DROP FUNCTION IF EXISTS public\.public_quote\(text, text, integer, text, text\);/);
    expect(code).toMatch(/_last_cleaned text DEFAULT NULL,\s*_service_id uuid DEFAULT NULL\s*\)/);
    // No price goes in (the first-cleanup proof's rule, kept).
    const args = code.slice(
      code.indexOf("CREATE OR REPLACE FUNCTION public.public_quote("),
      code.indexOf("RETURNS TABLE("),
    );
    expect(args).not.toMatch(/cents/i);
  });

  it("returns the same columns, so a caller that never heard of services reads the same row", () => {
    const returns = (s: string) => s.slice(s.indexOf("RETURNS TABLE("), s.indexOf("LANGUAGE plpgsql"));
    expect(returns(codeOnly(read(OLD_QUOTE)))).toBe(returns(code));
  });

  it("keeps the 20260929120000 pricing body verbatim as the pet-waste path", () => {
    const old = codeOnly(read(OLD_QUOTE));
    const from = "_mult := COALESCE((_org.frequency_multipliers ->> _frequency)::numeric, 1.0);";
    const to = "RETURN NEXT;";
    const oldBody = old.slice(old.indexOf(from), old.indexOf(to, old.indexOf(from)) + to.length);
    expect(oldBody.length).toBeGreaterThan(500);
    expect(code).toContain(oldBody);
    // And the org and zone lookups before it.
    const zoneLookup = old.slice(old.indexOf("SELECT z.* INTO _zone"), old.indexOf("IF NOT FOUND THEN RETURN; END IF;", old.indexOf("SELECT z.* INTO _zone")));
    expect(code).toContain(zoneLookup);
  });

  it("goes to the service only when one is named and it is not pet waste", () => {
    expect(code).toMatch(/IF _svc\.id IS NOT NULL AND _svc\.service_line <> 'pet_waste' THEN/);
    expect(code).toMatch(/WHERE s\.id = _service_id AND s\.organization_id = _org\.id;\s*IF NOT FOUND THEN RETURN; END IF;/);
    expect(code).toMatch(/IF NOT _svc\.active THEN RETURN; END IF;/);
    // Through the one rule, with no cadence multiplier and no first cleanup.
    expect(code).toMatch(
      /public\.service_price_cents\(\s*_svc\.price_unit, _svc\.base_price_cents, _svc\.extra_pet_cents,\s*_svc\.default_duration_min, _dog_count, NULL, 1, 1\)/,
    );
    const svcBranch = code.slice(
      code.indexOf("IF _svc.id IS NOT NULL AND"),
      code.indexOf("_mult := COALESCE"),
    );
    expect(svcBranch).toMatch(/recurring_price_cents := _base_visit_cents;/);
    expect(svcBranch).toMatch(/initial_cleanup_cents := 0;/);
    expect(svcBranch).toMatch(/first_cleanup_mode := 'off';/);
    expect(svcBranch).toMatch(/first_cleanup_options := '\[\]'::jsonb;/);
    expect(svcBranch).not.toMatch(/frequency_multipliers/);
  });

  it("still refuses a closed account and still gates on the signup switch", () => {
    expect(code).toMatch(/\(\s*o\.portal_slug = _slug OR o\.slug = _slug\s*\)/);
    expect(code).toMatch(/o\.deleted_at IS NULL/);
    expect(code).toMatch(/o\.public_signup_enabled = true/);
  });

  it("is granted back to anon after the fresh object's PUBLIC grant is revoked", () => {
    const revoke = code.indexOf(
      "REVOKE ALL ON FUNCTION public.public_quote(text, text, integer, text, text, uuid) FROM PUBLIC;",
    );
    const grant = code.indexOf("GRANT EXECUTE ON FUNCTION public.public_quote(text, text, integer, text, text, uuid)");
    expect(revoke).toBeGreaterThan(-1);
    expect(grant).toBeGreaterThan(revoke);
    expect(code.slice(grant, grant + 200)).toMatch(/TO anon, authenticated, service_role;/);
  });

  it("the generated types know the argument", () => {
    const types = read("src/integrations/supabase/types.ts");
    const quote = types.slice(types.indexOf("      public_quote: {"), types.indexOf("      public_quote_document:"));
    expect(quote).toMatch(/_service_id\?: string/);
  });
});

// ── the drift report ───────────────────────────────────────────────────────

const ZONE = {
  id: "z1",
  name: "Downtown",
  base_price_cents: 2500,
  per_dog_addl_cents: 500,
  pricing_mode: "flat" as const,
  price_per_sqft_cents: 0,
  price_per_acre_cents: 0,
  area_min_charge_cents: 0,
  area_max_charge_cents: null,
};
const MULTS = { weekly: 1, biweekly: 1.7, twice_weekly: 1.8, monthly: 3.2 };
const PET_WASTE: DriftService = {
  id: "pw",
  name: "Pet waste removal",
  service_line: "pet_waste",
  price_unit: "visit",
  base_price_cents: null,
  extra_pet_cents: 0,
  default_duration_min: null,
};
const WALK: DriftService = {
  id: "w",
  name: "30-minute walk",
  service_line: "dog_walking",
  price_unit: "visit",
  base_price_cents: 2500,
  extra_pet_cents: 500,
  default_duration_min: 30,
};
const GROOM: DriftService = {
  id: "g",
  name: "Full groom",
  service_line: "mobile_grooming",
  price_unit: "hour",
  base_price_cents: 6000,
  extra_pet_cents: 1000,
  default_duration_min: 90,
};

function sub(over: Partial<DriftSubscription> = {}): DriftSubscription {
  return {
    id: "s1",
    clientId: "c1",
    clientName: "A Client",
    frequency: "weekly",
    priceCents: 2500,
    dogCount: 1,
    zone: ZONE,
    boundaryAreaSqm: null,
    pricedAt: null,
    pricedFromZoneId: null,
    priceOverriddenAt: null,
    ...over,
  };
}

describe("the drift report compares a walk against a walk", () => {
  it("compares a pet-waste plan against its zone exactly as before, service or no service", () => {
    const before = computePricingDrift([sub({ frequency: "biweekly" })], MULTS);
    const after = computePricingDrift([sub({ frequency: "biweekly", service: PET_WASTE })], MULTS);
    const strip = ({ basis: _b, serviceName: _n, ...r }: (typeof before.rows)[number]) => r;
    expect(after.rows.map(strip)).toEqual(before.rows.map(strip));
    expect(after.rows[0].basis).toBe("zone");
    expect(after.rows[0].serviceName).toBe("Pet waste removal");
    // Biweekly pet waste still carries the 1.7 multiplier.
    expect(after.rows[0].todayCents).toBe(4250);
    expect(after.summary).toEqual({ ...before.summary });
  });

  it("compares a walk against its service, not the zone", () => {
    const { rows } = computePricingDrift([sub({ service: WALK, priceCents: 2500 })], MULTS);
    expect(rows[0].basis).toBe("service");
    expect(rows[0].outcome).toBe("on_rate");
    expect(rows[0].todayCents).toBe(2500);
    // The zone is still reported, for where the plan is routed.
    expect(rows[0].zoneName).toBe("Downtown");
  });

  it("ignores the cadence multiplier for a walk: five walks a week cost five walks", () => {
    const { rows } = computePricingDrift(
      [sub({ service: WALK, frequency: "biweekly", priceCents: 2500 })],
      MULTS,
    );
    expect(rows[0].todayCents).toBe(2500);
    expect(rows[0].outcome).toBe("on_rate");
  });

  it("counts the plan's dogs through the service's extra-pet charge", () => {
    const { rows } = computePricingDrift([sub({ service: WALK, dogCount: 3, priceCents: 3000 })], MULTS);
    expect(rows[0].todayCents).toBe(3500);
    expect(rows[0].outcome).toBe("under");
    expect(rows[0].diffCents).toBe(500);
  });

  it("prices an hourly service at its own duration", () => {
    const { rows } = computePricingDrift([sub({ service: GROOM, dogCount: 2, priceCents: 9000 })], MULTS);
    // (6000 + 1000) × 1.5 hours
    expect(rows[0].todayCents).toBe(10500);
  });

  it("does not need a zone to compare a walk", () => {
    const { rows, summary } = computePricingDrift([sub({ service: WALK, zone: null })], MULTS);
    expect(rows[0].outcome).toBe("on_rate");
    expect(rows[0].zoneName).toBeNull();
    expect(summary.noZone).toBe(0);
  });

  it("gives a non-waste service with no price its own outcome, no_price, counted apart", () => {
    const { rows, summary } = computePricingDrift(
      [sub({ service: { ...WALK, base_price_cents: null } }), sub({ id: "s2", zone: null })],
      MULTS,
    );
    expect(rows[0].outcome).toBe("no_price");
    expect(rows[0].todayCents).toBeNull();
    expect(rows[0].ratio).toBeNull();
    expect(rows[1].outcome).toBe("no_zone");
    expect(summary.noPrice).toBe(1);
    expect(summary.noZone).toBe(1);
    expect(summary.onRate).toBe(0);
    // Unrankable rows sort last.
    const sorted = sortBySeverity([
      ...rows,
      ...computePricingDrift([sub({ id: "s3", service: WALK, priceCents: 1000 })], MULTS).rows,
    ]);
    expect(sorted[0].subscriptionId).toBe("s3");
  });

  it("decides the basis once", () => {
    expect(driftBasis(null)).toBe("zone");
    expect(driftBasis(undefined)).toBe("zone");
    expect(driftBasis(PET_WASTE)).toBe("zone");
    expect(driftBasis(WALK)).toBe("service");
  });

  it("reads the plan's service on the server and says 'Priced by' on the page", () => {
    const fns = read("src/lib/pricing-drift.functions.ts");
    expect(fns).toMatch(/services \( id, name, service_line, price_unit, base_price_cents,\s*extra_pet_cents, default_duration_min \)/);
    const page = read("src/routes/_authenticated/pricing-drift.tsx");
    expect(page).toMatch(/<TableHead>Priced by<\/TableHead>/);
    expect(page).toMatch(/no_price: "No price set"/);
    expect(page).toMatch(/if \(r\.basis === "service"\) return r\.serviceName \?\? "Service";/);
  });
});

// ── invoices ───────────────────────────────────────────────────────────────

describe("an invoice line names the visit's service", () => {
  const sql = read(INVOICE);
  const code = codeOnly(sql);

  it("decides the word in one function, and the seeded pet-waste name still reads Service", () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.service_line_item_name\(_service_name text, _fallback text DEFAULT 'Service'\)/);
    expect(code).toMatch(/lower\(btrim\(_service_name\)\) IN \('', 'pet waste removal'\) THEN _fallback/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.service_line_item_name\(text, text\) FROM PUBLIC, anon;/);
  });

  it("splices the two generators rather than retyping them, each anchor exactly once", () => {
    // Retyping would drop the price freeze (20260903150000) and the tax
    // splice (20260929110000); a-price-that-cannot-reach-backwards fails any
    // file that recreates the postpaid generator without the freeze.
    expect(sql).not.toContain("CREATE OR REPLACE FUNCTION public.admin_generate_invoice_for_client");
    expect(sql).not.toContain("CREATE OR REPLACE FUNCTION public.generate_prepaid_invoice");
    expect(code).toMatch(/pg_get_functiondef\('public\.admin_generate_invoice_for_client\(uuid, date\)'::regprocedure\)/);
    expect(code).toMatch(/pg_get_functiondef\('public\.generate_prepaid_invoice\(uuid, integer\)'::regprocedure\)/);
    expect(code).toMatch(/IF _count <> 1 THEN/);
    expect(code).toMatch(/LEFT JOIN public\.services sv ON sv\.id = v\.service_id/);
    expect(code).toMatch(/_desc := public\.service_line_item_name\(_v\.service_name\) \|\| '' on ''/);
    expect(code).toMatch(/'Prepaid '' \|\| public\.service_line_item_name\(_v\.service_name, ''service''\) \|\| '' on ''/);
  });

  it("is a no-op on a second run", () => {
    expect(code.match(/IF strpos\(_def, 'service_line_item_name'\) > 0 THEN/g)).toHaveLength(2);
  });

  it("the screen's date humanizer still finds the day in the new shapes", async () => {
    const { formatLineItemDescription } = await import("@/lib/invoice-labels");
    const { formatDay } = await import("@/lib/format");
    expect(formatLineItemDescription("30-minute walk on 2026-10-11 - 412 Elm St")).toBe(
      `30-minute walk on ${formatDay("2026-10-11")} - 412 Elm St`,
    );
    expect(formatLineItemDescription("Prepaid Overnight stay on 2026-10-11")).toBe(
      `Prepaid Overnight stay on ${formatDay("2026-10-11")}`,
    );
  });
});

// ── the portal ─────────────────────────────────────────────────────────────

const PW_SERVICE = {
  id: "pw",
  name: "Pet waste removal",
  service_line: "pet_waste" as const,
  active: true,
  price_unit: "visit" as const,
  base_price_cents: null,
  extra_pet_cents: 0,
  default_duration_min: null,
};
const WALK_SERVICE = { ...WALK, active: true };
const UNPRICED = { ...WALK, id: "u", name: "Drop-in", base_price_cents: null, active: true };
const RETIRED = { ...WALK, id: "r", name: "Old walk", active: false };

describe("the portal offers the business's services", () => {
  it("lists the extra cleanup at the one-off price and every active, priced service at its own", () => {
    const opts = oneOffServiceOptions([UNPRICED, WALK_SERVICE, RETIRED, PW_SERVICE], 4500);
    expect(opts.map((o) => o.id)).toEqual(["pw", "w"]);
    expect(opts[0]).toEqual({ id: "pw", name: "Pet waste removal", priceCents: 4500, perExtraPetCents: 0, petWaste: true });
    expect(opts[1]).toEqual({ id: "w", name: "30-minute walk", priceCents: 2500, perExtraPetCents: 500, petWaste: false });
  });

  it("keeps the extra cleanup on offer with no price, as it always was", () => {
    const opts = oneOffServiceOptions([PW_SERVICE], null);
    expect(opts).toEqual([{ id: "pw", name: "Pet waste removal", priceCents: null, perExtraPetCents: 0, petWaste: true }]);
  });

  it("says why a service was refused, and names what was asked for", () => {
    expect(oneOffRefusalMessage("service_not_offered")).toMatch(/isn't offered right now/);
    expect(oneOffRequestWord(null)).toBe("Extra cleanup");
    expect(oneOffRequestWord({ name: "Pet waste removal", service_line: "pet_waste" })).toBe("Extra cleanup");
    expect(oneOffRequestWord({ name: "30-minute walk", service_line: "dog_walking" })).toBe("30-minute walk");
    // The timeline note reads as before unless a service is named.
    expect(oneOffVisitNote("Fri, Oct 16", false)).toBe(
      "Extra visit the client asked for from the portal for Fri, Oct 16",
    );
    expect(oneOffVisitNote("", true)).toBe("Extra visit the client asked for from the portal (booked automatically)");
    expect(oneOffVisitNote("Fri, Oct 16", true, "30-minute walk")).toBe(
      "30-minute walk the client asked for from the portal (booked automatically)",
    );
  });

  it("the request carries the service to the database, and the extra cleanup as no service", () => {
    const fns = read("src/lib/portal.functions.ts");
    expect(fns).toMatch(/serviceId: z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(fns).toMatch(/\.\.\.\(data\.serviceId \? \{ _service_id: data\.serviceId \} : \{\}\)/);
    // Auto-accept: the one-off price for pet waste, the service's price otherwise.
    expect(fns).toMatch(/priceCents: petWaste \? Number\(org\.one_off_price_cents\) : "service"/);
    const card = read("src/components/portal/OneOffBookingCard.tsx");
    expect(card).toMatch(/\{services\.length > 1 && \(/);
    expect(card).toMatch(/id="one-off-what"/);
    expect(card).toMatch(/\.\.\.\(chosen && !chosen\.petWaste \? \{ serviceId: chosen\.id \} : \{\}\)/);
    expect(card).toMatch(/touch:min-h-11/);
  });

  it("the migration adds the column and the argument, service_role only", () => {
    const code = codeOnly(read(PORTAL));
    expect(code).toMatch(/ALTER TABLE public\.qc_tickets\s+ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES public\.services\(id\);/);
    expect(code).toMatch(/DROP FUNCTION IF EXISTS public\.portal_request_one_off\(uuid, uuid, date, text\);/);
    expect(code).toMatch(/_token uuid, _property_id uuid, _on date, _message text,\s*_service_id uuid DEFAULT NULL/);
    expect(code).toMatch(/IF NOT FOUND THEN RAISE EXCEPTION 'service_not_offered'; END IF;/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.portal_request_one_off\(uuid, uuid, date, text, uuid\) FROM PUBLIC, anon, authenticated;/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.portal_request_one_off\(uuid, uuid, date, text, uuid\) TO service_role;/);
    // The old rules, unchanged.
    expect(code).toMatch(/_on\s*>\s*_today\s*\+\s*30\s+THEN/);
    expect(code).toMatch(/extract\(dow FROM _on\)::int = ANY/);
  });

  it("the office books the service the client asked for", () => {
    const dialog = read("src/components/BookOneOffRequestDialog.tsx");
    expect(dialog).toMatch(/serviceId: requestedService\(t\)!\.id/);
    expect(dialog).toMatch(/servicePriceCents\(svc, \{ pets: 1 \}\)/);
    const server = read("src/lib/one-off-visit.server.ts");
    expect(server).toMatch(/priceCents: number \| "service";/);
    expect(server).toMatch(/\.\.\.\(input\.serviceId \? \{ service_id: input\.serviceId \} : \{\}\)/);
    expect(server).toMatch(/servicePriceCents\(svc, \{ pets: dogCount \?\? 1 \}\)/);
    expect(read("src/lib/visits.functions.ts")).toMatch(/serviceId: z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(read("src/lib/concerns.functions.ts")).toMatch(/service:services\(id, name, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min\)/);
  });

  it("the re-clean button stays pet-waste-only", () => {
    expect(read("src/lib/portal.functions.ts")).toMatch(/reclean_window_hours: petWaste \?/);
  });
});

// ── the plan form ──────────────────────────────────────────────────────────

describe("the plan form prices an hourly service by the minute", () => {
  const tab = read("src/components/client-detail/ServicesTab.tsx");

  it("shows Minutes per visit only for an hourly service, blank meaning the service's own", () => {
    expect(tab).toMatch(/const hourly = chosenService\?\.price_unit === "hour";/);
    expect(tab).toMatch(/\{hourly && \(\s*<div className="mt-2">\s*<Label htmlFor="sd-minutes">Minutes per visit<\/Label>/);
    expect(tab).toMatch(/minutes: errors\.minutes \? null : minutesForPricing,/);
    expect(tab).toMatch(/Between 1 and 720 minutes/);
  });

  it("says what the suggested price is made of", () => {
    expect(tab).toMatch(/min at \$\$\{\(\(chosenService\.base_price_cents \?\? 0\) \/ 100\)\.toFixed\(2\)\} per hour\)/);
    expect(tab).toMatch(/\{servicePriceHint\}/);
  });

  it("still prefills a blank price from the service on a change, and resets the minutes", () => {
    expect(tab).toMatch(/servicePriceCents\(next, \{ pets: dogsForPricing \}\)/);
    expect(tab).toMatch(/setHourlyMinutes\(""\);/);
    expect(tab).toMatch(/Price \(\$ per visit\)/);
  });
});
