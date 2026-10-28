// The rows a groom booked from the booking link needs (#560): the service,
// its size rules, the picked add-ons, the business's day settings and the
// grooms already on the day. Read with the service role, for the business
// the slug named. The rules are in groom-online.ts; the booking itself is
// bookGroomAppointment, called from the Stripe webhook.

import { groomHoldMinutes, groomQuote, PET_SIZES, type GroomRule, type PetSize } from "@/lib/groom";
import { GROOM_BUSY_STATUSES } from "@/lib/groom-clash.server";
import { loadVaccineSettings } from "@/lib/vaccines.server";
import { GROOM_NEEDS_VACCINES, groomDayProblem, onlineGroomStarts } from "@/lib/groom-online";

type Db = any;

export type OnlineGroomFacts = {
  orgId: string;
  serviceId: string;
  /** Pets, add-ons, setup and cleanup: the hold the plan stores. */
  holdMinutes: number;
  /** Null when vaccine rules let this groom be booked online. */
  vaccineProblem: string | null;
  workDays: number[];
  earliestDays: number;
  /** Today on the business's calendar. */
  today: string;
};

function isSize(v: unknown): v is PetSize {
  return typeof v === "string" && (PET_SIZES as readonly string[]).includes(v);
}

/** The facts for one groom of `serviceId` for these pets and add-ons. */
export async function loadOnlineGroomFacts(
  db: Db,
  args: {
    orgId: string;
    serviceId: string;
    dogCount: number;
    sizes: readonly string[];
    addOnIds: readonly string[];
    earliestDays: number;
  },
): Promise<OnlineGroomFacts> {
  const [{ data: svc, error: sErr }, { data: rules, error: rErr }, { data: org, error: oErr }] =
    await Promise.all([
      db
        .from("services")
        .select(
          "id, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min",
        )
        .eq("id", args.serviceId)
        .eq("organization_id", args.orgId)
        .maybeSingle(),
      db
        .from("service_size_rules")
        .select("size, coat_type, duration_min, price_cents")
        .eq("organization_id", args.orgId)
        .eq("service_id", args.serviceId),
      db.from("organizations").select("work_days").eq("id", args.orgId).maybeSingle(),
    ]);
  if (sErr || rErr || oErr) throw new Error((sErr ?? rErr ?? oErr).message);
  if (!svc || svc.service_line !== "mobile_grooming")
    throw new Error("That service is not a groom.");

  let addOns: Array<{ id: string; name: string; unit_price_cents: number; duration_min: number }> =
    [];
  if (args.addOnIds.length) {
    const { data, error } = await db
      .from("addon_services")
      .select("id, name, unit_price_cents, duration_min")
      .eq("organization_id", args.orgId)
      .in("id", [...args.addOnIds]);
    if (error) throw new Error(error.message);
    addOns = data ?? [];
  }

  const count = Math.max(1, Math.floor(args.dogCount) || 1);
  const quote = groomQuote({
    service: svc,
    rules: ((rules ?? []) as GroomRule[]).filter((r) => r.coat_type == null),
    pets: Array.from({ length: count }, (_, i) => ({
      id: String(i),
      name: `Pet ${i + 1}`,
      size: isSize(args.sizes[i]) ? (args.sizes[i] as PetSize) : null,
      coat_type: null,
    })),
    addons: addOns.map((a) => ({ ...a, duration_min: a.duration_min ?? 0, quantity: 1 })),
  });

  const settings = await loadVaccineSettings(db, args.orgId);
  // A new customer has no records on file, so any required vaccine under a
  // "block" rule stops the online booking: the request is the way in.
  const vaccineProblem =
    settings.enabled && settings.rule === "block" && (settings.required ?? []).length > 0
      ? GROOM_NEEDS_VACCINES
      : null;

  return {
    orgId: args.orgId,
    serviceId: args.serviceId,
    holdMinutes: groomHoldMinutes(Math.max(1, quote.minutes), settings.bufferMin),
    vaccineProblem,
    workDays: (org?.work_days as number[] | null) ?? [0, 1, 2, 3, 4, 5, 6],
    earliestDays: args.earliestDays,
    today: settings.today,
  };
}

/** The open start times on `date`, or why there are none. */
export async function onlineGroomTimes(
  db: Db,
  facts: OnlineGroomFacts,
  date: string,
): Promise<{ times: string[]; problem: string | null }> {
  if (facts.vaccineProblem) return { times: [], problem: facts.vaccineProblem };
  const earliest = addDays(facts.today, facts.earliestDays);
  const { data: off, error: bErr } = await db
    .from("blackout_dates")
    .select("blackout_on")
    .eq("organization_id", facts.orgId)
    .eq("blackout_on", date)
    .limit(1);
  if (bErr) throw new Error(bErr.message);
  const problem = groomDayProblem({
    date,
    earliest,
    workDays: facts.workDays,
    blackout: (off ?? []).length > 0,
  });
  if (problem) return { times: [], problem };

  // Every groom on the day, assigned or not (onlineGroomStarts says why).
  const { data, error } = await db
    .from("visits")
    .select("start_time, duration_min, groom_summary")
    .eq("organization_id", facts.orgId)
    .eq("scheduled_on", date)
    .in("status", [...GROOM_BUSY_STATUSES])
    .not("start_time", "is", null);
  if (error) throw new Error(error.message);
  const booked = (
    (data ?? []) as Array<{
      start_time: string;
      duration_min: number | null;
      groom_summary: string | null;
    }>
  ).map((r) => ({ start: r.start_time, minutes: r.duration_min ?? 0, summary: r.groom_summary }));
  const times = onlineGroomStarts(facts.holdMinutes, booked);
  return { times, problem: times.length ? null : "No times are open that day. Pick another." };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
