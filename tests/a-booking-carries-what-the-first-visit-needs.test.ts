// A booking carries what the first visit needs (#527).
//
// The booking link asked for a name, an email, an address and one free-text
// box, so a business that had just been paid rang the customer to learn the
// pets' names, how to get in and when to start. Pinned here:
//
//   * the owner's three choices (off / optional / required) and the earliest
//     start, read defensively from lead_form_config.details, defaulting to
//     all three optional, two days out;
//   * one pet row per pet in step 1, keeping what was typed;
//   * a required answer missing, or a start date before the business can
//     come, is refused in words, with one day of slack for a visitor whose
//     calendar is behind the server's;
//   * a question the owner turned off stores nothing, whatever was sent;
//   * the sentence the success page and the welcome email both say;
//   * the migration adds the columns, nullable, on both rows a booking writes;
//   * the webhook files the answers where the tech reads them.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOOKING_DETAILS,
  bookingDetailsColumns,
  bookingDetailsProblem,
  bookingDetailsSchema,
  cleanPets,
  earliestStartDate,
  firstVisitOnOrAfter,
  firstVisitSentence,
  formatStartDate,
  isIsoDay,
  normalizeBookingDetails,
  petsSummary,
  reachTheBusinessSentence,
  resizePets,
} from "@/lib/booking-details";
import { normalizeFormConfig } from "@/lib/new-customer-form";
import { signupCheckoutSchema } from "@/lib/signup.functions";

const TODAY = "2026-10-26";
const cfg = (over: Partial<typeof DEFAULT_BOOKING_DETAILS> = {}) => ({
  ...DEFAULT_BOOKING_DETAILS,
  ...over,
});

describe("the owner's settings", () => {
  it("default to every question optional, two days out", () => {
    expect(normalizeBookingDetails(undefined)).toEqual({
      pets: "optional",
      access: "optional",
      startDate: "optional",
      earliestStartDays: 2,
    });
    expect(normalizeFormConfig(null).details).toEqual(DEFAULT_BOOKING_DETAILS);
  });

  it("keep what the owner chose and drop what makes no sense", () => {
    expect(
      normalizeBookingDetails({
        pets: "required",
        access: "off",
        startDate: "nope",
        earliestStartDays: 5,
      }),
    ).toEqual({ pets: "required", access: "off", startDate: "optional", earliestStartDays: 5 });
    expect(normalizeBookingDetails({ earliestStartDays: -1 }).earliestStartDays).toBe(2);
    expect(normalizeBookingDetails({ earliestStartDays: 2.5 }).earliestStartDays).toBe(2);
    expect(normalizeBookingDetails({ earliestStartDays: 0 }).earliestStartDays).toBe(0);
  });
});

describe("the pet rows", () => {
  it("follow step 1's count and keep what was typed", () => {
    const two = resizePets([{ name: "Biscuit", breed: "Lab" }], 2);
    expect(two).toEqual([
      { name: "Biscuit", breed: "Lab" },
      { name: "", breed: "" },
    ]);
    expect(resizePets(two, 1)).toEqual([{ name: "Biscuit", breed: "Lab" }]);
    // Mid-edit ("" in the count field) keeps the rows rather than wiping them.
    expect(resizePets(two, "")).toEqual(two);
    expect(resizePets([], 99)).toHaveLength(20);
  });

  it("store trimmed, with empty rows dropped", () => {
    expect(
      cleanPets([
        { name: "  Biscuit ", breed: "" },
        { name: "", breed: "" },
        { name: "", breed: "beagle" },
      ]),
    ).toEqual([
      { name: "Biscuit", breed: "" },
      { name: "", breed: "beagle" },
    ]);
    expect(petsSummary([{ name: "Biscuit", breed: "Lab" }, { name: "Moose" }])).toBe(
      "Biscuit (Lab), Moose",
    );
    expect(petsSummary(null)).toBeNull();
  });
});

describe("what the server refuses", () => {
  const ok = { pets: [], dogCount: 1, accessNotes: "", preferredStartDate: "" };

  it("takes nothing at all when every question is optional", () => {
    expect(bookingDetailsProblem(cfg(), ok, TODAY)).toBeNull();
  });

  it("asks for a name per pet when names are required", () => {
    const c = cfg({ pets: "required" });
    expect(
      bookingDetailsProblem(c, { ...ok, dogCount: 2, pets: [{ name: "Biscuit" }] }, TODAY),
    ).toMatch(/name for each/);
    expect(
      bookingDetailsProblem(
        c,
        { ...ok, dogCount: 2, pets: [{ name: "Biscuit" }, { name: "Moose" }] },
        TODAY,
      ),
    ).toBeNull();
  });

  it("asks how to get in when access is required", () => {
    expect(bookingDetailsProblem(cfg({ access: "required" }), ok, TODAY)).toMatch(/get in/);
    expect(
      bookingDetailsProblem(
        cfg({ access: "required" }),
        { ...ok, accessNotes: "Gate 4412" },
        TODAY,
      ),
    ).toBeNull();
  });

  it("refuses a start date before the business can come, with a day of slack", () => {
    // Earliest is 10-28; 10-27 is allowed for a visitor a calendar day behind.
    expect(earliestStartDate(TODAY, cfg())).toBe("2026-10-28");
    expect(
      bookingDetailsProblem(cfg(), { ...ok, preferredStartDate: "2026-10-27" }, TODAY),
    ).toBeNull();
    expect(bookingDetailsProblem(cfg(), { ...ok, preferredStartDate: "2026-10-26" }, TODAY)).toBe(
      "Pick a start date on or after Wednesday, October 28.",
    );
    expect(
      bookingDetailsProblem(cfg(), { ...ok, preferredStartDate: "2027-12-01" }, TODAY),
    ).toMatch(/within the next year/);
    expect(
      bookingDetailsProblem(cfg(), { ...ok, preferredStartDate: "2026-02-30" }, TODAY),
    ).toMatch(/Pick a date/);
    expect(bookingDetailsProblem(cfg({ startDate: "required" }), ok, TODAY)).toMatch(/Pick a date/);
  });

  it("stores nothing for a question the owner turned off, whatever was sent", () => {
    const sent = {
      pets: [{ name: "Biscuit", breed: "" }],
      dogCount: 1,
      accessNotes: "Gate 4412",
      preferredStartDate: "2026-11-02",
    };
    expect(bookingDetailsColumns(cfg(), sent)).toEqual({
      pets: [{ name: "Biscuit", breed: "" }],
      access_notes: "Gate 4412",
      preferred_start_date: "2026-11-02",
    });
    expect(
      bookingDetailsColumns(cfg({ pets: "off", access: "off", startDate: "off" }), sent),
    ).toEqual({
      pets: null,
      access_notes: null,
      preferred_start_date: null,
    });
  });

  it("is never a price, and the checkout schema keeps the three answers", () => {
    for (const k of Object.keys(bookingDetailsSchema.shape)) {
      expect(k).not.toMatch(/cents|price|amount/i);
    }
    const parsed = signupCheckoutSchema.parse({
      slug: "acme",
      postal_code: "78704",
      dog_count: 1,
      frequency: "weekly",
      name: "Jane",
      email: "jane@example.com",
      street: "1 Main St",
      pets: [{ name: "Biscuit", breed: "Lab" }],
      access_notes: "Gate 4412",
      preferred_start_date: "2026-11-02",
    });
    expect(parsed.pets).toEqual([{ name: "Biscuit", breed: "Lab" }]);
    expect(parsed.access_notes).toBe("Gate 4412");
    expect(parsed.preferred_start_date).toBe("2026-11-02");
  });
});

describe("what the customer is told", () => {
  it("names the day, without a time zone moving it", () => {
    expect(isIsoDay("2026-11-02")).toBe(true);
    expect(formatStartDate("2026-11-02", TODAY)).toBe("Monday, November 2");
    expect(formatStartDate("2027-01-04", TODAY)).toBe("Monday, January 4, 2027");
    expect(firstVisitSentence("Acme Scoop Co.", "2026-11-02", TODAY)).toBe(
      "Acme Scoop Co. will confirm your first visit for on or after Monday, November 2.",
    );
  });

  it("uses the day asked for, else the earliest on the day of the signup", () => {
    expect(firstVisitOnOrAfter("2026-11-09", TODAY, cfg())).toBe("2026-11-09");
    expect(firstVisitOnOrAfter(null, TODAY, cfg())).toBe("2026-10-28");
    // A day earlier than the business allows (inside the slack) is not promised.
    expect(firstVisitOnOrAfter("2026-10-27", TODAY, cfg())).toBe("2026-10-28");
  });

  it("says how to reach the business only with what it has set", () => {
    expect(reachTheBusinessSentence("(512) 555-0100", "hi@acme.test")).toBe(
      "Questions before then? Call (512) 555-0100 or email hi@acme.test.",
    );
    expect(reachTheBusinessSentence(null, "hi@acme.test")).toBe(
      "Questions before then? Email hi@acme.test.",
    );
    expect(reachTheBusinessSentence("", " ")).toBeNull();
  });
});

describe("where the answers are kept", () => {
  const sql = readFileSync(
    "supabase/migrations/20261026120000_a-booking-carries-what-the-first-visit-needs.sql",
    "utf8",
  );

  it("adds the three columns, nullable, to both rows a booking writes", () => {
    for (const table of ["signup_requests", "leads"]) {
      const block = sql.slice(sql.indexOf(`ALTER TABLE public.${table}`));
      for (const col of ["pets jsonb", "access_notes text", "preferred_start_date date"]) {
        expect(block).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
      }
    }
    expect(sql).not.toMatch(/NOT NULL/);
  });

  it("files them where the tech reads them when the webhook provisions the client", () => {
    const hook = readFileSync("src/routes/api/public/hooks/stripe.ts", "utf8");
    expect(hook).toMatch(/access_notes: sr\.access_notes/);
    expect(hook).toMatch(/from\("dogs"\)\.insert/);
    expect(hook).toMatch(/started_on: startsOn/);
    expect(hook).toMatch(/firstVisitDate/);
  });
});
