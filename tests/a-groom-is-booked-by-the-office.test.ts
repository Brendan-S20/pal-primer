// Mobile grooming is a service the office can book. A customer still cannot
// book one through the portal's one-off or the receptionist: both leave it
// out (OFFICE_BOOKED_LINES, customerCanBookService), even now that #549 has
// it bookable and customer requestable on the switch. The public booking
// link is different since #560: it prices a groom per pet size with its
// add-ons, then lets the customer book and pay or send a request.
// A portal client of a grooming business can ASK for a groom (20261024100400),
// and that request goes to the office's queue; only the office books it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { oneOffServiceOptions } from "@/lib/one-off-booking";
import {
  OFFICE_BOOKED_LINES,
  customerCanBookService,
  customerCanRequestService,
} from "@/lib/service-lines";
import { listServices } from "@/lib/receptionist-booking";
import type { Caller, ReceptionistStore, ServiceFacts } from "@/lib/receptionist-booking";
import { GROOMING_COMING_SOON, LAUNCH_DEFAULT } from "./support/service-line-availability";

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
  it("keeps the line off the customer lists while either switch is off", () => {
    expect(customerCanRequestService("mobile_grooming", GROOMING_COMING_SOON)).toBe(false);
    // Walking is bookable (#530); the groom beside it was left out.
    expect(customerCanRequestService("dog_walking", GROOMING_COMING_SOON)).toBe(true);
    expect(
      oneOffServiceOptions([groom, walk], null, GROOMING_COMING_SOON).map((s) => s.id),
    ).toEqual(["walk"]);
    // Bookable for the office but not customer requestable: still left out.
    const officeOnly = {
      ...LAUNCH_DEFAULT,
      customerRequestable: LAUNCH_DEFAULT.customerRequestable.filter(
        (l) => l !== "mobile_grooming",
      ),
    };
    expect(oneOffServiceOptions([groom, walk], null, officeOnly).map((s) => s.id)).toEqual([
      "walk",
    ]);
  });

  it("still keeps it off once #549 turns both columns on: a client asks, the office books", () => {
    expect(customerCanRequestService("mobile_grooming", LAUNCH_DEFAULT)).toBe(true);
    expect(customerCanBookService("mobile_grooming", LAUNCH_DEFAULT)).toBe(false);
    expect(customerCanBookService("dog_walking", LAUNCH_DEFAULT)).toBe(true);
    expect([...OFFICE_BOOKED_LINES]).toEqual(["mobile_grooming"]);
    expect(oneOffServiceOptions([groom, walk], null, LAUNCH_DEFAULT).map((s) => s.id)).toEqual([
      "walk",
    ]);
  });

  it("the doors that book directly ask customerCanBookService, and the booking link asks bookingLinkOffersLine", () => {
    for (const file of ["src/lib/one-off-booking.ts", "src/lib/receptionist-booking.ts"]) {
      const src = read(file);
      expect(src, file).toContain("customerCanBookService(");
      expect(src, file).not.toContain("customerCanRequestService(");
    }
    for (const file of [
      "src/lib/public-services.ts",
      "src/lib/signup.functions.ts",
      "src/routes/api/public/leads.ts",
    ]) {
      const src = read(file);
      expect(src, file).toContain("bookingLinkOffersLine(");
      expect(src, file).not.toContain("customerCanBookService(");
      expect(src, file).not.toContain("customerCanRequestService(");
    }
    // A groom on the link can be booked and paid for, or requested (#560,
    // Brendan Oct 28: both options). Its checkout is not refused; a stay's is.
    const fns = read("src/lib/signup.functions.ts");
    const checkout = fns.slice(fns.indexOf("export const createSignupPaymentIntent"));
    expect(fns).not.toContain("refuseAGroomStart");
    expect(checkout).toContain("refuseAStay(named);");
  });

  it.each([
    ["with grooming off", GROOMING_COMING_SOON],
    ["with grooming on (#549)", LAUNCH_DEFAULT],
  ] as const)(
    "keeps the receptionist from offering or resolving one %s",
    async (_, availability) => {
      const store = {
        org: async () => ({
          timezone: "America/Chicago",
          work_days: [1, 2, 3, 4, 5],
          one_off_price_cents: null,
          portal_auto_accept_bookings: false,
          route_windows: null,
        }),
        services: async () => [groom, walk],
        serviceLineAvailability: async () => availability,
      } as unknown as ReceptionistStore;
      const caller: Caller = { orgId: "org", fromNumber: "+15555550100", clientId: null };
      const listed = await listServices(store, caller);
      expect(listed).toMatchObject({
        services: [{ service_id: "walk", kind: "dog_walking" }],
      });
      expect(JSON.stringify(listed)).not.toContain("groom");
    },
  );

  it("refuses a portal one-off and a public price", () => {
    const portal = read("src/lib/portal.functions.ts");
    expect(portal).toContain('s.service_line !== "mobile_grooming"');
    expect(portal).toContain("Mobile grooming is booked by the office.");
    const sql = read("supabase/migrations/20261024100200_a-groom-appointment-has-a-length.sql");
    expect(sql).toContain("AND s.service_line <> 'mobile_grooming'");
    expect(sql).toContain("service_line = ''mobile_grooming''");
    expect(sql).toContain("RETURN;");
  });
});

describe("a portal groom request is a request, not a booking", () => {
  it("opens with both switches (#549), and not with either alone", () => {
    expect(LAUNCH_DEFAULT.bookable).toEqual([
      "pet_waste",
      "dog_walking",
      "pet_sitting",
      "training",
      "mobile_grooming",
    ]);
    expect(LAUNCH_DEFAULT.customerRequestable).toContain("mobile_grooming");
    expect(customerCanRequestService("mobile_grooming", LAUNCH_DEFAULT)).toBe(true);
    expect(customerCanRequestService("mobile_grooming", GROOMING_COMING_SOON)).toBe(false);
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

  it("kept grooming off the public form until the booking link could price it (#560)", () => {
    const sql = read("supabase/migrations/20261024100400_grooming-portal.sql");
    expect(sql).not.toMatch(/public_services|public_quote|receptionist/);
    // Customers are asked through the switch's second column, which the seed
    // leaves off for grooming (#531).
    expect(
      read("supabase/migrations/20261025200000_one-switch-decides-what-is-bookable.sql"),
    ).toMatch(/\('mobile_grooming',\s*false,\s*false\)/);
  });
});

describe("a groom appointment has a length", () => {
  const sql = read("supabase/migrations/20261024100200_a-groom-appointment-has-a-length.sql");

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
