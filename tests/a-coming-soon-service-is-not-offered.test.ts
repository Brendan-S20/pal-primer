/* eslint-disable @typescript-eslint/no-explicit-any */
// A Coming soon service is never offered to a client (#506).
//
// Only pet waste is in BOOKABLE_SERVICE_LINES. A business that runs dog
// walking or pet sitting may still add services on those lines in Settings →
// Services (an owner prepares prices ahead of launch), so the form says those
// lines are Coming soon, and every path a client books through leaves them
// out: the portal's extra-visit picker, the portal's request handler, and the
// AI receptionist's list_services / get_open_slots / book_visit.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { oneOffServiceOptions } from "@/lib/one-off-booking";
import { BOOKABLE_SERVICE_LINES, SERVICE_LINES } from "@/lib/service-lines";
import { isBookableServiceLine, serviceNamePlaceholder } from "@/lib/services";
import { bookVisit, getOpenSlots, listServices } from "../src/lib/receptionist-booking";
import { twoBusinesses } from "./support/fake-receptionist-store";

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

const base = {
  active: true,
  price_unit: "visit" as const,
  extra_pet_cents: 0,
  default_duration_min: 30,
};
const PW = {
  ...base,
  id: "pw",
  name: "Pet waste removal",
  service_line: "pet_waste" as const,
  base_price_cents: null,
  default_duration_min: null,
};
const WALK = {
  ...base,
  id: "w",
  name: "30-minute walk",
  service_line: "dog_walking" as const,
  base_price_cents: 2500,
};
const SIT = {
  ...base,
  id: "s",
  name: "Overnight stay",
  service_line: "pet_sitting" as const,
  price_unit: "night" as const,
  base_price_cents: 6000,
};

describe("the portal's extra-visit picker", () => {
  it("does not offer an active, priced walk or sit while their lines are Coming soon", () => {
    const opts = oneOffServiceOptions([PW, WALK, SIT], 4500);
    expect(opts.map((o) => o.id)).toEqual(["pw"]);
  });

  it("still offers the pet-waste extra cleanup, at the one-off price", () => {
    const [pw] = oneOffServiceOptions([WALK, PW], 4500);
    expect(pw).toMatchObject({ id: "pw", priceCents: 4500, petWaste: true });
  });

  it("offers nothing to a business whose only services are Coming soon", () => {
    expect(oneOffServiceOptions([WALK, SIT], 4500)).toEqual([]);
  });

  it("offers a line once it joins the launch list", () => {
    const opts = oneOffServiceOptions([PW, WALK, SIT], 4500, ["pet_waste", "dog_walking"]);
    expect(opts.map((o) => o.id)).toEqual(["pw", "w"]);
  });

  it("the request handler refuses a Coming soon service before anything is saved", () => {
    const fns = read("src/lib/portal.functions.ts");
    const request = fns.slice(fns.indexOf("export const portalRequestOneOff"));
    const refusal = request.indexOf('oneOffRefusalMessage("service_not_offered")');
    expect(request).toMatch(
      /!\(BOOKABLE_SERVICE_LINES as readonly string\[\]\)\.includes\(service\.service_line\)/,
    );
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(request.indexOf('rpc("portal_request_one_off"'));
  });
});

describe("the AI receptionist", () => {
  it("does not list a walk", async () => {
    const { store, clientA } = twoBusinesses();
    const r: any = await listServices(store, clientA);
    expect(r.services.map((s: any) => s.service_id)).toEqual(["pw-a"]);
  });

  it("refuses to offer days for, or book, a walk", async () => {
    const { db, store, clientA } = twoBusinesses();
    const open: any = await getOpenSlots(store, clientA, { now: db.now, service_id: "walk-a" });
    expect(open).toMatchObject({ available: false, reason: "service_not_offered" });
    const r: any = await bookVisit(store, clientA, {
      date: "2026-10-13",
      service_id: "walk-a",
      now: db.now,
    });
    expect(r).toMatchObject({ booked: false, reason: "service_not_offered" });
    expect(db.tickets).toHaveLength(0);
    expect(db.visits).toHaveLength(0);
  });
});

describe("Settings → Services", () => {
  it("knows which lines are bookable from the launch list", () => {
    for (const line of SERVICE_LINES) {
      expect(isBookableServiceLine(line)).toBe(BOOKABLE_SERVICE_LINES.includes(line));
    }
    expect(isBookableServiceLine("pet_waste")).toBe(true);
    expect(isBookableServiceLine("dog_walking")).toBe(false);
    expect(isBookableServiceLine("pet_sitting")).toBe(false);
  });

  it("marks every non-bookable line Coming soon in the Kind of service picker, with the house badge", () => {
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(/import \{ ComingSoonBadge \} from "@\/components\/ComingSoonBadge";/);
    const items = page.slice(page.indexOf("serviceLineChoices(lines, form.service_line).map"));
    const item = items.slice(0, items.indexOf("</SelectItem>"));
    expect(item).toMatch(/<SelectItem key=\{l\} value=\{l\}>/);
    expect(item).toMatch(/\{!isBookableServiceLine\(l\) && <ComingSoonBadge \/>\}/);
  });

  it("says under the picker that a Coming soon line can be set up but not booked", () => {
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(/\{!isBookableServiceLine\(form\.service_line\) && \(/);
    expect(page).toMatch(/Coming soon: you can set this up now, but clients can't book it yet\./);
  });

  it("does not refuse to save one: createService has no bookable check", () => {
    const fns = read("src/lib/services.functions.ts");
    expect(fns).not.toMatch(/BOOKABLE_SERVICE_LINES|isBookableServiceLine/);
  });

  it("suggests a name for the kind of service chosen", () => {
    expect(serviceNamePlaceholder("pet_waste")).toBe("Weekly yard cleanup");
    expect(serviceNamePlaceholder("dog_walking")).toBe("30-minute walk");
    expect(serviceNamePlaceholder("pet_sitting")).toBe("Overnight stay");
    for (const line of SERVICE_LINES) expect(serviceNamePlaceholder(line)).toMatch(/\S/);
    const page = read("src/routes/_authenticated/settings.services.tsx");
    expect(page).toMatch(/placeholder=\{serviceNamePlaceholder\(form\.service_line\)\}/);
  });
});

describe("Settings → Client portal", () => {
  it("no longer promises a walk, a sit or a groom; it says Coming soon is not offered", () => {
    const card = read("src/components/settings/PortalBookingCard.tsx");
    expect(card).not.toMatch(/a walk, a sit, a groom/);
    expect(card).toMatch(/once their kind of service is bookable; one marked Coming soon/);
  });
});
