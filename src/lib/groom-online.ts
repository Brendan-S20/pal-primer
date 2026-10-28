/** A groom booked from the booking link (#560), with nothing to render.
 *
 *  Brendan, 2026-10-28: a groom on the link needs both paths. The priced
 *  request stays ("Request this groom": the office confirms a time). Beside
 *  it, a visitor may pick a day and an open start time and pay for the first
 *  groom, and the webhook books it with the office's own bookGroomAppointment.
 *
 *  This file is the part of that which needs no database: how often the plan
 *  repeats, whether a day can take a groom, and which start times are open.
 *  groom-online.server.ts reads the rows; the form, the server functions and
 *  the tests read these rules. English only: a customer reads them. */

import { openGroomStarts, type BookedGroom } from "@/lib/groom";

/** The plan's repeat, from the cadence the form offered. Grooming offers
 *  monthly and every two weeks (BOOKING_COPY.mobile_grooming.cadences), and
 *  a groom plan repeats in whole weeks, so monthly is every four. */
export function groomEveryWeeks(frequency: string): number | null {
  if (frequency === "biweekly") return 2;
  if (frequency === "monthly") return 4;
  if (frequency === "weekly") return 1;
  return null;
}

/** What groom_booking holds on a signup request. */
export type OnlineGroomBooking = {
  start_time: string;
  pet_sizes: string[];
  add_on_ids: string[];
  every_weeks: number | null;
};

/** groom_booking, read defensively. Null when it is not a booking. */
export function onlineGroomBookingFrom(raw: unknown): OnlineGroomBooking | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.start_time !== "string" || !/^\d{2}:\d{2}$/.test(o.start_time)) return null;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const weeks = typeof o.every_weeks === "number" && o.every_weeks >= 1 ? o.every_weeks : null;
  return {
    start_time: o.start_time,
    pet_sizes: strings(o.pet_sizes),
    add_on_ids: strings(o.add_on_ids),
    every_weeks: weeks,
  };
}

/** Why a day cannot take a groom booked online, or null when it can. */
export function groomDayProblem(input: {
  date: string;
  earliest: string;
  workDays: readonly number[];
  blackout: boolean;
}): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return "Pick a day for the groom.";
  if (input.date < input.earliest) return "That day is too soon. Pick a later day.";
  const dow = new Date(`${input.date}T12:00:00Z`).getUTCDay();
  if (!input.workDays.includes(dow)) return "We don't groom on that day. Pick another.";
  if (input.blackout) return "We're closed that day. Pick another.";
  return null;
}

/** The start times a stranger may book: every opening on the step where a
 *  groom this long fits beside every groom already on that day, whichever
 *  groomer has it. Counting every groomer's grooms is the safe side for a
 *  business with one van (most of them); one with two vans is offered fewer
 *  times than it has, never a time it does not. */
export function onlineGroomStarts(holdMinutes: number, booked: readonly BookedGroom[]): string[] {
  return openGroomStarts(holdMinutes, booked);
}

/** What a visitor reads when grooms need vaccine records first. */
export const GROOM_NEEDS_VACCINES =
  "This groomer needs your pet's vaccine records before a groom is booked. Send a request and we'll set it up.";

/** What a visitor reads when the time they picked has gone. */
export const GROOM_TIME_TAKEN = "That time was just taken. Pick another time.";

/** "09:30" as a customer reads it: "9:30 AM". */
export function groomTimeLabel(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}
