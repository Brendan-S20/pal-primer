// Five walks a week (the service catalog, phase 3): the app half.
// The database half is tests/five-walks-a-week-in-a-real-database.test.ts.
//
//   * the weekday-set rule, in TypeScript, is the rule the CHECK holds;
//   * how a plan card reads its days ("Mon–Fri", "Mon, Wed, Fri"), in the
//     formatters' locale;
//   * the picker: seven chips, Monday first, a thumb's size on touch, wrapping;
//   * when the plan form offers set days, and how the choice is stored;
//   * that the form, the server functions and the reads carry `weekdays`.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  WEEK_ORDER,
  WORK_WEEK,
  formatWeekdaySet,
  isWeekdaySet,
  normalizeWeekdays,
  offersSetDays,
  toggleWeekday,
  weekdayName,
} from "@/lib/weekday-set";
import {
  blankSubscriptionFormValues,
  formatFrequency,
  scheduleChoiceFromRecord,
  scheduleChoiceToFields,
  subscriptionToFormValues,
} from "@/lib/subscription-form";
import { WeekdayPicker } from "@/components/client-detail/WeekdayPicker";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const MIGRATION = "supabase/migrations/20261010010000_five-walks-a-week.sql";

describe("a weekday set", () => {
  it("is one to seven distinct days, 0 (Sunday) to 6", () => {
    expect(isWeekdaySet([1, 2, 3, 4, 5])).toBe(true);
    expect(isWeekdaySet([0, 1, 2, 3, 4, 5, 6])).toBe(true);
    expect(isWeekdaySet([])).toBe(false);
    expect(isWeekdaySet([1, 1])).toBe(false);
    expect(isWeekdaySet([7])).toBe(false);
    expect(isWeekdaySet([-1])).toBe(false);
    expect(isWeekdaySet([1.5])).toBe(false);
    expect(isWeekdaySet(null)).toBe(false);
    expect(isWeekdaySet([0, 1, 2, 3, 4, 5, 6, 0])).toBe(false);
  });

  it("is the rule the database's CHECK holds, not a second one", () => {
    const sql = read(MIGRATION);
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.is_weekday_set"));
    expect(fn).toMatch(/cardinality\(_days\) BETWEEN 1 AND 7/);
    expect(fn).toMatch(/_days <@ ARRAY\[0, 1, 2, 3, 4, 5, 6\]::smallint\[\]/);
    expect(fn).toMatch(/count\(DISTINCT d\)/);
    expect(sql).toMatch(/CHECK \(weekdays IS NULL OR public\.is_weekday_set\(weekdays\)\)/);
    expect(sql).toMatch(
      /CHECK \(weekdays IS NULL OR \(frequency = 'weekly' AND COALESCE\(interval_weeks, 1\) = 1\)\)/,
    );
  });

  it("is stored once each, ascending, and toggles", () => {
    expect(normalizeWeekdays([5, 1, 3, 1, 9])).toEqual([1, 3, 5]);
    expect(toggleWeekday([1, 2, 3], 2)).toEqual([1, 3]);
    expect(toggleWeekday([5, 1], 0)).toEqual([0, 1, 5]);
    expect(WORK_WEEK).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts from Sunday = 0, as preferred_weekdays and work_days do", () => {
    expect(weekdayName(0, "en-US")).toBe("Sun");
    expect(weekdayName(1, "en-US")).toBe("Mon");
    expect(weekdayName(6, "en-US", "long")).toBe("Saturday");
    expect(WEEK_ORDER[0]).toBe(1);
    expect(WEEK_ORDER[6]).toBe(0);
  });
});

describe("how a plan card reads its days", () => {
  it("says Mon–Fri, and Mon, Wed, Fri", () => {
    expect(formatWeekdaySet([1, 2, 3, 4, 5], "en-US")).toBe("Mon–Fri");
    expect(formatWeekdaySet([1, 3, 5], "en-US")).toBe("Mon, Wed, Fri");
    expect(formatWeekdaySet([5, 3, 1], "en-US")).toBe("Mon, Wed, Fri");
  });

  it("ranges three days in a row or more, Monday first, and lists the rest", () => {
    expect(formatWeekdaySet([6, 0], "en-US")).toBe("Sat, Sun");
    expect(formatWeekdaySet([1, 2], "en-US")).toBe("Mon, Tue");
    expect(formatWeekdaySet([0, 1, 5, 6], "en-US")).toBe("Mon, Fri–Sun");
    expect(formatWeekdaySet([0, 1, 2, 3, 4, 5, 6], "en-US")).toBe("Mon–Sun");
    expect(formatWeekdaySet([], "en-US")).toBe("");
  });

  it("uses the formatters' locale, so Spanish, Arabic and Chinese read in their own words", () => {
    const es = formatWeekdaySet([1, 2, 3, 4, 5], "es-US");
    expect(es).toBe(`${weekdayName(1, "es-US")}–${weekdayName(5, "es-US")}`);
    expect(es).not.toMatch(/Mon|Fri/);
    for (const locale of ["ar-u-nu-latn", "zh-Hans-CN-u-hc-h12"]) {
      const s = formatWeekdaySet([1, 3, 5], locale);
      expect(s.length).toBeGreaterThan(0);
      expect(s).not.toMatch(/[A-Za-z]/);
    }
  });

  it("is what formatFrequency says for a set-days plan, and nothing else changes", () => {
    expect(formatFrequency({ frequency: "weekly", weekdays: [1, 2, 3, 4, 5] }, "en-US")).toBe(
      "Mon–Fri",
    );
    expect(formatFrequency({ frequency: "weekly", weekdays: null })).toBe("Weekly");
    expect(formatFrequency({ frequency: "weekly", interval_weeks: 3 })).toBe("Every 3 weeks");
    expect(formatFrequency({ frequency: "twice_weekly" })).toBe("Twice weekly");
  });
});

describe("the picker", () => {
  const html = renderToStaticMarkup(
    <WeekdayPicker label="Days each week" value={[1, 3, 5]} onChange={() => {}} locale="en-US" />,
  );
  const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)];

  it("is seven toggle chips, Monday first, with the chosen days pressed", () => {
    expect(buttons.map((b) => b[1])).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    const pressed = buttons.filter((b) => /aria-pressed="true"/.test(b[0])).map((b) => b[1]);
    expect(pressed).toEqual(["Mon", "Wed", "Fri"]);
    expect(html).toMatch(/role="group"/);
    expect(html).toMatch(/aria-label="Wednesday"/);
  });

  it("is a thumb's size on a touch screen, keeps its width, and wraps at 360px", () => {
    for (const [tag] of buttons) {
      expect(tag).toMatch(/touch:h-11/);
      expect(tag).toMatch(/touch:min-w-11/);
      expect(tag).toMatch(/shrink-0/);
      expect(tag).not.toMatch(/max-md:/);
    }
    expect(html).toMatch(/class="mt-2 flex flex-wrap gap-2"/);
  });

  it("names its days in the locale it is given", () => {
    const es = renderToStaticMarkup(
      <WeekdayPicker label="Días" value={[]} onChange={() => {}} locale="es-US" />,
    );
    expect(es).toContain(`>${weekdayName(1, "es-US")}<`);
    expect(es).not.toContain(">Mon<");
  });
});

describe("the plan form", () => {
  it("offers set days for a walk, a sit or a groom, and for pet waste only once turned on", () => {
    for (const line of ["dog_walking", "pet_sitting", "mobile_grooming", "other"]) {
      expect(offersSetDays({ serviceLine: line, alreadySetDays: false, turnedOn: false })).toBe(
        true,
      );
    }
    expect(
      offersSetDays({ serviceLine: "pet_waste", alreadySetDays: false, turnedOn: false }),
    ).toBe(false);
    expect(offersSetDays({ serviceLine: "pet_waste", alreadySetDays: false, turnedOn: true })).toBe(
      true,
    );
    // Editing a plan that already runs on set days never loses its schedule.
    expect(offersSetDays({ serviceLine: "pet_waste", alreadySetDays: true, turnedOn: false })).toBe(
      true,
    );
    expect(offersSetDays({ serviceLine: null, alreadySetDays: false, turnedOn: false })).toBe(
      false,
    );
  });

  it("stores set days as weekly with the days beside it, and reads them back", () => {
    expect(scheduleChoiceToFields("set_days", {})).toEqual({ frequency: "weekly" });
    expect(scheduleChoiceFromRecord({ frequency: "weekly", weekdays: [1, 3, 5] })).toBe("set_days");
    expect(scheduleChoiceFromRecord({ frequency: "weekly", weekdays: null })).toBe("weekly");
    expect(scheduleChoiceFromRecord({ frequency: "weekly", weekdays: [] })).toBe("weekly");
    const rec = {
      id: "s",
      frequency: "weekly",
      price_cents: 2500,
      dog_count: 1,
      unit_count: null,
      zone_id: null,
      property_id: "p",
      billing_cadence: "postpaid",
      preferred_weekdays: null,
      weekdays: [1, 2, 3, 4, 5],
    };
    expect(subscriptionToFormValues(rec, "2026-10-09").weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(blankSubscriptionFormValues({ properties: [], today: "2026-10-09" }).weekdays).toEqual(
      [],
    );
  });

  it("shows the picker for set days and saves the days, per visit", () => {
    const tab = read("src/components/client-detail/ServicesTab.tsx");
    expect(tab).toMatch(/\{ value: "set_days", label: "Set days each week"/);
    expect(tab).toMatch(/form\.choice === "set_days" && \(\s*<div>\s*<WeekdayPicker/);
    expect(tab).toMatch(
      /weekdays: form\.choice === "set_days" \? normalizeWeekdays\(form\.weekdays\) : null/,
    );
    expect(tab).toMatch(/offersSetDays\(/);
    expect(tab).toMatch(/formatFrequency\(s, locale\)/);
    // A blank price takes the service's per-visit price.
    expect(tab).toMatch(/servicePriceCents\(next, \{ pets: dogsForPricing \}\)/);
    expect(tab).toMatch(/Price \(\$ per visit\)/);
  });
});

describe("the wiring", () => {
  it("the server functions accept, check and write the days", () => {
    const fns = read("src/lib/subscriptions.functions.ts");
    expect(fns.match(/weekdays: weekdaysSchema,/g)?.length).toBe(2);
    expect(fns.match(/\.refine\(weekdaysFitFrequency/g)?.length).toBe(2);
    expect(fns).toMatch(/\.\.\.weekdaysFor\(data\),/);
    expect(fns).toMatch(/\.\.\.weekdaysPatch,/);
    // A frequency change off weekly clears the set the CHECK would refuse.
    expect(fns).toMatch(/interval_days: null,\s*\/\/[^\n]*\n[^\n]*\n\s*weekdays: null,/);
    // The plan list reads it, and so does the calendar.
    expect(fns).toMatch(/preferred_weekdays, weekdays, interval_weeks/);
    expect(read("src/lib/visits.functions.ts")).toMatch(
      /subscriptions\(price_cents, account_type, frequency, weekdays,/,
    );
    expect(read("src/components/schedule/ScheduleCalendar.tsx")).toMatch(
      /formatWeekdaySet\(days, locale\)/,
    );
  });

  it("types.ts knows the column", () => {
    const types = read("src/integrations/supabase/types.ts");
    const subs = types.slice(types.indexOf("      subscriptions: {"));
    const block = subs.slice(0, subs.indexOf("Relationships"));
    expect(block).toMatch(/ {10}weekdays: number\[\] \| null/);
    expect(block.match(/ {10}weekdays\?: number\[\] \| null/g)?.length).toBe(2);
  });

  it("the generator is spliced, keeps one visit per plan per day, and copies nothing by hand", () => {
    const sql = read(MIGRATION);
    const code = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).toMatch(
      /pg_get_functiondef\('public\.generate_visits_core\(uuid, date, uuid\)'::regprocedure\)/,
    );
    expect(code).not.toMatch(/CREATE OR REPLACE FUNCTION public\.generate_visits_core/);
    expect(code).toMatch(/ON CONFLICT \(subscription_id, scheduled_on\) DO NOTHING;/);
    // The service is P2's trigger's job (visits_service), not an INSERT column.
    expect(code).not.toMatch(/INSERT INTO public\.visits\s*\([^)]*service_id/);
    // The business's today, not the server's.
    expect(code).toMatch(/now\(\) AT TIME ZONE COALESCE\(o\.timezone, 'America\/Chicago'\)/);
  });
});
