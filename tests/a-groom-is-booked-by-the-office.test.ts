// Mobile grooming is a service the office can book. A customer still cannot:
// the portal, the public quote and the receptionist leave it out.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { oneOffServiceOptions } from "@/lib/one-off-booking";
import { customerMayBook } from "@/lib/service-lines";
import { listServices } from "@/lib/receptionist-booking";
import type { Caller, ReceptionistStore, ServiceFacts } from "@/lib/receptionist-booking";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const groom: ServiceFacts = {
  id: "groom",
  name: "Full groom",
  service_line: "mobile_grooming",
  active: true,
  price_unit: "visit",
  base_price_cents: 9000,
  extra_pet_cents: 0,
  default_duration_min: 90,
};
const walk: ServiceFacts = {
  id: "walk",
  name: "30-minute walk",
  service_line: "dog_walking",
  active: true,
  price_unit: "visit",
  base_price_cents: 2500,
  extra_pet_cents: 500,
  default_duration_min: 30,
};

describe("customers cannot book a groom", () => {
  it("keeps the line off the customer lists", () => {
    expect(customerMayBook("mobile_grooming")).toBe(false);
    expect(customerMayBook("dog_walking")).toBe(true);
    expect(oneOffServiceOptions([groom, walk], null).map((s) => s.id)).toEqual(["walk"]);
  });

  it("keeps the receptionist from offering or resolving one", async () => {
    const store = {
      org: async () => ({
        timezone: "America/Chicago",
        work_days: [1, 2, 3, 4, 5],
        one_off_price_cents: null,
        portal_auto_accept_bookings: false,
        route_windows: null,
      }),
      services: async () => [groom, walk],
    } as unknown as ReceptionistStore;
    const caller: Caller = { orgId: "org", fromNumber: "+15555550100", clientId: null };
    const listed = await listServices(store, caller);
    expect(listed).toMatchObject({
      services: [{ service_id: "walk", kind: "dog_walking" }],
    });
    expect(JSON.stringify(listed)).not.toContain("groom");
  });

  it("refuses a portal one-off and a public price", () => {
    const portal = read("src/lib/portal.functions.ts");
    expect(portal).toContain('s.service_line !== "mobile_grooming"');
    expect(portal).toContain("Mobile grooming is booked by the office.");
    const sql = read("supabase/migrations/20261016190000_a-groom-appointment-has-a-length.sql");
    expect(sql).toContain("AND s.service_line <> 'mobile_grooming'");
    expect(sql).toContain("service_line = ''mobile_grooming''");
    expect(sql).toContain("RETURN;");
  });
});

describe("a groom appointment has a length", () => {
  const sql = read("supabase/migrations/20261016190000_a-groom-appointment-has-a-length.sql");

  it("stores the length on the visit and prefers it in the named planner functions", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS duration_min integer/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS groom_summary text/);
    expect(sql).toContain(
      "public.stop_service_min(v.duration_min, sv.default_duration_min, p.service_duration_min)",
    );
    expect(sql).toContain("pg_get_functiondef(fn::regprocedure)");
    expect(sql).toContain("'public.route_day_inputs(uuid,uuid[],date,boolean)'");
    expect(sql).toContain(
      "'public.apply_route_plan(uuid,uuid[],date,boolean,jsonb,boolean,uuid[])'",
    );
    expect(sql).not.toMatch(/pg_get_functiondef\(\s*p\.oid/i);
  });

  it("books every six weeks as 42 days and invoices add-ons on their own lines", () => {
    const server = read("src/lib/groom-booking.server.ts");
    expect(server).toMatch(/interval_days: once \? null : input\.everyWeeks! \* 7/);
    expect(6 * 7).toBe(42);
    expect(server).toMatch(/price_cents: petCents/);
    expect(server).not.toMatch(/price_cents: quote\.cents/);
  });
});
