import { SERVICE_LINES } from "@/lib/service-lines";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  return (await resolveCaller(supabase, userId)).orgId;
}

/** Default per-charge ceiling for field-billed add-ons when the org hasn't set one. */
export const DEFAULT_FIELD_ADDON_CAP_CENTS = 20000;

const FREQ = ["weekly", "biweekly", "monthly", "quarterly", "yearly"] as const;
const KIND = ["one_time", "recurring"] as const;

export const listAddonServices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ includeInactive: z.boolean().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    let q = context.supabase
      .from("addon_services")
      .select("*")
      .eq("organization_id", orgId)
      .order("name");
    if (!data.includeInactive) q = q.eq("active", true);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { services: rows ?? [] };
  });

export const upsertAddonService = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid().optional(),
        code: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        description: z.string().max(500).optional().nullable(),
        kind: z.enum(KIND).default("one_time"),
        unit_price_cents: z.number().int().min(0),
        default_frequency: z.enum(FREQ).optional().nullable(),
        durationMin: z.number().int().min(0).max(480).optional(),
        // Every add-on names its line (#640); there is no "any service".
        serviceLine: z.enum(SERVICE_LINES).optional(),
        taxable: z.boolean().optional(),
        active: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_client_billing",
    );
    const payload: any = {
      organization_id: orgId,
      code: data.code,
      name: data.name,
      description: data.description ?? null,
      kind: data.kind,
      unit_price_cents: data.unit_price_cents,
      default_frequency: data.default_frequency ?? null,
      taxable: data.taxable ?? false,
      active: data.active ?? true,
      updated_at: new Date().toISOString(),
    };
    if (data.durationMin !== undefined) payload.duration_min = data.durationMin;
    if (data.serviceLine !== undefined) payload.service_line = data.serviceLine;
    if (data.id) {
      const { error } = await context.supabase
        .from("addon_services")
        .update(payload)
        .eq("id", data.id)
        .eq("organization_id", orgId);
      if (error) throw new Error(error.message);
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("addon_services")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row!.id as string };
  });

export const listClientAddons = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const [charges, subs] = await Promise.all([
      context.supabase
        .from("addon_charges")
        // `invoice_line_item_id` has been written since add-on billing shipped
        // and followed by nothing, so a charge could say it had been billed and
        // not say WHERE. Following it here turns "invoiced" into an invoice
        // someone can open. One to-one FK hop, the same shape as the
        // addon_services embed above, and covered by the same billing
        // permission this handler already required.
        .select("*, addon_services(name), invoice_line_items(invoice_id)")
        .eq("client_id", data.clientId)
        .order("occurred_on", { ascending: false })
        .limit(100),
      context.supabase
        .from("addon_subscriptions")
        .select("*, addon_services(name)")
        .eq("client_id", data.clientId)
        .order("created_at", { ascending: false }),
    ]);
    if (charges.error) throw new Error(charges.error.message);
    if (subs.error) throw new Error(subs.error.message);

    // Flattened here rather than in the component: PostgREST returns an object
    // for a to-one embed and an array for a to-many, and a UI guessing at that
    // is how a link silently stops resolving.
    const rows = (charges.data ?? []).map((c: any) => {
      const li = Array.isArray(c.invoice_line_items)
        ? c.invoice_line_items[0]
        : c.invoice_line_items;
      return { ...c, billed_invoice_id: (li?.invoice_id as string | undefined) ?? null };
    });

    // Whether that invoice was actually PAID is the second half of "was this
    // add-on ever billed" — a charge sitting on an invoice nobody paid is not
    // the same answer as one that settled. Second query rather than a nested
    // embed: one FK hop is the pattern used everywhere else in this file.
    const invoiceIds = [...new Set(rows.map((r: any) => r.billed_invoice_id).filter(Boolean))];
    const statuses = new Map<string, string>();
    // The stored number too, so the trail reads "INV-1042" like every other
    // screen, the PDF and the email, not a fragment of the id.
    const numbers = new Map<string, number | null>();
    if (invoiceIds.length) {
      const { data: invs } = await context.supabase
        .from("invoices")
        .select("id, number, status")
        .in("id", invoiceIds as string[]);
      for (const i of invs ?? []) {
        statuses.set(i.id as string, i.status as string);
        numbers.set(i.id as string, (i.number as number | null) ?? null);
      }
    }

    const withInvoice = rows.map((r: any) => ({
      ...r,
      billed_invoice_status: r.billed_invoice_id
        ? (statuses.get(r.billed_invoice_id) ?? null)
        : null,
      billed_invoice_number: r.billed_invoice_id
        ? (numbers.get(r.billed_invoice_id) ?? null)
        : null,
    }));

    return { charges: withInvoice, subscriptions: subs.data ?? [] };
  });

export const createAddonCharge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        addonServiceId: z.string().uuid(),
        quantity: z.number().int().min(1).max(999).default(1),
        unitPriceCents: z.number().int().min(0).optional(),
        description: z.string().max(200).optional(),
        visitId: z.string().uuid().optional(),
        source: z.enum(["office", "field"]).default("office"),
        note: z.string().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    let unitPriceCents = data.unitPriceCents;

    if (data.source === "field") {
      // Field billing is the capped, confirmed technician flow: catalog price
      // only, tied to one of the caller's own visits, total under the org cap.
      const { orgId } = await requirePermission(supabase, userId, "record_field_addons");

      if (!data.visitId) throw new Error("Field add-ons must be billed from a visit");
      const { data: visit, error: vErr } = await supabase
        .from("visits")
        .select("id, client_id, staff:assigned_staff_id(user_id)")
        .eq("id", data.visitId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (vErr) throw new Error(vErr.message);
      if (!visit) throw new Error("Visit not found");
      if (visit.client_id !== data.clientId)
        throw new Error("Visit does not belong to this client");
      if ((visit as any).staff?.user_id !== userId) {
        // Office roles may still field-bill on a tech's behalf.
        await requirePermission(supabase, userId, "manage_client_billing");
      }

      const [{ data: svc, error: sErr }, { data: org, error: oErr }] = await Promise.all([
        supabase
          .from("addon_services")
          .select("unit_price_cents")
          .eq("id", data.addonServiceId)
          .eq("organization_id", orgId)
          .maybeSingle(),
        supabase.from("organizations").select("field_addon_cap_cents").eq("id", orgId).single(),
      ]);
      if (sErr) throw new Error(sErr.message);
      if (!svc) throw new Error("Add-on service not found");
      if (oErr) throw new Error(oErr.message);

      unitPriceCents = undefined; // field source always bills the catalog price
      const capCents = org?.field_addon_cap_cents ?? DEFAULT_FIELD_ADDON_CAP_CENTS;
      const totalCents = svc.unit_price_cents * Math.max(1, data.quantity);
      if (totalCents > capCents) {
        throw new Error(
          `Field add-ons are capped at $${(capCents / 100).toFixed(2)} per charge. Ask the office to bill this one`,
        );
      }
    } else {
      await requirePermission(supabase, userId, "manage_client_billing");
    }

    const { data: id, error } = await supabase.rpc("create_addon_charge", {
      _client_id: data.clientId,
      _addon_service_id: data.addonServiceId,
      _quantity: data.quantity,
      _unit_price_cents: unitPriceCents ?? undefined,
      _description: data.description ?? undefined,
      _visit_id: data.visitId ?? undefined,
      _source: data.source,
      _note: data.note ?? undefined,
    });
    if (error) throw new Error(error.message);
    return { id: id as string };
  });

export const voidAddonCharge = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ chargeId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const { error } = await context.supabase.rpc("void_addon_charge", {
      _charge_id: data.chargeId,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const createAddonSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        addonServiceId: z.string().uuid(),
        frequency: z.enum(FREQ),
        priceCents: z.number().int().min(0),
        quantity: z.number().int().min(1).default(1),
        startedOn: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_client_billing",
    );
    const started = data.startedOn ?? new Date().toISOString().slice(0, 10);
    const { data: row, error } = await context.supabase
      .from("addon_subscriptions")
      .insert({
        organization_id: orgId,
        client_id: data.clientId,
        addon_service_id: data.addonServiceId,
        frequency: data.frequency,
        price_cents: data.priceCents,
        quantity: data.quantity,
        started_on: started,
        next_charge_on: started,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row!.id as string };
  });

export const setAddonSubscriptionStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        status: z.enum(["active", "paused", "canceled"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    // Was a bare table UPDATE writing `status` and nothing else. Pausing left
    // `next_charge_on` where it was, so resuming five months later handed the
    // nightly generator five months of arrears to bill in one night — for a
    // period during which the customer received nothing.
    //
    // The roll-forward has to happen in the same statement as the status
    // change or there is a window where one is done and the other isn't, and
    // it needs the cadence table, which lives in SQL. Both are inside
    // set_addon_subscription_status, which re-checks the permission itself.
    const { data: raw, error } = await context.supabase.rpc("set_addon_subscription_status", {
      _id: data.id,
      _status: data.status,
    });
    if (error) throw new Error(error.message);
    // The function returns jsonb, which the generated types widen to Json.
    // Narrowed to the shape it actually builds rather than cast to any.
    const r = (raw ?? {}) as { next_charge_on?: string | null; skipped_periods?: number };
    return {
      ok: true,
      nextChargeOn: r.next_charge_on ?? null,
      /** Periods that elapsed while this was paused. Nonzero means the resume
       *  skipped them rather than billing for them. */
      skippedPeriods: Number(r.skipped_periods ?? 0),
    };
  });

// ── Client portal add-on requests (QA round 8) ──────────────────────────────
// Staff-added add-ons are live immediately (one-time charges are simply
// unbilled until the next invoice; recurring subscriptions start at once).
// Portal requests land in addon_requests as 'pending' and need a staff
// decision before anything becomes billable.

export const listAddonRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const { data: rows, error } = await (context.supabase as any)
      .from("addon_requests")
      .select(
        "id, client_id, addon_service_id, property_id, kind, frequency, quantity, unit_price_cents, status, created_at, addon_services(name), properties(street)",
      )
      .eq("client_id", data.clientId)
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { requests: rows ?? [] };
  });

async function loadPendingRequest(supabase: any, requestId: string) {
  const { data: req, error } = await (supabase as any)
    .from("addon_requests")
    .select("*, addon_services(name)")
    .eq("id", requestId)
    .single();
  if (error) throw new Error(error.message);
  if (req.status !== "pending") throw new Error("This request was already decided");
  return req;
}

export const approveAddonRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ requestId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "manage_client_billing");
    const req = await loadPendingRequest(supabase, data.requestId);
    const name = req.addon_services?.name ?? "Add-on";

    // Claim FIRST: two concurrent approvals (double-click, two staff) must
    // not both create the billable object. The status flip is the atomic
    // gate; whoever matches zero rows lost the race and stops here.
    const { data: claimed, error: claimErr } = await (supabase as any)
      .from("addon_requests")
      .update({ status: "approved", decided_by: userId, decided_at: new Date().toISOString() })
      .eq("id", data.requestId)
      .eq("status", "pending")
      .select("id");
    if (claimErr) throw new Error(claimErr.message);
    if (!claimed || claimed.length === 0) throw new Error("This request was already decided");

    const revertClaim = async () => {
      await (supabase as any)
        .from("addon_requests")
        .update({ status: "pending", decided_by: null, decided_at: null })
        .eq("id", data.requestId);
    };

    if (req.kind === "one_time") {
      // create_addon_charge handles prepaid credit; price is the snapshot the
      // client saw when requesting.
      const { data: chargeId, error } = await supabase.rpc("create_addon_charge", {
        _client_id: req.client_id,
        _addon_service_id: req.addon_service_id,
        _quantity: req.quantity,
        _unit_price_cents: req.unit_price_cents,
        _description: name,
        _visit_id: undefined,
        _source: "office",
        _note: "Approved client portal request",
      });
      if (error) {
        await revertClaim();
        throw new Error(error.message);
      }
      if (req.property_id) {
        await (supabase as any)
          .from("addon_charges")
          .update({ property_id: req.property_id })
          .eq("id", chargeId);
      }
    } else {
      const started = new Date().toISOString().slice(0, 10);
      const { error } = await (supabase as any).from("addon_subscriptions").insert({
        organization_id: req.organization_id,
        client_id: req.client_id,
        addon_service_id: req.addon_service_id,
        property_id: req.property_id,
        frequency: req.frequency,
        price_cents: req.unit_price_cents,
        quantity: req.quantity,
        started_on: started,
        next_charge_on: started,
      });
      if (error) {
        await revertClaim();
        throw new Error(error.message);
      }
    }

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: req.organization_id,
      clientId: req.client_id,
      actorUserId: userId,
      kind: "addon.request_approved",
      summary: `Approved the client's ${name} request${req.kind === "recurring" ? ` (${req.frequency})` : ""}`,
      meta: { request_id: req.id, kind: req.kind },
    });
    return { ok: true };
  });

export const declineAddonRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ requestId: z.string().uuid(), reason: z.string().max(500).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requirePermission(supabase, userId, "manage_client_billing");
    const req = await loadPendingRequest(supabase, data.requestId);
    const { error } = await (supabase as any)
      .from("addon_requests")
      .update({
        status: "declined",
        decided_by: userId,
        decided_at: new Date().toISOString(),
        decline_reason: data.reason?.trim() || null,
      })
      .eq("id", data.requestId)
      .eq("status", "pending");
    if (error) throw new Error(error.message);

    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: req.organization_id,
      clientId: req.client_id,
      actorUserId: userId,
      kind: "addon.request_declined",
      summary: `Declined the client's ${req.addon_services?.name ?? "add-on"} request${data.reason?.trim() ? `: ${data.reason.trim()}` : ""}`,
      meta: { request_id: req.id },
    });
    return { ok: true };
  });

