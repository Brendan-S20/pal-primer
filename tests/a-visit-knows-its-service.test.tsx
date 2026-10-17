// A visit knows its service (the service catalog, phase 2): the app half.
// The database half is tests/a-visit-knows-its-service-in-a-real-database.test.ts.
//
//   * how long a stop takes: the service's minutes, else the yard's, else 8 --
//     and the TypeScript and SQL copies of that rule agree;
//   * which services a plan's picker lists, and which it starts on;
//   * how a tech's card names a stop's service, in every locale;
//   * that the reads and the write path carry service_id.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));
vi.mock("@/lib/services.functions", () => ({ listServices: vi.fn() }));

import {
  DEFAULT_STOP_MINUTES,
  defaultServiceId,
  planTitle,
  servicePickerOptions,
  servicesVary,
  visitServiceLabel,
  visitServiceMinutes,
} from "@/lib/visit-service";
import { ServicePicker, effectiveServiceId } from "@/components/client-detail/ServicePicker";
import { SERVICE_LINES } from "@/lib/service-lines";
import type { Service } from "@/lib/services";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import ar from "@/lib/i18n/locales/ar";
import zh from "@/lib/i18n/locales/zh";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function svc(over: Partial<Service> & Pick<Service, "id" | "name">): Service {
  return {
    organization_id: "org",
    service_line: "pet_waste",
    price_unit: "visit",
    base_price_cents: null,
    extra_pet_cents: 0,
    default_duration_min: null,
    active: true,
    created_at: "2026-10-09T00:00:00Z",
    updated_at: "2026-10-09T00:00:00Z",
    ...over,
  };
}

const PET_WASTE = svc({ id: "pw", name: "Pet waste removal" });
const WALK_30 = svc({
  id: "w30",
  name: "30-minute walk",
  service_line: "dog_walking",
  default_duration_min: 30,
});
const WALK_60 = svc({
  id: "w60",
  name: "60-minute walk",
  service_line: "dog_walking",
  default_duration_min: 60,
});
const GROOM_OLD = svc({
  id: "g",
  name: "Full groom",
  service_line: "mobile_grooming",
  active: false,
});
const SIT = svc({
  id: "s",
  name: "Overnight stay",
  service_line: "pet_sitting",
  price_unit: "night",
});

describe("how long a stop takes", () => {
  // The same table the SQL check block asserts of stop_service_min.
  const TABLE: [number | null, number | null, number][] = [
    [45, 12, 45], // a walk: the service decides
    [null, 12, 12], // a cleanup: pet waste leaves the duration to the yard
    [null, null, DEFAULT_STOP_MINUTES], // nothing known
    [60, null, 60],
  ];

  it.each(TABLE)("service %s, yard %s → %s minutes", (service, yard, want) => {
    expect(visitServiceMinutes(service, yard)).toBe(want);
  });

  it("reads a numeric PostgREST sent as a string, and treats junk as unset", () => {
    expect(visitServiceMinutes("45", 12)).toBe(45);
    expect(visitServiceMinutes(undefined, "12")).toBe(12);
    expect(visitServiceMinutes("", "abc")).toBe(DEFAULT_STOP_MINUTES);
  });

  it("prefers the visit's own length, and ignores 0 the way the SQL function does", () => {
    expect(visitServiceMinutes(60, 12, 90)).toBe(90);
    expect(visitServiceMinutes(60, 12, "90")).toBe(90);
    expect(visitServiceMinutes(60, 12, 0)).toBe(60);
    expect(visitServiceMinutes(null, null, null)).toBe(DEFAULT_STOP_MINUTES);
  });

  it("is the rule the planner's SQL uses, word for word", () => {
    // Code only: the header quotes the old expression to say what it replaced.
    const sql = read("supabase/migrations/20261009230100_a-walk-takes-as-long-as-the-walk.sql")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql).toMatch(/SELECT COALESCE\(_service_min, _property_min, 8\);/);
    expect(DEFAULT_STOP_MINUTES).toBe(8);
    // Every duration route_day_inputs and apply_route_plan read goes through it.
    expect(sql).not.toMatch(/COALESCE\(p\.service_duration_min, 8\)/);
    expect(
      sql.match(/public\.stop_service_min\(sv\.default_duration_min, p\.service_duration_min\)/g),
    ).toHaveLength(
      // four in the bodies, one in the check block
      5,
    );
  });

  it("is what the day-fit check after auto-routing counts", () => {
    const src = read("src/lib/auto-routing.server.ts");
    expect(src).toMatch(/duration_min, properties\(latitude/);
    expect(src).toMatch(/services\(default_duration_min\)/);
    expect(src).toMatch(
      /serviceMin: visitServiceMinutes\(\s*v\.services\?\.default_duration_min,\s*v\.properties\?\.service_duration_min,\s*v\.duration_min,\s*\)/,
    );
  });
});

describe("the plan's Service picker", () => {
  const all = [WALK_60, GROOM_OLD, SIT, PET_WASTE, WALK_30];

  it("lists the active services by line, then name", () => {
    expect(servicePickerOptions(all).map((s) => s.id)).toEqual(["pw", "w30", "w60", "s"]);
  });

  it("keeps a plan's own service when it has since been deactivated", () => {
    expect(servicePickerOptions(all, "g").map((s) => s.id)).toEqual(["pw", "w30", "w60", "s", "g"]);
  });

  it("starts a new plan on pet waste removal", () => {
    expect(defaultServiceId(all)).toBe("pw");
  });

  it("finds pet waste a business renamed, then falls back to the first active service", () => {
    const renamed = svc({ id: "scoop", name: "Scooping" });
    expect(defaultServiceId([WALK_30, renamed])).toBe("scoop");
    expect(defaultServiceId([WALK_60, WALK_30, SIT])).toBe("w30");
    expect(
      defaultServiceId([svc({ id: "x", name: "Pet waste removal", active: false }), WALK_30]),
    ).toBe("w30");
    expect(defaultServiceId([])).toBeNull();
  });

  it("sends what it shows: the choice, else the default", () => {
    expect(effectiveServiceId("", all)).toBe("pw");
    expect(effectiveServiceId("w60", all)).toBe("w60");
    expect(effectiveServiceId("", [])).toBeNull();
  });

  it("renders the options with pet waste selected, at a thumb's height", () => {
    const html = renderToStaticMarkup(
      <ServicePicker
        value=""
        currentId={null}
        services={all}
        isLoading={false}
        onChange={() => {}}
      />,
    );
    expect(html).toMatch(/<label[^>]*for="sd-service"[^>]*>Service<\/label>/);
    expect(html).toMatch(/<option value="pw" selected="">Pet waste removal<\/option>/);
    expect(html).toContain("30-minute walk");
    expect(html).not.toContain("Full groom");
    expect(html).toMatch(/class="[^"]*\btouch:h-11\b/);
  });

  it("marks a deactivated current service rather than hiding it", () => {
    const html = renderToStaticMarkup(
      <ServicePicker
        value="g"
        currentId="g"
        services={all}
        isLoading={false}
        onChange={() => {}}
      />,
    );
    expect(html).toMatch(
      /<option value="g" selected="">Full groom \(no longer offered\)<\/option>/,
    );
  });

  it("is on the plan form and saves through the server functions", () => {
    const tab = read("src/components/client-detail/ServicesTab.tsx");
    expect(tab).toMatch(/<ServicePicker/);
    expect(tab).toMatch(
      /serviceId: effectiveServiceId\(form\.serviceId, orgServices\) \?\? undefined/,
    );
    const fns = read("src/lib/subscriptions.functions.ts");
    expect(fns.match(/serviceId: z\.string\(\)\.uuid\(\)\.optional\(\)/g)).toHaveLength(2);
    expect(
      fns.match(/\.\.\.\(data\.serviceId \? \{ service_id: data\.serviceId \} : \{\}\)/g),
    ).toHaveLength(2);
    expect(fns).toMatch(/service_id, services\(name, service_line(, default_duration_min)?\)/);
  });
});

describe("how a card names the service", () => {
  it("translates the line and keeps the business's own name", () => {
    expect(visitServiceLabel({ name: "30-minute walk", service_line: "dog_walking" })).toEqual({
      line: "dog_walking",
      ownName: "30-minute walk",
    });
  });

  it("does not repeat the seeded pet-waste name, in any case", () => {
    expect(visitServiceLabel({ name: "PET WASTE REMOVAL", service_line: "pet_waste" })).toEqual({
      line: "pet_waste",
      ownName: null,
    });
  });

  it("reads an unknown line as other, and no service as nothing", () => {
    expect(visitServiceLabel({ name: "Hamster care", service_line: "hamsters" })?.line).toBe(
      "other",
    );
    expect(visitServiceLabel(null)).toBeNull();
    expect(visitServiceLabel(undefined)).toBeNull();
  });

  it("titles a plan card by its service", () => {
    expect(planTitle("weekly", null)).toBe("Recurring pet waste removal");
    expect(planTitle("one_time", { name: "Pet waste removal", service_line: "pet_waste" })).toBe(
      "One-time pet waste removal",
    );
    expect(planTitle("weekly", { name: "30-minute walk", service_line: "dog_walking" })).toBe(
      "Recurring · 30-minute walk",
    );
  });

  it("puts the name on a calendar chip only when the day is not all one service", () => {
    expect(servicesVary([{ service_id: "pw" }, { service_id: "pw" }, { service_id: null }])).toBe(
      false,
    );
    expect(servicesVary([{ service_id: "pw" }, { service_id: "w30" }])).toBe(true);
  });

  it("has every line in all four languages", () => {
    for (const [lng, dict] of Object.entries({ en, es, ar, zh })) {
      for (const line of SERVICE_LINES) {
        const v = (dict as unknown as { serviceLine: Record<string, string> }).serviceLine[line];
        expect(v, `${lng} serviceLine.${line}`).toBeTruthy();
        if (lng !== "en")
          expect(v, `${lng} serviceLine.${line} is still English`).not.toBe(en.serviceLine[line]);
      }
    }
  });

  it("shows it on My Day's card in a <bdi>, by literal key", () => {
    const src = read("src/routes/_authenticated/my-day.tsx");
    for (const line of SERVICE_LINES) expect(src).toContain(`t("serviceLine.${line}")`);
    expect(src).toMatch(/<bdi>\{service\.ownName\}<\/bdi>/);
    expect(read("src/lib/my-day.functions.ts")).toMatch(
      /services\(name, service_line(, default_duration_min)?\)/,
    );
  });

  it("shows it on the visit drawer and both schedule cards", () => {
    expect(read("src/components/VisitDetailDrawer.tsx")).toMatch(
      /<bdi[^>]*>\{v\.services\.name\}<\/bdi>/,
    );
    expect(read("src/components/schedule/MobileDayList.tsx")).toMatch(/\{v\.services\.name\}/);
    expect(read("src/routes/_authenticated/routes.tsx")).toMatch(/\{visit\.services\.name\}/);
    const fn = read("src/lib/visits.functions.ts");
    expect(
      fn.match(/service_id, services\(name, service_line, default_duration_min\)/g),
    ).toHaveLength(2);
  });
});
