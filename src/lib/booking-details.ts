/** What the booking link asks for the first visit (#527), with nothing to
 *  render.
 *
 *  Step 2 used to ask for a name, an email, a phone, an address and one
 *  free-text box ("Gate code, dog names, preferred days..."), so a business
 *  that had just been paid had to ring the customer to learn the pets' names,
 *  how to get in and when to start. This is the rule for the three questions
 *  that replace the guessing:
 *
 *    - the pets: a name (and a breed or size) per pet, as many rows as the
 *      pet count in step 1;
 *    - how to get in: "Gate code or access notes", which provisioning writes
 *      to properties.access_notes, the line My Day and the visit drawer
 *      already show the tech under Access;
 *    - when to start: a date no earlier than the business allows (default
 *      two days out), which becomes the subscription's started_on, so no
 *      visit is generated before it.
 *
 *  Each is "off", "optional" or "required", as the owner sets it in
 *  Settings → Online signup. They live in `organizations.lead_form_config`
 *  beside the other questions the form asks, under `details`, read here
 *  defensively. None of them touches the price: public_quote is asked
 *  exactly what it was asked before.
 *
 *  Pure, so the form, the two server writes, the success page and the tests
 *  read one copy. English only: a customer reads all of it. */

import { z } from "zod";

export type DetailAsk = "off" | "optional" | "required";

export const DETAIL_ASKS: readonly DetailAsk[] = ["off", "optional", "required"];

export type BookingDetailsConfig = {
  pets: DetailAsk;
  access: DetailAsk;
  startDate: DetailAsk;
  /** The earliest start, in days from today. 0 is "today". */
  earliestStartDays: number;
};

export const DEFAULT_BOOKING_DETAILS: BookingDetailsConfig = {
  pets: "optional",
  access: "optional",
  startDate: "optional",
  earliestStartDays: 2,
};

/** The longest lead time an owner can set. A booking link that will not
 *  start for more than two months is a waiting list, not a booking. */
export const MAX_EARLIEST_START_DAYS = 60;

/** How far out a visitor can ask to start. */
export const MAX_START_DAYS_OUT = 365;

/** The longest answers the form takes, and the server enforces. */
export const PET_NAME_MAX = 60;
export const PET_BREED_MAX = 80;
export const ACCESS_NOTES_MAX = 500;
/** Matches step 1's own ceiling on the pet count. */
export const MAX_PETS = 20;

function ask(v: unknown, fallback: DetailAsk): DetailAsk {
  return v === "off" || v === "optional" || v === "required" ? v : fallback;
}

/** `lead_form_config.details`, read defensively: anything missing or
 *  malformed is the default, so a business that never opened the setting
 *  gets all three questions, optional, starting two days out. */
export function normalizeBookingDetails(raw: unknown): BookingDetailsConfig {
  const c = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const days = Number(c.earliestStartDays);
  return {
    pets: ask(c.pets, DEFAULT_BOOKING_DETAILS.pets),
    access: ask(c.access, DEFAULT_BOOKING_DETAILS.access),
    startDate: ask(c.startDate, DEFAULT_BOOKING_DETAILS.startDate),
    earliestStartDays:
      Number.isInteger(days) && days >= 0 && days <= MAX_EARLIEST_START_DAYS
        ? days
        : DEFAULT_BOOKING_DETAILS.earliestStartDays,
  };
}

// ── Dates, as YYYY-MM-DD with no time zone in them ─────────────────────────
//
// A start date is a day on the customer's calendar, not an instant. Every
// helper below works on the string, through UTC arithmetic, so no machine's
// time zone can move it a day: `new Date("2026-11-02")` is midnight UTC,
// which is the evening of November 1 in Texas.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDay(s: unknown): s is string {
  if (typeof s !== "string" || !ISO_DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Today on THIS machine's calendar, as the browser's date picker sees it. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The first day a visitor may pick: today plus the business's lead time. */
export function earliestStartDate(today: string, cfg: BookingDetailsConfig): string {
  return addDays(today, cfg.earliestStartDays);
}

/** "Monday, November 2". The year only when it is not this one. */
export function formatStartDate(iso: string, today?: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const sameYear = !today || today.slice(0, 4) === iso.slice(0, 4);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(d);
}

/** The day the first visit is on or after: the one asked for, else the
 *  earliest the business allowed on the day the signup was made. */
export function firstVisitOnOrAfter(
  preferred: string | null | undefined,
  signedUpOn: string,
  cfg: BookingDetailsConfig,
): string {
  const earliest = earliestStartDate(signedUpOn, cfg);
  return isIsoDay(preferred) && preferred > earliest ? preferred : earliest;
}

/** "Acme Scoop Co. will confirm your first visit for on or after Monday,
 *  November 2." The words the success page and the welcome email both say. */
export function firstVisitSentence(
  orgName: string | null | undefined,
  iso: string,
  today?: string,
) {
  const who = (orgName ?? "").trim() || "We";
  return `${who} will confirm your first visit for on or after ${formatStartDate(iso, today)}.`;
}

/** "Questions before then? Call (512) 555-0100 or email hi@acme.test." Null
 *  when the business has set neither. */
export function reachTheBusinessSentence(
  phone: string | null | undefined,
  email: string | null | undefined,
): string | null {
  const p = (phone ?? "").trim();
  const e = (email ?? "").trim();
  if (p && e) return `Questions before then? Call ${p} or email ${e}.`;
  if (p) return `Questions before then? Call ${p}.`;
  if (e) return `Questions before then? Email ${e}.`;
  return null;
}

// ── The pets ───────────────────────────────────────────────────────────────

export type PetEntry = { name: string; breed: string };

/** One row per pet, as many as step 1's count: rows already typed keep their
 *  answers, extra rows are added empty, and a lower count drops the ones at
 *  the end. A count that is not a number yet (the field mid-edit) keeps what
 *  is there. */
export function resizePets(pets: readonly PetEntry[], count: unknown): PetEntry[] {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) return [...pets];
  const capped = Math.min(n, MAX_PETS);
  return Array.from({ length: capped }, (_, i) => pets[i] ?? { name: "", breed: "" });
}

/** What is stored: trimmed, with rows that say nothing dropped. A breed with
 *  no name is kept, because "a lab and a beagle" is still worth knowing. */
export function cleanPets(
  pets: readonly { name?: string | null; breed?: string | null }[] | null | undefined,
) {
  return (pets ?? [])
    .map((p) => ({
      name: (p.name ?? "").trim().slice(0, PET_NAME_MAX),
      breed: (p.breed ?? "").trim().slice(0, PET_BREED_MAX),
    }))
    .filter((p) => p.name || p.breed)
    .slice(0, MAX_PETS);
}

/** The names on one line, for the office's list. */
export function petsSummary(pets: unknown): string | null {
  if (!Array.isArray(pets)) return null;
  const parts = cleanPets(pets as PetEntry[]).map((p) =>
    p.name && p.breed ? `${p.name} (${p.breed})` : p.name || p.breed,
  );
  return parts.length ? parts.join(", ") : null;
}

// ── What the server checks ─────────────────────────────────────────────────

/** The first visit's three answers (#527), as both public writes take them:
 *  this signup and the quote request (routes/api/public/leads.ts). */
export const bookingDetailsSchema = z.object({
  pets: z
    .array(
      z.object({
        name: z.string().trim().max(PET_NAME_MAX).optional().or(z.literal("")),
        breed: z.string().trim().max(PET_BREED_MAX).optional().or(z.literal("")),
      }),
    )
    .max(MAX_PETS)
    .optional(),
  access_notes: z.string().trim().max(ACCESS_NOTES_MAX).optional().or(z.literal("")),
  preferred_start_date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal("")),
});

export type BookingDetailsAnswer = {
  pets?: readonly { name?: string | null; breed?: string | null }[] | null;
  dogCount?: number | null;
  accessNotes?: string | null;
  preferredStartDate?: string | null;
};

/**
 * Why these answers cannot be taken, in words for the visitor, or null when
 * they can. `today` is the server's UTC day; a visitor west of Greenwich can
 * be a calendar day behind it, so the earliest date is allowed one day of
 * slack rather than refusing somebody who picked the first day their own
 * picker offered.
 */
export function bookingDetailsProblem(
  cfg: BookingDetailsConfig,
  a: BookingDetailsAnswer,
  today: string,
): string | null {
  if (cfg.pets === "required") {
    const named = cleanPets(a.pets).filter((p) => p.name).length;
    const want = Math.max(1, Math.min(MAX_PETS, a.dogCount ?? 1));
    if (named < want) return "Add a name for each of your pets.";
  }
  if (cfg.access === "required" && !(a.accessNotes ?? "").trim()) {
    return "Tell us how to get in: a gate code, or where to find the way in.";
  }
  const date = (a.preferredStartDate ?? "").trim();
  if (!date) {
    return cfg.startDate === "required" ? "Pick a date for your service to start." : null;
  }
  if (cfg.startDate === "off") return null;
  if (!isIsoDay(date)) return "Pick a date for your service to start.";
  const earliest = earliestStartDate(today, cfg);
  if (date < addDays(earliest, -1)) {
    return `Pick a start date on or after ${formatStartDate(earliest, today)}.`;
  }
  if (date > addDays(today, MAX_START_DAYS_OUT)) {
    return "Pick a start date within the next year.";
  }
  return null;
}

/** The three answers as they are stored on the signup request and the lead:
 *  a question the owner turned off stores nothing, whatever was sent. */
export function bookingDetailsColumns(cfg: BookingDetailsConfig, a: BookingDetailsAnswer) {
  const pets = cfg.pets === "off" ? [] : cleanPets(a.pets);
  const access =
    cfg.access === "off" ? "" : (a.accessNotes ?? "").trim().slice(0, ACCESS_NOTES_MAX);
  const date = cfg.startDate === "off" ? "" : (a.preferredStartDate ?? "").trim();
  return {
    pets: pets.length ? pets : null,
    access_notes: access || null,
    preferred_start_date: isIsoDay(date) ? date : null,
  };
}
