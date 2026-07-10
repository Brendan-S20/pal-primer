import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");
  return data.organization_id as string;
}

export const listOrgUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await context.supabase.rpc("list_org_users", { _org_id: orgId });
    if (error) throw new Error(error.message);
    return { users: data ?? [] };
  });

const roleEnum = z.enum(["owner", "office_manager", "dispatcher", "tech"]);

export const changeUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ userId: z.string().uuid(), role: roleEnum }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { error } = await context.supabase.rpc("change_user_role", {
      _org_id: orgId,
      _user_id: data.userId,
      _new_role: data.role,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setStaffActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ staffId: z.string().uuid(), active: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("set_staff_active", {
      _staff_id: data.staffId,
      _active: data.active,
    });
    if (error) throw new Error(error.message);
    // Activating/deactivating an employee changes the billable seat count —
    // reconcile the Stripe seat-overage quantity (best-effort; never blocks the
    // toggle if billing isn't configured or Stripe hiccups).
    try {
      const orgId = await resolveOrgId(context.supabase, context.userId);
      const { syncOrgSeatQuantity } = await import("@/lib/seat-sync.server");
      await syncOrgSeatQuantity(orgId);
    } catch (e) {
      console.error("seat sync after set_staff_active failed", (e as Error).message);
    }
    return { ok: true };
  });

// Reconcile the caller org's Stripe seat-overage quantity to its current active
// employee count. Called after invite acceptance (a new employee just joined)
// so billing catches up without waiting for the next staff toggle. Best-effort:
// returns { ok: true } even when there's nothing to sync.
export const resyncMySeats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    try {
      const orgId = await resolveOrgId(context.supabase, context.userId);
      const { syncOrgSeatQuantity } = await import("@/lib/seat-sync.server");
      await syncOrgSeatQuantity(orgId);
    } catch (e) {
      console.error("resyncMySeats failed", (e as Error).message);
    }
    return { ok: true };
  });

// ── Teammate invites (finding #40) ───────────────────────────────────────────
const inviteRoleEnum = z.enum(["office_manager", "dispatcher", "tech"]);

export const createOrgInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ email: z.string().trim().email().max(255), role: inviteRoleEnum }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const email = data.email.toLowerCase();
    const crypto = await import("node:crypto");
    const token = crypto.randomBytes(24).toString("hex");

    // Supersede any existing pending invite for this email in this org.
    await (context.supabase as any).from("org_invites")
      .update({ status: "revoked" })
      .eq("organization_id", orgId)
      .eq("email", email)
      .eq("status", "pending");

    const { data: row, error } = await (context.supabase as any).from("org_invites")
      .insert({ organization_id: orgId, email, role: data.role, token, invited_by: context.userId })
      .select("id, token")
      .single();
    if (error) throw new Error(error.message);

    // Best-effort invite email (Resend). The pending row + link work regardless.
    try {
      const resendApiKey = process.env.RESEND_API_KEY;
      const { data: org } = await context.supabase.from("organizations").select("name").eq("id", orgId).maybeSingle();
      if (resendApiKey) {
        const link = `https://www.app.houndstack.com/auth`;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: `${(org as any)?.name ?? "HoundStack"} <noreply@notify.houndstack.com>`,
            to: [email],
            subject: `You've been invited to join ${(org as any)?.name ?? "the team"}`,
            html: `<p>You've been invited to join <strong>${(org as any)?.name ?? "the team"}</strong> on HoundStack as ${data.role.replace(/_/g, " ")}.</p>` +
              `<p>Create your account (or sign in) with <strong>${email}</strong> here: <a href="${link}">${link}</a>. Your role is assigned automatically on first sign-in.</p>`,
            text: `You've been invited to join ${(org as any)?.name ?? "the team"} on HoundStack. Sign up with ${email} at ${link}.`,
          }),
        });
      }
    } catch (e) {
      console.error("invite email failed", (e as Error).message);
    }
    return { id: row.id as string };
  });

export const listOrgInvites = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const { data, error } = await (context.supabase as any).from("org_invites")
      .select("id, email, role, status, created_at, expires_at, accepted_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return { invites: data ?? [] };
  });

export const revokeOrgInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const { error } = await (context.supabase as any).from("org_invites")
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
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const patch: Record<string, boolean> = {};
    if (data.isFieldTech !== undefined) patch.is_field_tech = data.isFieldTech;
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
      .select("id, display_name, role, active, is_field_tech, routing_available, start_address, start_latitude, start_longitude, end_address, end_latitude, end_longitude")
      .eq("organization_id", orgId)
      .order("display_name");
    if (error) throw new Error(error.message);
    return { staff: data ?? [] };
  });

export const setStaffAddresses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      staffId: z.string().uuid(),
      startAddress: z.string().max(300).nullable().optional(),
      startLatitude: z.number().min(-90).max(90).nullable().optional(),
      startLongitude: z.number().min(-180).max(180).nullable().optional(),
      endAddress: z.string().max(300).nullable().optional(),
      endLatitude: z.number().min(-90).max(90).nullable().optional(),
      endLongitude: z.number().min(-180).max(180).nullable().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
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
