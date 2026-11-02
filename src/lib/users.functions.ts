import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  // Through the shared gate, so a person whose access is turned off is
  // refused here as everywhere else (20261009180000).
  return (await resolveCaller(supabase, userId)).orgId;
}

async function requireDemoInviteAddress(
  supabase: any,
  orgId: string,
  email: string,
): Promise<void> {
  const { data } = await supabase
    .from("organizations")
    .select("slug")
    .eq("id", orgId)
    .maybeSingle();
  if (data?.slug === "demo" && !email.toLowerCase().endsWith("@demo.test")) {
    throw new Error("Demo organization invites must use an @demo.test address");
  }
}

export const listOrgUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await context.supabase.rpc("list_org_users", { _org_id: orgId });
    if (error) throw new Error(error.message);
    return { users: data ?? [] };
  });

/**
 * D7 (#659, decided by Brendan 2026-11-02): only an owner turns a person on
 * or off, or changes anybody's role -- and so only an owner can make somebody
 * an owner. Settings -> Users already showed these controls to the owner
 * alone; setStaffActive did not ask at all, so an office manager could
 * deactivate any teammate through it. The database refuses the same things
 * (set_staff_active, change_user_role, and the restrictive policies on staff
 * in 20261102140000); this is the readable sentence, not the only lock.
 */
export const ONLY_AN_OWNER_TURNS_PEOPLE_ON_OR_OFF = "Only an owner can turn people on or off.";
export const ONLY_AN_OWNER_CHANGES_ROLES = "Only an owner can change roles.";

async function requireOwner(
  supabase: unknown,
  userId: string,
  refusal: string,
): Promise<{ orgId: string }> {
  const caller = await resolveCaller(supabase, userId);
  if (caller.role !== "owner") throw new Error(refusal);
  return { orgId: caller.orgId };
}

const roleEnum = z.enum(["owner", "office_manager", "dispatcher", "tech"]);

export const changeUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ userId: z.string().uuid(), role: roleEnum }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requireOwner(
      context.supabase,
      context.userId,
      ONLY_AN_OWNER_CHANGES_ROLES,
    );
    const { error } = await context.supabase.rpc("change_user_role", {
      _org_id: orgId,
      _user_id: data.userId,
      _new_role: data.role,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * What the Stripe seat reconcile did, for a caller that wants to say so.
 *
 * `skipped` is not a failure and must not be reported as one: it is the answer
 * for an org with no live subscription, one not on a per-employee plan, or a
 * Stripe key that is not configured, and those are the ordinary cases. Only
 * `failed` means the seat quantity may now disagree with the employee count.
 */
export type SeatOutcome =
  | { state: "synced"; quantity: number; changed: boolean }
  | { state: "skipped"; why: string }
  | { state: "failed" }
  | { state: "unknown" };

export const setStaffActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ staffId: z.string().uuid(), active: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    // Owner only (D7, #659), asked before anything is read or written.
    const { orgId } = await requireOwner(
      context.supabase,
      context.userId,
      ONLY_AN_OWNER_TURNS_PEOPLE_ON_OR_OFF,
    );
    // Enabling somebody past the plan's team-size cap is refused here, before
    // the write, with the sentence the owner needs (NP-10). The database
    // trigger staff_team_size_cap refuses it too, for callers that reach the
    // RPC without this function. Turning somebody OFF is never refused.
    if (data.active) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: row } = await (supabaseAdmin as any)
        .from("staff")
        .select("organization_id, active")
        .eq("id", data.staffId)
        .maybeSingle();
      if (row && row.organization_id === orgId && !row.active) {
        const { assertRoomForAnotherUser } = await import("@/lib/team-size.server");
        await assertRoomForAnotherUser(orgId);
      }
    }
    const { error } = await context.supabase.rpc("set_staff_active", {
      _staff_id: data.staffId,
      _active: data.active,
    });
    if (error) throw new Error(error.message);
    // Activating/deactivating an employee changes the billable seat count, so
    // the Stripe seat-overage quantity is reconciled here. Best-effort, and
    // that does not change: never block a staff toggle because billing is not
    // configured or Stripe hiccupped.
    //
    // WHAT CHANGED IS THAT A FAILURE IS NO LONGER SILENT. syncOrgSeatQuantity
    // already returns a discriminated result and all three call sites threw it
    // away. Nothing reconciles seats on a schedule -- not the nightly run, not
    // a cron -- so the only healing is the next staff toggle, the next invite
    // accepted, or somebody opening the billing page. An organization that
    // does none of those keeps the drifted quantity indefinitely.
    //
    // The direction that matters: deactivating an employee and losing the sync
    // means we go on charging for a seat the customer no longer has. The
    // opposite direction only costs us money, which is our problem rather
    // than theirs.
    let seats: SeatOutcome = { state: "unknown" };
    try {
      const { syncOrgSeatQuantity } = await import("@/lib/seat-sync.server");
      const r = await syncOrgSeatQuantity(orgId);
      seats =
        "skipped" in r
          ? { state: "skipped", why: r.skipped }
          : { state: "synced", quantity: r.quantity, changed: r.changed };
    } catch (e) {
      seats = { state: "failed" };
      console.error("seat sync after set_staff_active failed", (e as Error).message);
    }
    return { ok: true, seats };
  });

// Reconcile the caller org's Stripe seat-overage quantity to its current active
// employee count. Called after invite acceptance (a new employee just joined)
// so billing catches up without waiting for the next staff toggle. Best-effort:
// returns { ok: true } even when there's nothing to sync.
export const resyncMySeats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    let seats: SeatOutcome = { state: "unknown" };
    try {
      const orgId = await resolveOrgId(context.supabase, context.userId);
      const { syncOrgSeatQuantity } = await import("@/lib/seat-sync.server");
      const r = await syncOrgSeatQuantity(orgId);
      seats =
        "skipped" in r
          ? { state: "skipped", why: r.skipped }
          : { state: "synced", quantity: r.quantity, changed: r.changed };
      // Let owners/managers know a teammate joined.
      try {
        const { data: userData } = await context.supabase.auth.getUser();
        const who = userData.user?.email ?? "A teammate";
        const { notifyRoles } = await import("@/lib/notify-center.server");
        await notifyRoles(["owner", "office_manager"], {
          orgId,
          type: "teammate_joined",
          title: "A teammate joined",
          body: `${who} accepted their invite.`,
          link: "/settings/users",
        });
      } catch (e) {
        console.error("teammate-joined notification failed", (e as Error).message);
      }
    } catch (e) {
      seats = { state: "failed" };
      console.error("resyncMySeats failed", (e as Error).message);
    }
    return { ok: true, seats };
  });

// ── Teammate invites (finding #40) ───────────────────────────────────────────
const inviteRoleEnum = z.enum(["office_manager", "dispatcher", "tech"]);

// BUILD-6: the body of this moved to @/lib/invite-email.server so the
// franchise-location flow sends the same email rather than a second one that
// drifts. Still best-effort — the pending row works whether or not the mail
// does — and still imported lazily, so the Resend call never enters a bundle
// that does not send invites.
async function sendInviteEmail(
  orgName: string,
  email: string,
  role: string,
  token?: string,
): Promise<boolean> {
  const { sendInviteEmail: send } = await import("@/lib/invite-email.server");
  return send(orgName, email, role, token);
}

/** The link an owner can copy and send by hand when the email does not go
 *  out, or goes to spam. Same page the email links to. */
async function inviteLink(token: string): Promise<string> {
  const { appUrl } = await import("@/lib/app-origin");
  return appUrl(`/invite/${encodeURIComponent(token)}`);
}

export const createOrgInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ email: z.string().trim().email().max(255), role: inviteRoleEnum }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const email = data.email.toLowerCase();
    await requireDemoInviteAddress(context.supabase, orgId, email);
    // No invite past the plan's team-size cap (NP-10): the person would
    // arrive to an account with no room for them.
    const { assertRoomForAnotherUser } = await import("@/lib/team-size.server");
    await assertRoomForAnotherUser(orgId);
    const crypto = await import("node:crypto");
    const token = crypto.randomBytes(24).toString("hex");

    // Supersede any existing pending invite for this email in this org.
    await (context.supabase as any)
      .from("org_invites")
      .update({ status: "revoked" })
      .eq("organization_id", orgId)
      .eq("email", email)
      .eq("status", "pending");

    const { data: row, error } = await (context.supabase as any)
      .from("org_invites")
      .insert({ organization_id: orgId, email, role: data.role, token, invited_by: context.userId })
      .select("id, token")
      .single();
    if (error) throw new Error(error.message);

    const { data: org } = await context.supabase
      .from("organizations")
      .select("name")
      .eq("id", orgId)
      .maybeSingle();
    // The token travels with the email now. Without it, an invitee who already
    // had an account when they were invited cannot join at all: the email path
    // in accept_org_invite_for_current_user only accepts invitations older than
    // the account, which is what closes the pre-claim.
    // Reported, not assumed: "Invite sent" when the provider is off or
    // refused the address left owners waiting on an email that never left
    // (#568). The link works either way.
    const emailSent = await sendInviteEmail(
      (org as any)?.name ?? "HoundStack",
      email,
      data.role,
      row.token as string,
    );
    return { id: row.id as string, emailSent, link: await inviteLink(row.token as string) };
  });

// Re-send the invite email for a still-pending invite and refresh its expiry.
export const resendOrgInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const { data: invite, error } = await (context.supabase as any)
      .from("org_invites")
      .select("email, role, status, token")
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!invite) throw new Error("Invite not found");
    if (invite.status !== "pending") throw new Error("Only pending invites can be resent");
    await requireDemoInviteAddress(context.supabase, orgId, invite.email as string);

    // Push the expiry out so a resent invite isn't immediately stale.
    await (context.supabase as any)
      .from("org_invites")
      .update({ expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() })
      .eq("id", data.id)
      .eq("organization_id", orgId);

    const { data: org } = await context.supabase
      .from("organizations")
      .select("name")
      .eq("id", orgId)
      .maybeSingle();
    // The token matters most on THIS path: resend is what somebody presses when
    // the first email did not arrive, and an invitee whose account already
    // existed can only join through the link.
    const emailSent = await sendInviteEmail(
      (org as any)?.name ?? "HoundStack",
      invite.email as string,
      invite.role as string,
      invite.token as string,
    );
    return { ok: true, emailSent, link: await inviteLink(invite.token as string) };
  });

export const listOrgInvites = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const { data, error } = await (context.supabase as any)
      .from("org_invites")
      .select("id, email, role, status, created_at, expires_at, accepted_at, token")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    // The token leaves the server only as a link, and only while it can still
    // be used.
    const invites = await Promise.all(
      (data ?? []).map(async ({ token, ...inv }: any) => ({
        ...inv,
        link: inv.status === "pending" && token ? await inviteLink(token) : null,
      })),
    );
    return { invites };
  });

export const revokeOrgInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const { error } = await (context.supabase as any)
      .from("org_invites")
      .update({ status: "revoked" })
      .eq("id", data.id)
      .eq("organization_id", orgId)
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Finding #26: routing eligibility flags. is_field_tech = "does fieldwork and
// can be routed"; routing_available = "available for routing right now"
// (temporary, e.g. on leave) without deleting the account.
export const setStaffRouting = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        isFieldTech: z.boolean().optional(),
        routingAvailable: z.boolean().optional(),
        // dailyCapacityMinutes was here until 2026-08-26. Removing the input
        // without removing this would leave a live write endpoint for a
        // setting the product no longer has, which is precisely what
        // check:dead-machinery exists to catch.
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const patch: Record<string, boolean | number | null> = {};
    // Flipping the field-worker flag is a deliberate override: mark it so the
    // idempotent role-based reconciliation (migration 20260717220000) never
    // clobbers a working owner flagged in, or a tech flagged out.
    if (data.isFieldTech !== undefined) {
      patch.is_field_tech = data.isFieldTech;
      patch.is_field_tech_overridden = true;
    }
    if (data.routingAvailable !== undefined) patch.routing_available = data.routingAvailable;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await (context.supabase.from("staff") as any)
      .update(patch)
      .eq("id", data.staffId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listStaffAddresses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await (context.supabase.from("staff") as any)
      .select(
        "id, display_name, role, active, is_field_tech, is_field_tech_overridden, routing_available, start_address, start_latitude, start_longitude, end_address, end_latitude, end_longitude",
      )
      .eq("organization_id", orgId)
      .order("display_name");
    if (error) throw new Error(error.message);
    return { staff: data ?? [] };
  });

export const setStaffAddresses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        startAddress: z.string().max(300).nullable().optional(),
        startLatitude: z.number().min(-90).max(90).nullable().optional(),
        startLongitude: z.number().min(-180).max(180).nullable().optional(),
        endAddress: z.string().max(300).nullable().optional(),
        endLatitude: z.number().min(-90).max(90).nullable().optional(),
        endLongitude: z.number().min(-180).max(180).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    // Editing a staff member's start/end routing addresses is a user-management
    // action, matching sibling setStaffRouting — not dispatcher-reachable (I7).
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const patch: Record<string, any> = {};
    if (data.startAddress !== undefined) patch.start_address = data.startAddress || null;
    if (data.startLatitude !== undefined) patch.start_latitude = data.startLatitude;
    if (data.startLongitude !== undefined) patch.start_longitude = data.startLongitude;
    if (data.endAddress !== undefined) patch.end_address = data.endAddress || null;
    if (data.endLatitude !== undefined) patch.end_latitude = data.endLatitude;
    if (data.endLongitude !== undefined) patch.end_longitude = data.endLongitude;
    const { error } = await context.supabase
      .from("staff")
      .update(patch as any)
      .eq("id", data.staffId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ── Time off ──────────────────────────────────────────────────────────────
//
// `routing_available` is a same-day boolean with no end date, so it answered
// "out sick today" and nothing else. Leave with dates is a different fact:
// it has an end, the board can read it per day, and nobody has to remember to
// switch it back. Enforcement is a trigger on `visits` (migration
// 20260804230000), so these functions only have to read and write rows —
// they cannot be the thing that lets a bad assignment through.

export const listTimeOff = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ from: z.string().optional(), to: z.string().optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    let q = (context.supabase.from("staff_time_off") as any)
      .select("id, staff_id, starts_on, ends_on, reason")
      .eq("organization_id", orgId);
    // Overlap, not containment: a fortnight of leave straddling the week you
    // are looking at still makes that week unavailable, and `starts_on >= from`
    // would miss it entirely.
    if (data.to) q = q.lte("starts_on", data.to);
    if (data.from) q = q.gte("ends_on", data.from);
    const { data: rows, error } = await q.order("starts_on");
    if (error) throw new Error(error.message);
    return { timeOff: rows ?? [] };
  });

/** What a proposed absence would strand, asked BEFORE it is saved. */
export const previewTimeOff = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ staffId: z.string().uuid(), from: z.string(), to: z.string() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await resolveOrgId(context.supabase, context.userId);
    const { data: rows, error } = await (context.supabase as any).rpc("staff_time_off_impact", {
      _staff_id: data.staffId,
      _from: data.from,
      _to: data.to,
    });
    if (error) throw new Error(error.message);
    const days = (rows ?? []) as Array<{ scheduled_on: string; visits: number }>;
    return { days, total: days.reduce((n, d) => n + Number(d.visits), 0) };
  });

export const addTimeOff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        startsOn: z.string(),
        endsOn: z.string(),
        reason: z.string().max(200).optional(),
      })
      // Caught here as well as by the CHECK constraint: a range typed backwards
      // is a slip, and "new row violates check constraint
      // staff_time_off_range" is not something to show a dispatcher.
      .refine((v) => v.endsOn >= v.startsOn, {
        message: "The last day off cannot be before the first.",
        path: ["endsOn"],
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    // Same-org check on the staff row. RLS covers the insert, but without this
    // a valid uuid from another tenant would fail as a policy error rather
    // than as "that person isn't on your team".
    const { data: who } = await (context.supabase.from("staff") as any)
      .select("id")
      .eq("id", data.staffId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!who) throw new Error("That person is not on your team.");

    const { data: row, error } = await (context.supabase.from("staff_time_off") as any)
      .insert({
        organization_id: orgId,
        staff_id: data.staffId,
        starts_on: data.startsOn,
        ends_on: data.endsOn,
        reason: data.reason || null,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    // Deliberately does NOT move existing work. Recording leave and silently
    // reassigning forty visits are different decisions; Cover is where the
    // second one happens, with the list shown first.
    return { ok: true, id: row.id };
  });

export const removeTimeOff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const { error } = await (context.supabase.from("staff_time_off") as any)
      .delete()
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
