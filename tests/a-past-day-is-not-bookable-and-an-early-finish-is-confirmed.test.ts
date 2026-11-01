// #654, F-23: a one-off visit or a groom could be booked on a day that was
// already over (only the stay calendar refused one), and a visit on a later
// day could be completed by a single tap, from the office or on the phone.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FUTURE_COMPLETE_REFUSAL,
  PAST_DAY_REFUSAL,
  isFutureVisit,
  notBeforeToday,
  pastDayRefusal,
  shiftDay,
} from "@/lib/booking-dates";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
/** The body of an exported server function, up to the next export. */
const serverFn = (file: string, name: string) => {
  const src = read(file);
  const at = src.indexOf(`export const ${name} =`);
  expect(at, `${name} in ${file}`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", at + 1);
  return src.slice(at, next === -1 ? undefined : next);
};

const TODAY = "2026-11-01";

describe("the rules", () => {
  it("refuses yesterday and accepts today and later", () => {
    expect(pastDayRefusal("2026-10-31", TODAY)).toBe(PAST_DAY_REFUSAL);
    expect(pastDayRefusal(TODAY, TODAY)).toBeNull();
    expect(pastDayRefusal("2026-11-02", TODAY)).toBeNull();
  });

  it("calls a visit future only after today", () => {
    expect(isFutureVisit("2026-11-02", TODAY)).toBe(true);
    expect(isFutureVisit(TODAY, TODAY)).toBe(false);
    expect(isFutureVisit("2026-10-30", TODAY)).toBe(false);
    expect(isFutureVisit(null, TODAY)).toBe(false);
  });

  it("moves days on the calendar, not the clock", () => {
    expect(shiftDay("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDay("2026-11-01", 60)).toBe("2026-12-31");
    expect(notBeforeToday("2026-10-01", TODAY)).toBe(TODAY);
    expect(notBeforeToday("2026-12-01", TODAY)).toBe("2026-12-01");
    expect(notBeforeToday(undefined, TODAY)).toBe(TODAY);
  });
});

describe("every booking and move refuses a past day on the server", () => {
  const paths: Array<[string, string, string]> = [
    ["src/lib/visits.functions.ts", "createOneOffVisit", "data.scheduledOn"],
    ["src/lib/groom-booking.functions.ts", "bookGroom", "data.scheduledOn"],
    ["src/lib/visits.functions.ts", "rescheduleVisitFromOffice", "data.newDate"],
    ["src/lib/visits.functions.ts", "bulkRescheduleVisits", "data.toDate"],
    ["src/lib/weather.functions.ts", "rescheduleVisits", "data.newDate"],
  ];
  for (const [file, name, field] of paths) {
    it(name, () => {
      const body = serverFn(file, name);
      const refuse = body.indexOf("refusePastDay(");
      expect(refuse, `${name} calls refusePastDay`).toBeGreaterThan(-1);
      expect(body.slice(refuse, refuse + 200)).toContain(field);
      // Before anything is written.
      for (const write of [".rpc(", "bookOneOffVisit(", "bookGroomAppointment("]) {
        const w = body.indexOf(write);
        if (w > -1) expect(refuse, `${name}: refusal before ${write}`).toBeLessThan(w);
      }
    });
  }

  it("on the business's calendar", () => {
    const src = read("src/lib/booking-dates.server.ts");
    expect(src).toMatch(/select\("timezone"\)/);
    expect(src).toMatch(/orgToday\(/);
  });
});

describe("the pickers start at today", () => {
  it("client Visits tab reschedule", () => {
    expect(read("src/components/client-detail/VisitsTab.tsx")).toMatch(
      /id="va-date"[\s\S]{0,200}min=\{orgToday\(tz\)\}/,
    );
  });
  it("weather move", () => {
    expect(read("src/components/WeatherStrip.tsx")).toContain("min={notBeforeToday(day, today)}");
  });
  it("groom prefill", () => {
    expect(read("src/components/BookGroomDialog.tsx")).toContain(
      "setScheduledOn(notBeforeToday(prefill?.scheduledOn, today))",
    );
  });
  it("portal reschedule uses the business's tomorrow, not the device's UTC day", () => {
    const src = read("src/lib/portal-ui.tsx");
    expect(src).not.toMatch(/new Date\(Date\.now\(\) \+ (?:60 \* )?86400000\)\.toISOString\(\)/);
    expect(src).toContain("shiftDay(orgDay, 1)");
  });
});

describe("completing a visit on a later day takes a confirm", () => {
  it("the office server function refuses it without one", () => {
    const body = serverFn("src/lib/visits.functions.ts", "completeVisitFromOffice");
    expect(body).toContain("confirmedEarly: z.boolean().optional()");
    expect(body).toMatch(
      /if \(!data\.confirmedEarly\)[\s\S]{0,400}isFutureVisit\([\s\S]{0,200}FUTURE_COMPLETE_REFUSAL/,
    );
    expect(body.indexOf("FUTURE_COMPLETE_REFUSAL")).toBeLessThan(
      body.indexOf('rpc("office_complete_visit"'),
    );
    expect(FUTURE_COMPLETE_REFUSAL).toMatch(/later day/);
  });

  for (const f of [
    "src/components/VisitDetailDrawer.tsx",
    "src/routes/_authenticated/routes.tsx",
    "src/components/client-detail/VisitsTab.tsx",
  ]) {
    it(`office: ${f}`, () => {
      const src = read(f);
      expect(src).toMatch(/isFutureVisit\(/);
      expect(src).toMatch(/earlyCompleteConfirm\(/);
      expect(src).toMatch(/confirmedEarly/);
    });
  }

  it("tech: My Day asks in the tech's language", () => {
    const src = read("src/routes/_authenticated/my-day.tsx");
    expect(src).toMatch(
      /step === "complete" &&\s*isFutureVisit\(visit\.scheduled_on, orgToday\)[\s\S]{0,200}t\("visit\.earlyCompleteTitle"\)/,
    );
    for (const loc of ["en", "es", "ar", "zh"]) {
      const l = read(`src/lib/i18n/locales/${loc}.ts`);
      expect(l, loc).toMatch(/earlyCompleteTitle:/);
      expect(l, loc).toMatch(/earlyCompleteBody:[\s\S]{0,200}\{\{day\}\}/);
      expect(l, loc).toMatch(/earlyCompleteConfirm:/);
    }
  });
});
