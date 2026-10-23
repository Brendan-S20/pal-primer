import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { portalShowsTraining } from "../src/lib/training-portal";
import { customerCanRequestService } from "../src/lib/service-lines";
import { oneOffServiceOptions } from "../src/lib/one-off-booking";
import { publicServiceChoices } from "../src/lib/public-services";
import { bookVisit, getOpenSlots, listServices } from "../src/lib/receptionist-booking";
import type { ReceptionistStore } from "../src/lib/receptionist-booking";
import { progressText, scoreProblem } from "../src/lib/training-progress";

// Walking and training are Coming soon (#506), so today no customer path offers
// either. This file asks the question that outlives launch: with both lines
// bookable, a walk is offered and a lesson still is not.
vi.mock("@/lib/service-lines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/service-lines")>()),
  BOOKABLE_SERVICE_LINES: ["pet_waste", "dog_walking", "training"],
}));

const lesson = {
  id: "lesson",
  name: "Private lesson (60 min)",
  service_line: "training" as const,
  active: true,
  price_unit: "visit" as const,
  base_price_cents: 8000,
  extra_pet_cents: 0,
  default_duration_min: 60,
};

const walk = {
  id: "walk",
  name: "30-minute walk",
  service_line: "dog_walking" as const,
  active: true,
  price_unit: "visit" as const,
  base_price_cents: 2500,
  extra_pet_cents: 0,
  default_duration_min: 30,
};

describe("customers cannot request training", () => {
  it("keeps the line off the portal, the public form and the receptionist", async () => {
    expect(customerCanRequestService("training")).toBe(false);
    expect(customerCanRequestService("dog_walking")).toBe(false);
    expect(oneOffServiceOptions([lesson, walk], null).map((s) => s.id)).toEqual([]);
    expect(publicServiceChoices([lesson, walk]).map((s) => s.id)).toEqual([]);

    const store = {
      org: async () => ({
        timezone: "America/Chicago",
        work_days: [1, 2, 3, 4, 5],
        one_off_price_cents: 4500,
        portal_auto_accept_bookings: true,
        route_windows: null,
      }),
      services: async () => [lesson, walk],
    } as unknown as ReceptionistStore;
    const caller = { orgId: "org", fromNumber: "+15555550100", clientId: null };
    const listed = await listServices(store, caller);
    expect(listed).toMatchObject({
      services: [],
    });
    expect(JSON.stringify(listed)).not.toMatch(/lesson|training/);
    await expect(getOpenSlots(store, caller, { service_id: "lesson" })).resolves.toEqual({
      available: false,
      reason: "service_not_offered",
    });
    await expect(
      bookVisit(store, caller, { date: "2026-10-20", service_id: "lesson" }),
    ).resolves.toEqual({ booked: false, reason: "service_not_offered" });
  });
});

// Since 20261023120000 a client can see training, buy a package and ask for
// the next lesson in the portal. None of that is training as a new service:
// the Training page is only for a client who has a package or whose
// business runs training and sells one, a lesson request is only from a
// package the client holds, and the one-off request and the public list
// still refuse the line.
describe("the package holder's portal path does not open training to new customers", () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

  it("shows the Training page only to a client with a package, or a training business selling one", () => {
    expect(portalShowsTraining({ hasPackage: false, runsTraining: false, forSale: 0 })).toBe(false);
    expect(portalShowsTraining({ hasPackage: false, runsTraining: false, forSale: 4 })).toBe(false);
    expect(portalShowsTraining({ hasPackage: false, runsTraining: true, forSale: 0 })).toBe(false);
    expect(portalShowsTraining({ hasPackage: true, runsTraining: false, forSale: 0 })).toBe(true);
  });

  it("asks for a lesson only from a package that is the client's own", () => {
    const sql = read("supabase/migrations/20261023120000_training-portal.sql");
    const fn = sql.slice(sql.indexOf("FUNCTION public.portal_request_training_lesson"));
    expect(fn).toContain("p.client_id = _client_id AND p.organization_id = _org_id");
    expect(fn).toContain("RAISE EXCEPTION 'package_not_found'");
    // Not a door to a service: it never takes a service id from the caller.
    expect(fn.slice(0, fn.indexOf(")"))).not.toMatch(/_service_id/);
  });

  it("leaves the one-off request and the public service list refusing training", () => {
    const sql = read("supabase/migrations/20261023120000_training-portal.sql");
    expect(sql).not.toMatch(/FUNCTION public\.(portal_request_one_off|public_services)\b/);
    const portal = read("src/lib/portal-training.functions.ts");
    expect(portal).not.toMatch(/portal_request_one_off|customerCanRequestService/);
    // Every handler there asks for the client's own portal session first.
    expect(portal.match(/requirePortalSession\(data\.token/g)).toHaveLength(3);
  });

  it("refuses to sell in the portal at a business that does not run training", () => {
    const server = read("src/lib/training-portal.server.ts");
    const buy = server.slice(server.indexOf("export async function buyPackageFromPortal"));
    expect(buy.indexOf('.includes("training")')).toBeGreaterThan(-1);
    expect(buy.indexOf('.includes("training")')).toBeLessThan(buy.indexOf("createPackageSale("));
  });
});

describe("a lesson score is 1 to 5, and a long note is refused rather than stored", () => {
  it("names a score that is not a whole number from 1 to 5", () => {
    expect(scoreProblem(3)).toBeNull();
    expect(scoreProblem(0)).toMatch(/1 to 5/);
    expect(scoreProblem(1.5)).toMatch(/1 to 5/);
    expect(scoreProblem("3")).toMatch(/1 to 5/);
  });

  it("returns the text and the problem apart, so the error sentence is never the note", () => {
    expect(progressText("  Sit twice  ", 20, "session note")).toEqual({
      text: "Sit twice",
      problem: null,
    });
    expect(progressText("   ", 20, "session note")).toEqual({ text: null, problem: null });
    const tooLong = progressText("x".repeat(21), 20, "session note");
    expect(tooLong.text).toBeNull();
    expect(tooLong.problem).toMatch(/20 characters/);
    expect(tooLong.problem).not.toBe("x".repeat(21));
  });
});
