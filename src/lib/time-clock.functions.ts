// The time clock's server functions: the tech's two taps, the tech's own
// "how long have I been on", and the office's week.
//
// Every write goes through the SQL functions in
// 20260928100000_nobody-was-on-the-clock.sql, which own the rules (one open
// shift per person, the offline tap time believed within seven days, no
// overlapping shifts, manage_users for corrections). Nothing here writes the
// table; the API role cannot. These validate the input's shape and pass it on.
//
// Day arithmetic is in src/lib/time-clock.ts, which is pure and tested. What
// is fetched here is bounded by the ORG's midnights, not the server's.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import {
  addDays,
  mondayOf,
  orgMidnight,
  type ClockEntry,
  type ReceivedTip,
} from "@/lib/time-clock";

const ENTRY_COLUMNS =
  "id, staff_id, clock_in, clock_out, clock_in_source, clock_out_source, note, edited_at";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a date (YYYY-MM-DD)");

type Db = any;

async function orgTimezone(supabase: Db, orgId: string): Promise<string> {
  const { data } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", orgId)
    .maybeSingle();
  return (data?.timezone as string | null) || DEFAULT_ORG_TIMEZONE;
}

/** The caller's clock for today: their shifts that touch the org's today,
 *  the open one among them, and the visits they have completed today. */
async function loadMyClock(supabase: Db, userId: string) {
  const { data: staff, error: staffErr } = await supabase
    .from("staff")
    .select("id, organization_id, display_name")
    .eq("user_id", userId)
    .eq("active", true)
    .maybeSingle();
  if (staffErr) throw new Error(staffErr.message);
  if (!staff) {
    return {
      staff: null,
      timezone: DEFAULT_ORG_TIMEZONE,
      today: orgToday(DEFAULT_ORG_TIMEZONE),
      entries: [] as ClockEntry[],
      visitsCompletedToday: 0,
    };
  }
  const tz = await orgTimezone(supabase, staff.organization_id);
  const today = orgToday(tz);
  const from = new Date(orgMidnight(today, tz)).toISOString();
  const to = new Date(orgMidnight(addDays(today, 1), tz)).toISOString();

  const [entries, visits] = await Promise.all([
    supabase
      .from("time_entries")
      .select(ENTRY_COLUMNS)
      .eq("staff_id", staff.id)
      .lt("clock_in", to)
      .or(`clock_out.is.null,clock_out.gt."${from}"`)
      .order("clock_in", { ascending: true }),
    supabase
      .from("visits")
      .select("id", { count: "exact", head: true })
      .eq("assigned_staff_id", staff.id)
      .eq("status", "completed")
      .gte("completed_at", from)
      .lt("completed_at", to),
  ]);
  if (entries.error) throw new Error(entries.error.message);
  if (visits.error) throw new Error(visits.error.message);
  return {
    staff: { id: staff.id as string, display_name: staff.display_name as string },
    timezone: tz,
    today,
    entries: (entries.data ?? []) as ClockEntry[],
    visitsCompletedToday: visits.count ?? 0,
  };
}

export type MyClock = Awaited<ReturnType<typeof loadMyClock>>;

export const getMyClock = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => loadMyClock(context.supabase, context.userId));

const tapInput = z.object({
  /** The tap time, for a REPLAYED action. Absent on the live path. The SQL
   *  decides whether to believe it. */
  at: z.string().datetime().optional(),
});

export const clockIn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => tapInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { data: id, error } = await context.supabase.rpc("clock_in", {
      _at: data.at ?? undefined,
    });
    if (error) throw new Error(error.message);
    return { id: id as string };
  });

export const clockOut = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => tapInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { data: id, error } = await context.supabase.rpc("clock_out", {
      _at: data.at ?? undefined,
    });
    if (error) throw new Error(error.message);
    // Off the clock, the lock screen's Start button has nothing to start.
    // The app ends the route there too; this covers a clock-out replayed
    // from the offline queue, or made on another device.
    const { revokeActionTokens } = await import("@/lib/live-activity-action.server");
    await revokeActionTokens(context.userId, "clocked_out");
    // The day as it stands after the tap, for the summary the tech is shown.
    const clock = await loadMyClock(context.supabase, context.userId);
    return { id: (id as string | null) ?? null, clock };
  });

export const listTimesheet = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ weekOf: isoDay }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // The same permission the table's policy and the office functions ask,
    // so the page cannot promise an edit the database will refuse.
    const { orgId } = await requirePermission(supabase, userId, "manage_users");
    const tz = await orgTimezone(supabase, orgId);
    const weekStart = mondayOf(data.weekOf);
    const from = new Date(orgMidnight(weekStart, tz)).toISOString();
    const to = new Date(orgMidnight(addDays(weekStart, 7), tz)).toISOString();

    const [staff, entries, visits] = await Promise.all([
      supabase
        .from("staff")
        .select("id, display_name, active, is_field_tech")
        .eq("organization_id", orgId)
        .order("display_name", { ascending: true }),
      supabase
        .from("time_entries")
        .select(ENTRY_COLUMNS)
        .eq("organization_id", orgId)
        .lt("clock_in", to)
        .or(`clock_out.is.null,clock_out.gt."${from}"`)
        .order("clock_in", { ascending: true }),
      supabase
        .from("visits")
        .select("assigned_staff_id, completed_at")
        .eq("organization_id", orgId)
        .eq("status", "completed")
        .not("assigned_staff_id", "is", null)
        .gte("completed_at", from)
        .lt("completed_at", to),
    ]);
    if (staff.error) throw new Error(staff.error.message);
    if (entries.error) throw new Error(entries.error.message);
    if (visits.error) throw new Error(visits.error.message);

    // Tips credited this week, for the payroll columns. Service-role and
    // scoped to this org after the manage_users check above: payments are
    // readable under RLS only to billing and finance roles, and the person
    // running payroll needs each tech's tip total without being handed the
    // payment ledger. Only the three columns the sheet needs are read.
    const tips = await loadWeekTips(orgId, from, to);

    const all = (staff.data ?? []) as {
      id: string;
      display_name: string;
      active: boolean;
      is_field_tech: boolean | null;
    }[];
    const rows = (entries.data ?? []) as ClockEntry[];
    const worked = new Set(rows.map((e) => e.staff_id));
    const visitedBy = new Set(
      ((visits.data ?? []) as { assigned_staff_id: string | null }[]).map(
        (v) => v.assigned_staff_id,
      ),
    );
    const tippedTo = new Set(tips.map((t) => t.tip_staff_id));
    // A row for everyone who runs routes, whether or not they clocked in --
    // an empty row beside a count of completed visits is the forgotten
    // clock-in the office needs to see -- plus anyone else who has hours or
    // visits this week (an owner who drove one day, a tech since deactivated).
    const onSheet = all.filter(
      (s) =>
        (s.active && s.is_field_tech !== false) ||
        worked.has(s.id) ||
        visitedBy.has(s.id) ||
        tippedTo.has(s.id),
    );
    return {
      timezone: tz,
      weekStart,
      today: orgToday(tz),
      staff: onSheet.map((s) => ({ id: s.id, display_name: s.display_name, active: s.active })),
      /** Who time can be added for: every active member of the team. */
      pickable: all
        .filter((s) => s.active)
        .map((s) => ({ id: s.id, display_name: s.display_name })),
      entries: rows,
      visits: (visits.data ?? []) as { assigned_staff_id: string | null; completed_at: string | null }[],
      tips,
    };
  });

/** Tips credited to a person on payments received in [from, to). Received
 *  means the money arrived: `succeeded`, or `refunded` (which still arrived,
 *  per src/lib/revenue.ts). */
async function loadWeekTips(orgId: string, from: string, to: string): Promise<ReceivedTip[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { receivedPaymentStatuses } = await import("@/lib/revenue");
  const { data, error } = await supabaseAdmin
    .from("payments")
    .select("tip_staff_id, tip_cents, paid_at")
    .eq("organization_id", orgId)
    .in("status", receivedPaymentStatuses())
    .gt("tip_cents", 0)
    .not("tip_staff_id", "is", null)
    .gte("paid_at", from)
    .lt("paid_at", to);
  if (error) throw new Error(error.message);
  return (data ?? []) as ReceivedTip[];
}

const note = z.string().trim().max(500).optional();

export const editTimeEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        clockIn: z.string().datetime(),
        /** Null leaves a running shift running. */
        clockOut: z.string().datetime().nullable(),
        note,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("office_edit_time_entry", {
      _id: data.id,
      _clock_in: data.clockIn,
      // The SQL function takes NULL: it leaves a running shift running.
      _clock_out: data.clockOut as string,
      _note: data.note ?? "",
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const addTimeEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        clockIn: z.string().datetime(),
        clockOut: z.string().datetime(),
        note,
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: id, error } = await context.supabase.rpc("office_add_time_entry", {
      _staff_id: data.staffId,
      _clock_in: data.clockIn,
      _clock_out: data.clockOut,
      _note: data.note ?? "",
    });
    if (error) throw new Error(error.message);
    return { id: id as string };
  });
