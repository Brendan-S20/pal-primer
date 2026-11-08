// The office's half of portal reschedules and cancels (#730, decision D6):
// the owner's setting, and the owner's approval queue.
//
// Every write asks for an OWNER here, before any RPC, and the database asks
// again (set_portal_change_settings, decide_portal_change_request and the
// organizations trigger in 20261108153700). The RPCs run on the CALLER's
// client, so the database sees who is asking; nothing here uses the service
// role to write a decision. The fee attempt after an approval does, because
// it is the server acting on a decision already recorded.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ONLY_AN_OWNER_CHANGES_PORTAL_POLICY,
  ONLY_AN_OWNER_DECIDES_PORTAL_CHANGES,
  PORTAL_CHANGE_POLICIES,
  type PortalChangePolicy,
  type PortalChangeRule,
} from "@/lib/portal-change";
import { SERVICE_LINES } from "@/lib/service-lines";

async function caller(supabase: unknown, userId: string) {
  const { resolveCaller } = await import("@/lib/authz.server");
  return resolveCaller(supabase, userId);
}

const ruleSchema = z.object({
  service_line: z.enum(SERVICE_LINES),
  cutoff_hours: z.number().int().min(0).max(336).nullable(),
  late_window_hours: z.number().int().min(0).max(336).nullable(),
  late_reschedule_fee_cents: z.number().int().min(0).max(100_000),
  late_cancel_fee_cents: z.number().int().min(0).max(100_000),
});

export const getPortalChangeSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId, role } = await caller(context.supabase, context.userId);
    const sb = context.supabase as any;
    const [{ data: org, error }, { data: rules }] = await Promise.all([
      sb
        .from("organizations")
        .select(
          "portal_change_policy, portal_change_fees_autocharge, portal_reschedule_cutoff_hours, service_lines",
        )
        .eq("id", orgId)
        .maybeSingle(),
      sb
        .from("portal_change_rules")
        .select(
          "service_line, cutoff_hours, late_window_hours, late_reschedule_fee_cents, late_cancel_fee_cents",
        )
        .eq("organization_id", orgId),
    ]);
    if (error) throw new Error(error.message);
    return {
      policy: (org?.portal_change_policy ?? "instant") as PortalChangePolicy,
      autocharge: !!org?.portal_change_fees_autocharge,
      defaultCutoffHours: Number(org?.portal_reschedule_cutoff_hours ?? 18),
      serviceLines: (org?.service_lines ?? null) as string[] | null,
      rules: (rules ?? []) as PortalChangeRule[],
      canEdit: role === "owner",
    };
  });

export const setPortalChangeSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        policy: z.enum(PORTAL_CHANGE_POLICIES).optional(),
        autocharge: z.boolean().optional(),
        rules: z.array(ruleSchema).max(SERVICE_LINES.length).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId, role } = await caller(context.supabase, context.userId);
    if (role !== "owner") throw new Error(ONLY_AN_OWNER_CHANGES_PORTAL_POLICY);
    const { error } = await (context.supabase as any).rpc("set_portal_change_settings", {
      _org: orgId,
      _policy: data.policy ?? null,
      _autocharge: data.autocharge ?? null,
      _rules: data.rules ?? null,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export type PortalChangeRequestRow = {
  id: string;
  kind: "reschedule" | "cancel";
  status: "pending" | "approved" | "denied" | "withdrawn" | "applied";
  policy: PortalChangePolicy;
  original_date: string;
  requested_date: string | null;
  reason: string | null;
  late: boolean;
  fee_cents: number;
  /** The fee the portal showed and the client accepted, or null when none. */
  fee_disclosed_cents: number | null;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
  client_id: string;
  visit_id: string;
  service_line: string;
  clients: { display_name: string | null } | null;
  portal_change_fee_charges?: Array<{
    status: string;
    not_charged_reason: string | null;
    failure_message: string | null;
  }>;
};

export const listPortalChangeRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ status: z.enum(["pending", "recent"]).default("pending") }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { orgId, role } = await caller(context.supabase, context.userId);
    // RLS decides who reads (view_client_directory); the org filter keeps the
    // query to the caller's own business either way.
    let q = (context.supabase as any)
      .from("portal_change_requests")
      .select(
        "id, kind, status, policy, original_date, requested_date, reason, late, fee_cents, fee_disclosed_cents, decision_note, decided_at, created_at, client_id, visit_id, service_line, clients(display_name)",
      )
      .eq("organization_id", orgId)
      .order("created_at", { ascending: data.status === "pending" })
      .limit(100);
    q = data.status === "pending" ? q.eq("status", "pending") : q.neq("status", "pending");
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as PortalChangeRequestRow[], canDecide: role === "owner" };
  });

export const decidePortalChangeRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        requestId: z.string().uuid(),
        approve: z.boolean(),
        note: z.string().max(500).optional().default(""),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId, role } = await caller(context.supabase, context.userId);
    if (role !== "owner") throw new Error(ONLY_AN_OWNER_DECIDES_PORTAL_CHANGES);

    // An approval moves or skips a visit, which can take a stop off a tech's
    // today or tomorrow: they hear it the way they hear a dispatcher's move.
    const sb = context.supabase as any;
    const { data: req } = await sb
      .from("portal_change_requests")
      .select("visit_id")
      .eq("id", data.requestId)
      .eq("organization_id", orgId)
      .maybeSingle();
    const visitIds = req?.visit_id ? [req.visit_id as string] : [];
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = data.approve
      ? await startRouteWatch({ actorUserId: context.userId, orgId, visitIds })
      : null;

    const { data: out, error } = await sb.rpc("decide_portal_change_request", {
      _request_id: data.requestId,
      _approve: data.approve,
      _note: data.note,
    });
    // A request about a day the office has since moved the visit off is
    // refused by the database (#730 review, finding 3); say it in words.
    if (error) throw new Error(error.message.replace(/^STALE_REQUEST: /, ""));
    const result = out as { status: string; fee_cents: number };
    if (watch) await watch.finish();

    // What happened to the fee, for the toast: none / not_charged / submitted
    // / failed / already_attempted. Never throws: the approval is recorded.
    let fee: { outcome: string } | null = null;
    if (data.approve && Number(result?.fee_cents) > 0) {
      const { chargePortalChangeFee } = await import("@/lib/portal-change-fees.server");
      fee = { outcome: (await chargePortalChangeFee(data.requestId)).outcome };
    }
    return { status: result.status, feeCents: Number(result?.fee_cents ?? 0), fee };
  });
