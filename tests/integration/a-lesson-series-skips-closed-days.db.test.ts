/**
 * R2-49 (train-r2-08), reproduced and then fixed against the real generator.
 *
 * The audit's open-ended weekly Friday lesson series put a lesson on
 * Fri Dec 25 and never stopped. Here the holiday is a date three weeks out on
 * the series' own weekday, so the test does not depend on when it runs.
 *
 *   1. A series that does NOT skip closed days still gets the holiday lesson:
 *      the audit's finding, unchanged for anyone who turns the setting off.
 *   2. A training series on the business default (skip on) gets no lesson on
 *      the holiday or on a blackout date, and keeps the weeks around them.
 *   3. A series that stops after 3 lessons has 3, however far it generates.
 *
 * Local stack only. Skipped without TEST_SUPABASE_* env.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { addDays, nextOrgWeekday } from "../support/org-day";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && SERVICE);
const runId = Math.random().toString(36).slice(2, 8);
const ORG_TZ = "UTC";
// A Wednesday, a working day in every default work week.
const WEEKDAY = 3;
const first = nextOrgWeekday(ORG_TZ, WEEKDAY, 1);
const holiday = addDays(first, 21);
const blackout = addDays(first, 35);
const through = addDays(first, 70);

let admin: SupabaseClient;
let orgId: string;
let clientId: string;
let propertyId: string;
let serviceId: string;

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data as { id: string }).id;
}

async function series(extra: Record<string, unknown>) {
  const id = await insert("subscriptions", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    account_type: "residential",
    frequency: "weekly",
    weekdays: [WEEKDAY],
    dog_count: 1,
    price_cents: 9500,
    service_id: serviceId,
    status: "active",
    started_on: first,
    ...extra,
  });
  const generated = await admin.rpc("generate_visits_core", {
    _org_id: orgId,
    _through: through,
    _subscription_id: id,
  });
  expect(generated.error).toBeNull();
  const { data, error } = await admin
    .from("visits")
    .select("scheduled_on")
    .eq("subscription_id", id)
    .order("scheduled_on");
  expect(error).toBeNull();
  return { id, days: (data ?? []).map((v) => v.scheduled_on as string) };
}

describe.skipIf(!enabled)("a lesson series and the days the business is closed (R2-49)", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await insert("organizations", {
      name: `Series ${runId}`,
      service_lines: ["training"],
      timezone: ORG_TZ,
    });
    clientId = await insert("clients", {
      organization_id: orgId,
      display_name: `Series client ${runId}`,
      account_type: "residential",
    });
    propertyId = await insert("properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "1 Series St",
      city: "Testville",
      postal_code: "48000",
    });
    serviceId = await insert("services", {
      organization_id: orgId,
      name: `Weekly lesson ${runId}`,
      service_line: "training",
      price_unit: "visit",
      default_duration_min: 60,
      active: true,
    });
    await insert("holiday_dates", { organization_id: orgId, holiday_on: holiday, name: "Holiday" });
    await insert("blackout_dates", {
      organization_id: orgId,
      blackout_on: blackout,
      reason: "Closed",
    });
  });

  afterAll(async () => {
    if (orgId) await admin.from("organizations").delete().eq("id", orgId);
  });

  it("reproduces train-r2-08: a series that does not skip closed days books the holiday lesson", async () => {
    const { days } = await series({ skip_closed_days: false });
    expect(days).toContain(holiday);
    expect(days.length).toBeGreaterThan(6);
  });

  it("a training series on the business default books nothing on the holiday or the blackout", async () => {
    const { days } = await series({});
    expect(days).not.toContain(holiday);
    expect(days).not.toContain(blackout);
    // The weeks either side are still booked.
    expect(days).toContain(addDays(holiday, -7));
    expect(days).toContain(addDays(holiday, 7));
  });

  it("a business that turns the default off gets the holiday lesson back for a new series", async () => {
    const { error } = await admin
      .from("organizations")
      .update({ training_series_skip_closed: false })
      .eq("id", orgId);
    expect(error).toBeNull();
    const { days } = await series({});
    expect(days).toContain(holiday);
    await admin.from("organizations").update({ training_series_skip_closed: true }).eq("id", orgId);
  });

  it("a series that stops after 3 lessons has 3, and a canceled one without charge frees a place", async () => {
    // Skip off, so this case is about the count alone. The next lesson after
    // the third falls on `holiday` (first + 21), and with skip on the trigger
    // leaves that insert out, as it should.
    const { id, days } = await series({ session_limit: 3, skip_closed_days: false });
    expect(days).toEqual([first, addDays(first, 7), addDays(first, 14)]);
    const again = await admin.rpc("generate_visits_core", {
      _org_id: orgId,
      _through: through,
      _subscription_id: id,
    });
    expect(again.error).toBeNull();
    const { count } = await admin
      .from("visits")
      .select("*", { count: "exact", head: true })
      .eq("subscription_id", id);
    expect(count).toBe(3);

    const firstLesson = days[0];
    const skipped = await admin
      .from("visits")
      .update({ status: "skipped", skip_billable: false })
      .eq("subscription_id", id)
      .eq("scheduled_on", firstLesson);
    expect(skipped.error).toBeNull();
    // Straight inserts, so this is the rule and not the generator's walk: one
    // more lesson fits in the freed place, and the one after it does not.
    const lesson = (day: string) => ({
      organization_id: orgId,
      subscription_id: id,
      client_id: clientId,
      property_id: propertyId,
      service_id: serviceId,
      scheduled_on: day,
    });
    const fourth = await admin.from("visits").insert(lesson(addDays(days[2], 7)));
    expect(fourth.error).toBeNull();
    const fifth = await admin.from("visits").insert(lesson(addDays(days[2], 14)));
    expect(fifth.error).toBeNull();
    const { data } = await admin
      .from("visits")
      .select("scheduled_on, status")
      .eq("subscription_id", id)
      .eq("status", "scheduled");
    expect((data ?? []).map((v) => v.scheduled_on).sort()).toEqual(
      [days[1], days[2], addDays(days[2], 7)].sort(),
    );
  });

  it("a skipped holiday does not use up one of the series' lessons", async () => {
    const { days } = await series({ session_limit: 4 });
    expect(days).toEqual([first, addDays(first, 7), addDays(first, 14), addDays(first, 28)]);
  });

  it("an open-ended series keeps generating", async () => {
    const { days } = await series({ session_limit: null });
    expect(days.length).toBeGreaterThan(6);
  });
});
