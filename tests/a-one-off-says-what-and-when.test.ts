// F-05 (round-2 audit, RC3): "Book a visit" asked for a property, a date, a
// price and a tech, and nothing else. So a trainer's evaluation, a groomer's
// one-off and a sitter's drop-in were each booked as the business's default
// service -- the seeded "Pet waste removal", inactive in two of the three
// orgs -- with no time of day. The trainer's My Day then showed "Pet waste
// removal" and no progress panel.
//
// The dialog now asks which service (the business's own, with the seeded
// pet-waste one left out for a business that does not scoop) and an optional
// arrival window. createOneOffVisit already took both (serviceId, and
// earliestTime / latestTime from the walk-request path); nothing on the
// server changed.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { oneOffWindowProblem } from "@/lib/one-off-booked";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const dialog = read("src/components/OneOffVisitDialog.tsx");

describe("the arrival window", () => {
  it("either end may be empty", () => {
    expect(oneOffWindowProblem("", "")).toBeNull();
    expect(oneOffWindowProblem("09:00", "")).toBeNull();
    expect(oneOffWindowProblem("", "17:00")).toBeNull();
  });

  it("after has to come before by", () => {
    expect(oneOffWindowProblem("09:00", "11:30")).toBeNull();
    expect(oneOffWindowProblem("11:30", "09:00")).toMatch(/before/);
    expect(oneOffWindowProblem("10:00", "10:00")).toMatch(/before/);
  });
});

describe("the dialog asks what and when", () => {
  it("offers the business's services through the plan form's picker and rules", () => {
    expect(dialog).toMatch(/useOrgServices\(open\)/);
    expect(dialog).toMatch(/servicePickerOptions\(orgServices, null, pickerLines\)/);
    expect(dialog).toMatch(/<ServicePicker\s+id="oo-service"/);
    expect(dialog).toMatch(/effectiveServiceId\(serviceId, orgServices, pickerLines\)/);
  });

  it("a business that does not scoop always picks; a scoop-only one sees no picker", () => {
    expect(dialog).toMatch(
      /const asksService = serviceOptions\.length > 1 \|\| \(nonWaste && serviceOptions\.length > 0\);/,
    );
    expect(dialog).toMatch(/\(!asksService \|\| !!bookedServiceId\)/);
  });

  it("sends the service and the window, and prices the service it books", () => {
    expect(dialog).toMatch(/\.\.\.\(bookedServiceId \? \{ serviceId: bookedServiceId \} : \{\}\)/);
    expect(dialog).toMatch(/earliestTime: earliestTime \|\| null/);
    expect(dialog).toMatch(/latestTime: latestTime \|\| null/);
    expect(dialog).toMatch(/queryKey: \["one-off-set-price", propertyId, bookedServiceId\]/);
  });

  it("names the extra-visit price only for a pet-waste one-off", () => {
    expect(dialog).toMatch(
      /const pricedAsExtraVisit = !bookedService \|\| bookedService\.service_line === "pet_waste";/,
    );
    expect(dialog).toMatch(/Its price is set in Settings, Services\./);
  });

  it("the server already takes both, so nothing new is trusted from the browser", () => {
    const fns = read("src/lib/visits.functions.ts");
    const create = fns.slice(fns.indexOf("export const createOneOffVisit"));
    expect(create).toMatch(/serviceId: z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(create).toMatch(/earliestTime: z/);
    expect(create).toMatch(/latestTime: z/);
  });
});
