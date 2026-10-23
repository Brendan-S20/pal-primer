// Mobile grooming is a service the office can book. A customer still cannot:
// the portal's booking, the public quote and the receptionist leave it out.
// A portal client of a grooming business can ASK for a groom (20261023121100),
// and that request goes to the office's queue; only the office books it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { oneOffServiceOptions } from "@/lib/one-off-booking";
import { CUSTOMER_BOOKABLE_SERVICE_LINES, customerMayBook } from "@/lib/service-lines";
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
    expect(customerMayBook("dog_walking")).toBe(false);
    expect(oneOffServiceOptions([groom, walk], null).map((s) => s.id)).toEqual([]);
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
      services: [],
    });
    expect(JSON.stringify(listed)).not.toContain("groom");
  });

  it("refuses a portal one-off and a public price", () => {
    const portal = read("src/lib/portal.functions.ts");
    expect(portal).toContain('s.service_line !== "mobile_grooming"');
    expect(portal).toContain("Mobile grooming is booked by the office.");
    const sql = read("supabase/migrations/20261023120700_a-groom-appointment-has-a-length.sql");
    expect(sql).toContain("AND s.service_line <> 'mobile_grooming'");
    expect(sql).toContain("service_line = ''mobile_grooming''");
    expect(sql).toContain("RETURN;");
  });
});

describe("a portal groom request is a request, not a booking", () => {
  it("leaves the customer-bookable lines as they were", () => {
    expect(CUSTOMER_BOOKABLE_SERVICE_LINES).toEqual(["pet_waste"]);
    expect(customerMayBook("mobile_grooming")).toBe(false);
  });

  it("asks portal_request_groom and nothing that books", () => {
    const server = read("src/lib/portal-groom.server.ts");
    expect(server).toContain('db.rpc("portal_request_groom"');
    for (const booking of [
      "bookGroomAppointment",
      "groom-booking.server",
      "bookOneOffVisit",
      "one-off-visit.server",
      'from("visits")',
      'from("subscriptions")',
      ".insert(",
    ])
      expect(server).not.toContain(booking);
  });

  it("is booked by the office through bookGroom, behind manage_pricing", () => {
    const concerns = read("src/lib/concerns.functions.ts");
    const link = concerns.slice(concerns.indexOf("export const linkGroomBooking"));
    expect(link).toContain('"manage_pricing"');
    expect(link).toContain('ticket.category !== "groom_request"');
    const page = read("src/routes/_authenticated/concerns.tsx");
    expect(page).toContain("<BookGroomDialog");
    expect(page).toContain("canBook={canManagePricing}");
  });

  it("keeps grooming off public signup, the public form and the receptionist", () => {
    const sql = read("supabase/migrations/20261023121100_grooming-portal.sql");
    expect(sql).not.toMatch(/public_services|public_quote|receptionist/);
    expect(read("src/lib/service-lines.ts")).toContain(
      'export const CUSTOMER_BOOKABLE_SERVICE_LINES: readonly ServiceLine[] = BOOKABLE_SERVICE_LINES;',
    );
  });
});

describe("a groom appointment has a length", () => {
  const sql = read("supabase/migrations/20261023120700_a-groom-appointment-has-a-length.sql");

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
