// A walk comes in the front door: the service catalog, phase 5, on the
// office's own paths. Pricing by service landed on the plan form
// (a-walk-is-priced-as-a-walk); this is the rest of the ways a plan gets
// made, and the portal reading it back:
//
//   * the CSV import maps a row's service to one of the business's services,
//     creating it on first sight, and a walker's "Mon/Wed/Fri" becomes the
//     plan's weekday set (src/lib/import-services.ts, imports.functions.ts);
//   * the new-client wizard picks a service when the business sells more
//     than one, prefills the price through the one rule, and asks for the
//     days of a weekly walk (clients.new.tsx, onboardClient);
//   * a lead's service, when it has one, comes through conversion;
//   * the portal shows a weekday plan as its days and a one-off request as the
//     service it asked for (migration 20261011160000, portal-ui).
//
// The owner's rule, which the first group pins hardest: a pet-waste business
// sees and writes EXACTLY what it did. Its import rows are held byte-identical
// to the shape the old inline insert built, with and without a Service column.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  durationFromName,
  importPlanRow,
  inferServiceLine,
  mapServiceRow,
  matchImportService,
  newServiceDraft,
  parseFrequency,
  parseWeekdays,
  type MappedService,
} from "@/lib/import-services";
import { autoMap, SERVICE_TARGET_FIELDS } from "@/lib/imports.functions";
import { EMPTY_PREFILL, leadToWizardPrefill, type ConvertibleLead } from "@/lib/lead-conversion";
import { cadenceLabel } from "@/lib/frequency-request";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION = "supabase/migrations/20261011160000_a-client-sees-the-walk-they-asked-for.sql";

// ── the import reads a walker's week ───────────────────────────────────────

describe("the ways a walker writes a week", () => {
  it.each([
    ["Mon/Wed/Fri", [1, 3, 5]],
    ["Mon, Wed & Fri", [1, 3, 5]],
    ["weekdays", [1, 2, 3, 4, 5]],
    ["Every weekday", [1, 2, 3, 4, 5]],
    ["M-F", [1, 2, 3, 4, 5]],
    ["Mon–Fri", [1, 2, 3, 4, 5]],
    ["Monday to Thursday", [1, 2, 3, 4]],
    ["Tue thru Thu", [2, 3, 4]],
    ["Fri-Mon", [0, 1, 5, 6]],
    ["MWF", [1, 3, 5]],
    ["M/W/F", [1, 3, 5]],
    ["TTh", [2, 4]],
    ["MTWThF", [1, 2, 3, 4, 5]],
    ["Sat, Sun", [0, 6]],
  ])("%s", (text, want) => {
    expect(parseWeekdays(text)).toEqual(want);
  });

  it("still reads what it always read, and nothing from a word that is not a day", () => {
    expect(parseWeekdays("Tue & Fri")).toEqual([2, 5]);
    expect(parseWeekdays("Weekly on Thursdays")).toEqual([4]);
    expect(parseWeekdays("Weekly")).toEqual([]);
    expect(parseWeekdays("Monthly")).toEqual([]);
    expect(parseWeekdays("Every 2 weeks")).toEqual([]);
    // "W" alone would be Wednesday, but "Weekly" is a word, not a code.
    expect(parseWeekdays("Weekly - Friday")).toEqual([5]);
    // A lone S says Saturday or Sunday and is not guessed.
    expect(parseWeekdays("MWS")).toEqual([]);
    // Three days spelled with dashes are a list, not a range.
    expect(parseWeekdays("Mon - Wed - Fri")).toEqual([1, 3, 5]);
  });

  it("a week written into the frequency column is a weekly plan", () => {
    expect(parseFrequency("M-F")).toEqual({ frequency: "weekly" });
    expect(parseFrequency("Weekdays")).toEqual({ frequency: "weekly" });
  });
});

describe("the service a row names", () => {
  const headers = [
    "Client J-ID",
    "Client name",
    "Service",
    "Visit frequency",
    "Visit total",
    "Day",
  ];
  const mapping = autoMap("jobber", headers, "services");

  it("is a target field, optional, auto-mapped from a Service column", () => {
    expect(SERVICE_TARGET_FIELDS).toContain("service");
    expect(mapping.service).toBe("Service");
    expect(autoMap("generic_csv", ["client", "service name", "price"], "services").service).toBe(
      "service name",
    );
    // The hint and the mapping screen's required list say the column is optional.
    expect(read("src/routes/_authenticated/imports.index.tsx")).toMatch(
      /services: \["price_per_visit"\]/,
    );
  });

  it("comes through trimmed, and is null when the file has none", () => {
    const row = {
      "Client J-ID": "81",
      "Client name": "Dana Fox",
      Service: "  30-minute walk ",
      "Visit frequency": "Weekly",
      "Visit total": "$25.00",
      Day: "Mon/Wed/Fri",
    };
    expect(mapServiceRow(row, mapping).mapped?.service_name).toBe("30-minute walk");
    expect(mapServiceRow({ ...row, Service: "" }, mapping).mapped?.service_name).toBeNull();
    const noColumn = autoMap(
      "jobber",
      headers.filter((h) => h !== "Service"),
      "services",
    );
    expect(mapServiceRow(row, noColumn).mapped?.service_name).toBeNull();
  });

  it("matches one of the business's services by name, case and spaces aside", () => {
    const services = [
      { id: "pw", name: "Pet waste removal", service_line: "pet_waste" },
      { id: "walk", name: "30-minute walk", service_line: "dog_walking" },
    ];
    expect(matchImportService("30-MINUTE WALK ", services)?.id).toBe("walk");
    expect(matchImportService(null, services)).toBeNull();
    expect(matchImportService("", services)).toBeNull();
    expect(matchImportService("Overnight stay", services)).toBeUndefined();
  });

  it("puts a new service on the line its words suggest, else the business's only line, else other", () => {
    expect(inferServiceLine("30-minute walk", ["pet_waste", "dog_walking"])).toBe("dog_walking");
    expect(inferServiceLine("Drop-in visit (20 min)", ["pet_sitting"])).toBe("pet_sitting");
    expect(inferServiceLine("Overnight stay", ["pet_waste", "pet_sitting"])).toBe("pet_sitting");
    expect(inferServiceLine("Full groom", ["mobile_grooming"])).toBe("mobile_grooming");
    expect(inferServiceLine("Nail trim", ["pet_waste", "mobile_grooming"])).toBe("mobile_grooming");
    expect(inferServiceLine("Private training lesson", ["training"])).toBe("training");
    expect(inferServiceLine("Weekly scoop", ["pet_waste", "dog_walking"])).toBe("pet_waste");
    expect(inferServiceLine("Yard cleanup", ["dog_walking"])).toBe("pet_waste");
    expect(inferServiceLine("Standard plan", ["dog_walking"])).toBe("dog_walking");
    expect(inferServiceLine("Standard plan", ["pet_waste", "dog_walking"])).toBe("other");
  });

  it("reads a length written into the name, and guesses none", () => {
    expect(durationFromName("30-minute walk")).toBe(30);
    expect(durationFromName("Drop-in (20 min)")).toBe(20);
    expect(durationFromName("1 hr walk")).toBe(60);
    expect(durationFromName("1.5 hour groom")).toBe(90);
    expect(durationFromName("Overnight stay")).toBeNull();
    expect(durationFromName("0 min")).toBeNull();
  });

  it("creates it with no price, the plan doc's rule, and a cleanup with no duration", () => {
    expect(newServiceDraft(" 30-minute walk ", ["dog_walking"])).toEqual({
      name: "30-minute walk",
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: 30,
      active: true,
    });
    expect(newServiceDraft("Weekly scoop", ["pet_waste"])).toMatchObject({
      service_line: "pet_waste",
      base_price_cents: null,
      default_duration_min: null,
    });
    // Cut to the table's bound, not refused: the plan is what is imported.
    expect(newServiceDraft("x".repeat(100), ["other"]).name).toHaveLength(80);
  });
});

// ── a pet-waste business's import writes the rows it always did ──────────────

/** The rows the existing fixtures put through mapServiceRow
 *  (an-import-brought-only-the-address-book.test.ts), as a scooper's export
 *  has them: no Service column anywhere. */
const JOBBER_HEADERS = [
  "Client J-ID",
  "Client name",
  "Visit frequency",
  "Visit total",
  "Day",
  "Start date",
];
const JOBBER = autoMap("jobber", JOBBER_HEADERS, "services");
const FIXTURE_ROWS: Array<Record<string, string>> = [
  {
    "Client J-ID": "81",
    "Client name": "Dana Fox",
    "Visit frequency": "Every 2 weeks",
    "Visit total": "$32.00",
    Day: "Tuesday",
    "Start date": "10/06/2026",
  },
  {
    "Client J-ID": "82",
    "Client name": "Lee Park",
    "Visit frequency": "Weekly",
    "Visit total": "25",
    Day: "Thursday",
  },
  {
    "Client J-ID": "83",
    "Client name": "Ana Ruiz",
    "Visit frequency": "Twice a week",
    "Visit total": "$18",
    Day: "Tue & Fri",
  },
  {
    "Client J-ID": "84",
    "Client name": "Sam Hill",
    "Visit frequency": "Every 10 days",
    "Visit total": "40",
  },
  {
    "Client J-ID": "85",
    "Client name": "HOA",
    "Visit frequency": "Monthly",
    "Visit total": "120",
    "Start date": "2026-11-01",
  },
];

/** The subscriptions row the import built until 2026-10-11, verbatim from
 *  imports.functions.ts as it shipped (key order included), plus the two
 *  keys #857 added at the end: every imported plan is PAUSED until the owner
 *  turns it on (the owner's rule, Nov 10 2026), so no visit is generated by
 *  the import. */
function theOldRow(
  m: MappedService,
  ctx: {
    orgId: string;
    clientId: string;
    propertyId: string;
    zoneId: string | null;
    isRes: boolean;
    dogCount: number | null;
    now: string;
  },
) {
  return {
    organization_id: ctx.orgId,
    client_id: ctx.clientId,
    property_id: ctx.propertyId,
    account_type: ctx.isRes ? "residential" : "commercial",
    frequency: m.frequency,
    interval_weeks: m.frequency === "weekly" ? m.interval_weeks : null,
    interval_days: m.frequency === "every_n_days" ? m.interval_days : null,
    price_cents: m.price_cents,
    dog_count: ctx.isRes ? ctx.dogCount : null,
    unit_count: ctx.isRes ? null : 1,
    zone_id: ctx.zoneId ?? null,
    billing_cadence: m.billing_cadence ?? "postpaid",
    preferred_weekdays: m.preferred_weekdays,
    price_overridden_at: ctx.now,
    ...(m.started_on ? { started_on: m.started_on } : {}),
    status: "paused",
    paused_at: ctx.now,
  };
}

const CTX = {
  orgId: "org-1",
  clientId: "client-1",
  propertyId: "prop-1",
  zoneId: "zone-1",
  isResidential: true,
  dogCount: 2,
  now: "2026-10-11T12:00:00.000Z",
};

describe("a pet-waste business's import writes the rows it always did", () => {
  it("maps every fixture row as before, with no service named", () => {
    for (const raw of FIXTURE_ROWS) {
      const { mapped, error } = mapServiceRow(raw, JOBBER);
      expect(error).toBeNull();
      expect(mapped!.service_name).toBeNull();
    }
    // The first fixture, as the older test pins it, plus the service field,
    // and since #857 the email link and whether the file said how often.
    expect(mapServiceRow(FIXTURE_ROWS[0], JOBBER).mapped).toEqual({
      client_external_id: "81",
      client_name: "Dana Fox",
      client_email: null,
      frequency: "biweekly",
      frequency_in_file: true,
      interval_weeks: null,
      interval_days: null,
      price_cents: 3200,
      preferred_weekdays: [2],
      started_on: "2026-10-06",
      dog_count: null,
      billing_cadence: null,
      billing_frequency: null,
      service_name: null,
    });
  });

  it("builds, byte for byte, the row the old inline insert built", () => {
    for (const raw of FIXTURE_ROWS) {
      const m = mapServiceRow(raw, JOBBER).mapped!;
      for (const isRes of [true, false]) {
        const want = theOldRow(m, { ...CTX, isRes, dogCount: isRes ? 2 : null });
        const got = importPlanRow(m, {
          ...CTX,
          isResidential: isRes,
          dogCount: isRes ? 2 : null,
          service: null,
        });
        expect(JSON.stringify(got)).toBe(JSON.stringify(want));
      }
    }
  });

  it("with a Service column naming its pet waste removal, the same row plus service_id", () => {
    const petWaste = { id: "svc-pw", name: "Pet waste removal", service_line: "pet_waste" };
    for (const raw of FIXTURE_ROWS) {
      const m = { ...mapServiceRow(raw, JOBBER).mapped!, service_name: "Pet waste removal" };
      const { status, paused_at, ...rest } = theOldRow(m, { ...CTX, isRes: true, dogCount: 2 });
      const want = { ...rest, service_id: "svc-pw", status, paused_at };
      const got = importPlanRow(m, { ...CTX, service: petWaste });
      expect(JSON.stringify(got)).toBe(JSON.stringify(want));
      // Never a weekday set for pet waste, days named or not.
      expect(got).not.toHaveProperty("weekdays");
    }
    // A scooper whose export says "Tue & Fri" keeps its preferred days.
    const m = {
      ...mapServiceRow(FIXTURE_ROWS[2], JOBBER).mapped!,
      service_name: "Pet waste removal",
    };
    expect(importPlanRow(m, { ...CTX, service: petWaste }).preferred_weekdays).toEqual([2, 5]);
  });

  it("the import builds the row in one place, and nowhere else", () => {
    const src = read("src/lib/imports.functions.ts");
    expect(src).toMatch(/importPlanRow\(m, \{/);
    // The inline literal is gone: nothing in the file sets preferred_weekdays
    // on a subscriptions insert by hand any more.
    expect(src).not.toMatch(/preferred_weekdays: m\.preferred_weekdays/);
    // Resolved once per row, before the insert, from the catalog read once.
    expect(src).toMatch(/const service = await resolveImportService\(m\.service_name \?\? null\)/);
    expect(src).toMatch(/\.from\("services"\)\.select\("id, name, service_line"\)/);
  });
});

describe("a walker's import", () => {
  const walk = { id: "svc-walk", name: "30-minute walk", service_line: "dog_walking" };
  const headers = [...JOBBER_HEADERS, "Service"];
  const mapping = autoMap("jobber", headers, "services");
  const row = (over: Record<string, string>) => ({
    "Client J-ID": "90",
    "Client name": "Jo Walker",
    Service: "30-minute walk",
    "Visit frequency": "Weekly",
    "Visit total": "$25.00",
    Day: "Mon/Wed/Fri",
    ...over,
  });

  it("a weekly walk with days named is a weekday set, and the preferred day is left empty", () => {
    const m = mapServiceRow(row({}), mapping).mapped!;
    const got = importPlanRow(m, { ...CTX, service: walk });
    expect(got).toMatchObject({
      frequency: "weekly",
      interval_weeks: null,
      weekdays: [1, 3, 5],
      preferred_weekdays: null,
      service_id: "svc-walk",
      price_cents: 2500,
    });
  });

  it("five walks a week from 'weekdays' or 'M-F'", () => {
    for (const Day of ["weekdays", "M-F"]) {
      const m = mapServiceRow(row({ Day }), mapping).mapped!;
      expect(importPlanRow(m, { ...CTX, service: walk }).weekdays).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it("a walk that is not weekly keeps its days as preferred days, since the set rides on weekly only", () => {
    const biweekly = mapServiceRow(
      row({ "Visit frequency": "Every 2 weeks", Day: "Tuesday" }),
      mapping,
    ).mapped!;
    const got = importPlanRow(biweekly, { ...CTX, service: walk });
    expect(got).not.toHaveProperty("weekdays");
    expect(got.preferred_weekdays).toEqual([2]);
    const everyThree = mapServiceRow(row({ "Visit frequency": "Every 3 weeks" }), mapping).mapped!;
    expect(importPlanRow(everyThree, { ...CTX, service: walk })).not.toHaveProperty("weekdays");
  });

  it("a weekly walk with no day named has no set: the generator picks the day, as before", () => {
    const m = mapServiceRow(row({ Day: "" }), mapping).mapped!;
    const got = importPlanRow(m, { ...CTX, service: walk });
    expect(got).not.toHaveProperty("weekdays");
    expect(got.preferred_weekdays).toBeNull();
  });

  it("the mapping step offers the Service column to a business that runs more than pet waste", () => {
    const page = read("src/routes/_authenticated/imports.index.tsx");
    expect(page).toMatch(/const offersServiceColumn = lines\.some\(\(l\) => l !== "pet_waste"\)/);
    expect(page).toMatch(/\.filter\(\s*\(f\) => f !== "service" \|\| offersServiceColumn,?\s*\)/);
  });

  it("a service the importer may not create is refused with a sentence, and the file goes on", () => {
    const src = read("src/lib/imports.functions.ts");
    expect(src).toMatch(/error\.code === "42501"/);
    expect(src).toMatch(/Add it in Settings → Services first/);
  });
});

// ── the wizard and the lead ────────────────────────────────────────────────

describe("the new-client wizard", () => {
  const wizard = read("src/routes/_authenticated/clients.new.tsx");
  const fns = read("src/lib/clients.functions.ts");

  it("picks a service only when the business has more than one to pick", () => {
    // RC3 (F-04): counted on the business's lines, so the seeded pet-waste
    // service of a business that does not scoop is not one of the choices.
    expect(wizard).toMatch(
      /const offersServicePicker = servicePickerOptions\(orgServices, null, pickerLines\)\.length > 1/,
    );
    expect(wizard).toMatch(/\{offersServicePicker && \(\s*<ServicePicker/);
    // Nothing is sent when nothing was offered to a pet-waste business: the
    // plan takes its default on insert, as every client before the catalog.
    // A business that does not scoop sends its one service.
    expect(wizard).toMatch(/serviceId: chosenService\?\.id,/);
    expect(wizard).toMatch(
      /const chosenService =\s*offersServicePicker \|\| \(linesKnown && !petWaste\)\s*\?/,
    );
  });

  it("prices a walk through the one rule and never from a zone", () => {
    expect(wizard).toMatch(/servicePriceCents\(chosenService!, \{ pets: dogCount \}\)/);
    expect(wizard).toMatch(/const suggestedCents = walkLike\s*\? serviceCents/);
    // The zone quote is off for a walk, and its last answer is not reused.
    expect(wizard).toMatch(/enabled:[\s\S]*?!walkLike &&[\s\S]*?queryKey: \["internal-quote"/);
    expect(wizard).toMatch(/const zoneQuote =\s*!walkLike &&/);
    expect(wizard).toMatch(
      /zoneId: \(zoneQuote\?\.zoneId as string \| null \| undefined\) \?\? undefined/,
    );
    // A first cleanup is a pet-waste thing.
    expect(wizard).toMatch(/!walkLike &&\s*can\("manage_client_billing"\)/);
  });

  it("asks for the days of a weekly walk, one day until told, and refuses none", () => {
    expect(wizard).toMatch(/const setDays = walkLike && frequency === "weekly"/);
    // The first visit's weekday until the owner picks more (F-04, #774,
    // defaultPlanWeekdays).
    expect(wizard).toMatch(/useState<number\[\] \| null>\(null\)/);
    expect(wizard).toMatch(
      /defaultPlanWeekdays\(chosenService\?\.service_line, weekdayOf\(startedOn\)\)/,
    );
    expect(wizard).toMatch(/<WeekdayPicker[\s\S]*?label="Days each week"/);
    expect(wizard).toMatch(/weekdays: setDays \? normalizeWeekdays\(weekdays\) : undefined/);
    expect(wizard).toMatch(
      /frequency === "one_time" \|\| setDays \? undefined : effectiveServiceDays/,
    );
    expect(wizard).toMatch(/needsPrice \|\| needsDays/);
  });

  it("the server accepts both, and writes them only when given", () => {
    const schema = fns.slice(
      fns.indexOf("subscription: z"),
      fns.indexOf("export const onboardClient"),
    );
    expect(schema).toMatch(/serviceId: z\.string\(\)\.uuid\(\)\.optional\(\)/);
    expect(schema).toMatch(
      /weekdays: z\.array\(z\.number\(\)\.int\(\)\.min\(0\)\.max\(6\)\)\.max\(7\)\.optional\(\)/,
    );
    const handler = fns.slice(fns.indexOf("export const onboardClient"));
    expect(handler).toMatch(/\.\.\.\(s\.serviceId \? \{ service_id: s\.serviceId \} : \{\}\)/);
    expect(handler).toMatch(/\.\.\.\(weekdays \? \{ weekdays \} : \{\}\)/);
    // The set rides on weekly, and replaces the preferred day.
    expect(handler).toMatch(
      /s\.frequency === "weekly" && s\.weekdays\?\.length \? normalizeWeekdays\(s\.weekdays\) : null/,
    );
    expect(handler).toMatch(/preferred_weekdays: !weekdays && s\.preferredWeekdays\?\.length/);
  });
});

describe("a lead's service comes through conversion", () => {
  const base: ConvertibleLead = {
    id: "lead-1",
    name: "Lauren Woods",
    email: "lauren@example.com",
    phone: null,
    company: null,
    location: "10001",
    dog_count: 1,
    frequency: "weekly",
    message: null,
    source: "web",
    status: "new",
    converted_client_id: null,
  };

  it("is carried when the lead has one, and is nothing when it has none or the column is missing", () => {
    expect(leadToWizardPrefill({ ...base, service_id: "svc-walk" }).serviceId).toBe("svc-walk");
    expect(leadToWizardPrefill({ ...base, service_id: null }).serviceId).toBeNull();
    expect(leadToWizardPrefill(base).serviceId).toBeNull();
    expect(
      leadToWizardPrefill({ ...base, service_id: "" as unknown as string }).serviceId,
    ).toBeNull();
    expect(EMPTY_PREFILL.serviceId).toBeNull();
  });

  it("is read defensively: every column, projected, never a name the table may not have", () => {
    const server = read("src/lib/lead-conversion.server.ts");
    expect(server).toMatch(/\.from\("leads"\)\.select\("\*"\)/);
    expect(server).toMatch(
      /lead\.service_id = typeof data\.service_id === "string" \? data\.service_id : null/,
    );
    expect(server).not.toMatch(/CONVERTIBLE_LEAD_COLUMNS =[^;]*service_id/);
  });

  it("starts the wizard's picker on it", () => {
    expect(read("src/routes/_authenticated/clients.new.tsx")).toMatch(
      /useState<string>\(prefill\.serviceId \?\? ""\)/,
    );
  });
});

// ── the portal reads it back ───────────────────────────────────────────────

describe("the portal shows a weekday plan as its days", () => {
  it("says Mon, Wed, Fri for a set and Weekly for a plan with none", () => {
    expect(cadenceLabel("weekly", [1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(cadenceLabel("weekly", [1, 2, 3, 4, 5])).toBe("Mon–Fri");
    expect(cadenceLabel("weekly", null)).toBe("Weekly");
    expect(cadenceLabel("weekly", [])).toBe("Weekly");
    expect(cadenceLabel("biweekly")).toBe("Every 2 weeks");
    expect(cadenceLabel(null)).toBe("");
  });

  it("on the header chip, the plan row, the top-up row and the account tab", () => {
    expect(read("src/routes/portal.$slug.$token.tsx")).toMatch(
      /cadenceLabel\(c\.primary_frequency, c\.primary_weekdays\)/,
    );
    const ui = read("src/lib/portal-ui.tsx");
    expect(ui).toMatch(/Currently \{cadenceLabel\(s\.frequency, s\.weekdays\)\}/);
    expect(ui).toMatch(
      /\{s\.property_label \?\? "Service"\} · \{cadenceLabel\(s\.frequency, s\.weekdays\)\}/,
    );
    expect(read("src/routes/portal.$slug.$token.account.tsx")).toMatch(
      /cadenceLabel\(opts\.subscription\.frequency, opts\.subscription\.weekdays\)/,
    );
    expect(read("src/lib/portal.functions.ts")).toMatch(
      /select\("id, frequency, status, ends_on, weekdays"\)/,
    );
  });

  it("names the business's service on the chip only when it is not the seeded pet waste removal", () => {
    const page = read("src/routes/portal.$slug.$token.tsx");
    expect(page).toMatch(/visitServiceLabel\(/);
    expect(page).toMatch(
      /const planLead = ownService \? `\$\{ownService\} · \$\{cadence\}` : cadence/,
    );
  });
});

describe("a client sees the walk they asked for", () => {
  it("the request list reads the service's name, and the extra cleanup as before", () => {
    const ui = read("src/lib/portal-ui.tsx");
    expect(ui).toMatch(
      /oneOff && r\.service_name \? r\.service_name : friendlyCategory\(r\.category\)/,
    );
    expect(ui).toMatch(/one_off_request: "Extra visit"/);
    expect(read("src/lib/portal.functions.ts")).toMatch(/service_name: string \| null;/);
  });

  it("the migration recreates the three portal functions, columns appended, service_role only", () => {
    const sql = read(MIGRATION);
    for (const fn of [
      "portal_get_client",
      "portal_list_prepaid_subscriptions",
      "portal_list_my_requests",
    ]) {
      expect(sql).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${fn}\\(uuid\\);`));
      expect(sql).toMatch(new RegExp(`CREATE FUNCTION public\\.${fn}\\(_token uuid\\)`));
      expect(sql).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${fn}\\(uuid\\) FROM PUBLIC, anon, authenticated;`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(uuid\\) TO service_role;`),
      );
    }
    // At the end of each return list, so a positional reader keeps its row.
    expect(sql).toMatch(
      /primary_phone text,[\s\S]*?primary_weekdays smallint\[\],\s*primary_service_name text,\s*primary_service_line text\s*\)/,
    );
    expect(sql).toMatch(/property_label text,\s*weekdays smallint\[\]\s*\)/);
    expect(sql).toMatch(/requested_on date, booked_on date,\s*service_name text\s*\)/);
    // Read from the tables the catalog already filled; nothing is backfilled.
    expect(sql).toMatch(/LEFT JOIN public\.services svc ON svc\.id = ps\.service_id/);
    expect(sql).toMatch(/LEFT JOIN public\.services svc ON svc\.id = t\.service_id/);
    expect(sql).not.toMatch(/\bUPDATE\b|\bINSERT\b|ALTER TABLE/);
    // No trigger function: the pinned count in a-trigger-function-is-not-an-rpc stays.
    expect(sql).not.toMatch(/RETURNS trigger/i);
  });

  it("the generated types know every new column", () => {
    const types = read("src/integrations/supabase/types.ts");
    const getClient = types.slice(
      types.indexOf("portal_get_client: {"),
      types.indexOf("portal_get_referral: {"),
    );
    expect(getClient).toMatch(/primary_weekdays: number\[\]/);
    expect(getClient).toMatch(/primary_service_name: string/);
    expect(getClient).toMatch(/primary_service_line: string/);
    const prepaid = types.slice(
      types.indexOf("portal_list_prepaid_subscriptions: {"),
      types.indexOf("portal_list_recent_visits: {"),
    );
    expect(prepaid).toMatch(/weekdays: number\[\]/);
    const requests = types.slice(
      types.indexOf("portal_list_my_requests: {"),
      types.indexOf("portal_list_prepaid_subscriptions: {"),
    );
    expect(requests).toMatch(/service_name: string/);
  });

  it("the viewport fixtures draw the new shapes, so the sweep measures them", () => {
    const fx = read("tests/viewports/fixtures/portal-dataset.ts");
    expect(fx).toMatch(/primary_weekdays: null/);
    expect(fx).toMatch(/primary_service_line: "pet_waste"/);
    expect(fx).toMatch(/service_name: "30-minute neighbourhood walk with a long-ish name"/);
    expect(fx).toMatch(/service_name: null/);
    expect(fx).toMatch(/property_label: "Back yard and side run",\s*weekdays: null/);
  });
});

describe("the Settings copy", () => {
  it("a pet-waste business reads the card it always has; one with other services is told where their prices live", () => {
    const card = read("src/components/settings/PortalBookingCard.tsx");
    expect(card).toMatch(/const otherServices = lines\.some\(\(l\) => l !== "pet_waste"\)/);
    // F-06: "pet waste" only beside a business's other lines, never to a
    // business that does not scoop (portalExtraVisitPriceLabel).
    expect(card).toMatch(/const priceLabel = portalExtraVisitPriceLabel\(lines\);/);
    expect(card).toMatch(/offered at their own price from Settings → Services/);
    // Staff copy says client, never customer.
    expect(card).not.toMatch(/[Cc]ustomer/);
  });
});
