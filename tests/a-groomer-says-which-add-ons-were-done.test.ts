// #412: the pieces of the mobile groomer path that were still missing.
//
//  - A groomer ticks off the add-ons booked on a groom, and one left unticked
//    is not billed when the groom is completed.
//  - The van's power and water at the address, set by the office and read by
//    the groomer.
//  - The client reads each finished groom's report in the portal, with the
//    before and after photos and the add-ons that were billed.
//
// The database half of the first is in
// tests/integration/a-groomer-says-which-add-ons-were-done.db.test.ts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { groomAddonsMarkable, groomAddonsOnVisit } from "@/lib/groom-visit-extras";
import { groomAddonsBilled, groomReport, splitGroomPhotos } from "@/lib/groom-report";
import { TECH_SCREENS } from "./support/tech-screens";

const TEETH = "11111111-1111-4111-8111-111111111111";
const DESHED = "22222222-2222-4222-8222-222222222222";

describe("the add-ons on a groom", () => {
  it("lists the plan's add-ons, done unless the groomer marked them not done", () => {
    expect(
      groomAddonsOnVisit(
        [
          { addon_service_id: TEETH, quantity: 1, name: "Teeth brushing", unit_price_cents: 1500 },
          { addon_service_id: DESHED, quantity: 2, name: "De-shed" },
        ],
        [DESHED],
      ),
    ).toEqual([
      { addonServiceId: TEETH, name: "Teeth brushing", quantity: 1, done: true },
      { addonServiceId: DESHED, name: "De-shed", quantity: 2, done: false },
    ]);
  });

  it("leaves out what is not a well-formed entry, and shows a repeat once", () => {
    expect(groomAddonsOnVisit(null, [])).toEqual([]);
    expect(groomAddonsOnVisit({ addon_service_id: TEETH }, [])).toEqual([]);
    expect(
      groomAddonsOnVisit(
        [
          null,
          "teeth",
          { addon_service_id: "not-a-uuid", name: "Bad" },
          { addon_service_id: TEETH, quantity: 0, name: "Zero" },
          { addon_service_id: DESHED },
          { addon_service_id: DESHED, name: "Again" },
        ],
        null,
      ),
    ).toEqual([{ addonServiceId: DESHED, name: "", quantity: 1, done: true }]);
  });

  it("can be marked only while the groom is still to finish, as the database says", () => {
    expect(groomAddonsMarkable("scheduled")).toBe(true);
    expect(groomAddonsMarkable("in_progress")).toBe(true);
    for (const s of ["completed", "skipped", "missed", "canceled", null, undefined]) {
      expect(groomAddonsMarkable(s)).toBe(false);
    }
  });

  it("the completion trigger skips an add-on marked not done, and nothing else changed", () => {
    const sql = readFileSync(
      "supabase/migrations/20261109130000_a-groomer-says-which-add-ons-were-done.sql",
      "utf8",
    );
    const original = readFileSync(
      "supabase/migrations/20261024100300_grooming-repeat-stamp-start-time.sql",
      "utf8",
    );
    const body = (text: string) => {
      const start = text.indexOf("CREATE OR REPLACE FUNCTION public.tg_visits_groom_plan_addons()");
      const end = text.indexOf("$function$;", start);
      return text.slice(start, end);
    };
    const restated = body(sql);
    expect(restated).toContain(
      "CONTINUE WHEN _svc.id = ANY(COALESCE(NEW.groom_addons_not_done, '{}'::uuid[]));",
    );
    // The rest of the body is the original, line for line.
    const withoutNewLines = restated
      .split("\n")
      .filter((l) => !/groom_addons_not_done|marked it not done/.test(l))
      .join("\n");
    expect(withoutNewLines).toBe(body(original));
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.tg_visits_groom_plan_addons\(\) FROM PUBLIC, anon, authenticated;/,
    );
    // The RPC: the visit's groomer or the office, an add-on on this groom, a
    // groom not yet finished.
    expect(sql).toContain("public.is_visit_tech(auth.uid(), _visit_id)");
    expect(sql).toContain("public.can_write_org(auth.uid(), _v.organization_id)");
    expect(sql).toContain("_v.status NOT IN ('scheduled', 'in_progress')");
    expect(sql).toContain("That add-on is not on this groom.");
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.set_groom_addon_done\(uuid, uuid, boolean\) FROM PUBLIC, anon;/,
    );
  });

  it("the groom card's add-ons and hookups speak the tech's language", () => {
    expect(TECH_SCREENS.map((s) => s.file)).toContain("src/components/my-day/GroomVisitExtras.tsx");
    const panel = readFileSync("src/components/my-day/GroomPetPanel.tsx", "utf8");
    expect(panel).toContain("<GroomVisitExtras visitId={visitId} canWrite={canWrite} />");
  });
});

describe("the van's hookups", () => {
  it("are two flags on the address that default to nothing claimed", () => {
    const sql = readFileSync(
      "supabase/migrations/20261109130100_the-van-knows-if-it-needs-power-or-water.sql",
      "utf8",
    );
    expect(sql).toContain("van_power_available boolean NOT NULL DEFAULT false");
    expect(sql).toContain("van_water_available boolean NOT NULL DEFAULT false");
  });

  it("a business that does not groom never sends them, so its saves cannot clear them", () => {
    const drawer = readFileSync("src/components/client-detail/PropertyDrawer.tsx", "utf8");
    expect(drawer).toContain('serviceLines.includes("mobile_grooming")');
    expect(drawer).toMatch(/groomHookups\s*\?\s*\{ vanPowerAvailable: form\.vanPower/);
    const fns = readFileSync("src/lib/properties.functions.ts", "utf8");
    expect(fns).toContain("data.vanPowerAvailable !== undefined");
    expect(fns).toContain("data.vanWaterAvailable !== undefined");
  });

  it("the field client view shows them only to a groomer", () => {
    const view = readFileSync("src/components/client-detail/FieldClientView.tsx", "utf8");
    expect(view).toContain("grooming && (p.van_power_available || p.van_water_available)");
  });
});

describe("a groom report in the portal", () => {
  it("splits before from after, and leaves issue and gate photos out", () => {
    expect(
      splitGroomPhotos([
        { url: "b1", kind: "before" },
        { url: "a1", kind: "completion" },
        { url: "i1", kind: "issue" },
        { url: "g1", kind: "gate" },
        { url: "a2", kind: "completion" },
      ]),
    ).toEqual({ before: ["b1"], after: ["a1", "a2"] });
  });

  it("lists the add-ons billed, without a voided one, adding up repeats", () => {
    expect(
      groomAddonsBilled([
        { description: "Teeth brushing", quantity: 1, status: "pending" },
        { description: "De-shed", quantity: 1, status: "voided" },
        { description: "Flea bath", quantity: 1, status: "invoiced" },
        { description: "Flea bath", quantity: 1, status: "paid_from_credit" },
        { description: "  ", quantity: 1, status: "pending" },
      ]),
    ).toEqual(["Teeth brushing", "Flea bath x2"]);
  });

  it("names the groomer by first name and drops empty text", () => {
    expect(
      groomReport({
        visitId: "v",
        day: "2026-11-02",
        serviceName: "Full groom",
        groomerName: "Rosa Delgado",
        summary: "Full groom for Biscuit (L) + Teeth brushing",
        reportNote: "  ",
        charges: [{ description: "Teeth brushing", quantity: 1, status: "pending" }],
        photos: [
          { url: "b", kind: "before" },
          { url: "a", kind: "completion" },
        ],
      }),
    ).toEqual({
      visitId: "v",
      day: "2026-11-02",
      serviceName: "Full groom",
      groomerFirstName: "Rosa",
      summary: "Full groom for Biscuit (L) + Teeth brushing",
      addonsDone: ["Teeth brushing"],
      reportNote: null,
      before: ["b"],
      after: ["a"],
    });
  });

  it("reads no office note and no way into the home", () => {
    const src = readFileSync("src/lib/portal-groom-reports.functions.ts", "utf8");
    const selects = [...src.matchAll(/\.select\(\s*"([^"]+)"/g)].map((m) => m[1]).join(",");
    expect(selects).not.toMatch(/tech_note|gate_code|lock_box_code|key_tag|access_notes|\*/);
    // Every read is the session's own organization; the client-owned ones
    // are the session's own client.
    expect(
      src.match(/\.eq\("organization_id", session\.organizationId\)/g)?.length,
    ).toBe(4);
    expect(src.match(/\.eq\("client_id", session\.clientId\)/g)?.length).toBe(3);
    expect(src).toContain("requirePortalSession(data.token, { readOnly: true })");
  });

  it("is drawn on the portal's grooming page", () => {
    const page = readFileSync("src/routes/portal.$slug.$token.grooming.tsx", "utf8");
    expect(page).toContain("<GroomReportsSection />");
  });
});
