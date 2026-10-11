import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// Owner-facing inbox for client-submitted portal concerns (QA finding #14).
// Concerns are stored in qc_tickets; before this they surfaced only as a
// dashboard banner that linked to the unrelated /messages SMS inbox, with no
// way to read, triage, or resolve them.

export const CONCERN_STATUSES = ["open", "in_progress", "resolved"] as const;
export type ConcernStatus = (typeof CONCERN_STATUSES)[number];

// ── "In progress" is spelled `acknowledged` in the table ─────────────────────
//
// qc_tickets_status_check has allowed exactly open / acknowledged / resolved
// since the table was created (20260702162216). This file wrote
// 'in_progress', so "Mark in progress" failed the CHECK, the reply path's
// silent `open → in_progress` bump never landed, the "In progress" filter
// could never match a row, and a ticket the demo seed wrote as 'acknowledged'
// rendered with a blank status badge. Found while giving re-clean requests an
// "acknowledged once booked" state, which would have inherited all four.
//
// The inbox keeps its word for it; the translation happens here, at the only
// place that reads and writes the column for the inbox.
export function concernStatusToDb(s: ConcernStatus): string {
  return s === "in_progress" ? "acknowledged" : s;
}
export function concernStatusFromDb(s: string): ConcernStatus {
  return s === "acknowledged" || s === "in_progress"
    ? "in_progress"
    : s === "resolved"
      ? "resolved"
      : "open";
}

export const CONCERN_CATEGORY_LABELS: Record<string, string> = {
  missed_spot: "Missed spot",
  gate_left_open: "Gate left open",
  damage: "Property damage",
  wrong_yard: "Wrong yard",
  other: "Other",
  reclean_request: "Re-clean request",
  one_off_request: "Extra visit request",
};

export const listConcerns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ status: z.enum(["all", ...CONCERN_STATUSES]).default("all") })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "view_client_directory");
    let q = context.supabase
      .from("qc_tickets")
      .select(
        // Two foreign keys to visits now (the visit complained about, and the
        // free re-clean booked for it), so each embed names its constraint;
        // an unnamed `visits(...)` would be ambiguous and PostgREST refuses it.
        "id, category, message, status, created_at, resolved_at, resolution_note, last_reply, last_reply_at, client_id, visit_id, reclean_visit_id, clients(display_name, primary_phone, primary_email, account_type), visit:visits!qc_tickets_visit_id_fkey(scheduled_on, property_id, assigned_staff_id), reclean_visit:visits!qc_tickets_reclean_visit_id_fkey(scheduled_on, status), requested_on, property_id, booked_visit_id, property:properties!qc_tickets_property_id_fkey(street, city, dogs(active)), booked_visit:visits!qc_tickets_booked_visit_id_fkey(scheduled_on, status), requested_via, service_id, service:services(id, name, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min)",
      )
      .eq("organization_id", orgId)
      // Unresolved first, then newest.
      .order("resolved_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.status !== "all") q = q.eq("status", concernStatusToDb(data.status));
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const concerns = (rows ?? []).map((r) => ({
      ...r,
      status: concernStatusFromDb((r as { status: string }).status),
    }));
    const counts = { open: 0, in_progress: 0, resolved: 0 };
    for (const r of concerns) counts[r.status] += 1;
    return { concerns, counts };
  });

/**
 * Tie a booked re-clean visit to the request it answers, and mark the request
 * acknowledged ("In progress" in the inbox): the office has acted, the
 * customer's request is not finished until the re-clean is done.
 *
 * The visit itself is booked by createOneOffVisit, the same server function
 * behind "Book a one-off visit", at $0. This only links. It checks what a link
 * could get wrong: the ticket is a re-clean request in the caller's org, and
 * the visit is in the same org and for the same client. The update goes
 * through the caller's RLS-scoped client, like every other write here.
 */
export const linkRecleanVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ ticketId: z.string().uuid(), visitId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "view_client_directory");
    const { data: ticket, error: tErr } = await context.supabase
      .from("qc_tickets")
      .select("id, category, client_id, status")
      .eq("id", data.ticketId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    if (!ticket) throw new Error("That request isn't in your organization.");
    if (ticket.category !== "reclean_request")
      throw new Error("Only a re-clean request can have a re-clean booked against it.");

    const { data: visit, error: vErr } = await context.supabase
      .from("visits")
      .select("id, client_id, organization_id, scheduled_on")
      .eq("id", data.visitId)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!visit || visit.organization_id !== orgId)
      throw new Error("That visit isn't in your organization.");
    if (visit.client_id !== ticket.client_id)
      throw new Error("That visit is for a different client than the request.");

    const patch: Record<string, unknown> = { reclean_visit_id: data.visitId };
    // A resolved ticket stays resolved; anything else is now being handled.
    if (ticket.status !== "resolved") patch.status = concernStatusToDb("in_progress");
    const { data: updated, error } = await context.supabase
      .from("qc_tickets")
      .update(patch as any)
      .eq("id", data.ticketId)
      .eq("organization_id", orgId)
      .select("id");
    if (error) throw new Error(error.message);
    // An UPDATE that matched nothing is a success to Postgres; see
    // org-write.server.ts for why that is not allowed to read as one here.
    if (!updated || updated.length === 0)
      throw new Error("The re-clean was booked, but it couldn't be linked to the request.");
    return { ok: true, scheduledOn: visit.scheduled_on as string };
  });

/**
 * Tie a booked visit to the customer's extra-cleanup request, and resolve the
 * request: unlike a re-clean, there is nothing left to do once it is on the
 * schedule, and the portal shows the customer "Booked for <day>".
 *
 * The visit is booked by createOneOffVisit first, exactly as "Book a one-off
 * visit" books one; this only links. It checks what a link could get wrong:
 * the ticket is an extra-cleanup request in the caller's org, and the visit is
 * in the same org, for the same client, at the same property.
 */
export const linkOneOffBooking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ ticketId: z.string().uuid(), visitId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "view_client_directory");
    const { data: ticket, error: tErr } = await (context.supabase.from("qc_tickets") as any)
      .select("id, category, client_id, property_id, booked_visit_id")
      .eq("id", data.ticketId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    if (!ticket) throw new Error("That request isn't in your organization.");
    if (ticket.category !== "one_off_request")
      throw new Error("Only an extra-cleanup request can have a booking linked to it.");
    if (ticket.booked_visit_id && ticket.booked_visit_id !== data.visitId)
      throw new Error("This request already has a visit booked for it.");

    const { data: visit, error: vErr } = await context.supabase
      .from("visits")
      .select("id, client_id, property_id, organization_id, scheduled_on")
      .eq("id", data.visitId)
      .maybeSingle();
    if (vErr) throw new Error(vErr.message);
    if (!visit || visit.organization_id !== orgId)
      throw new Error("That visit isn't in your organization.");
    if (visit.client_id !== ticket.client_id)
      throw new Error("That visit is for a different client than the request.");
    if (ticket.property_id && visit.property_id !== ticket.property_id)
      throw new Error("That visit is at a different address than the request.");

    const { formatDay } = await import("@/lib/format");
    const { data: updated, error } = await (context.supabase.from("qc_tickets") as any)
      .update({
        booked_visit_id: data.visitId,
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolved_by: context.userId,
        resolution_note: `Booked for ${formatDay(visit.scheduled_on as string)}.`,
      })
      .eq("id", data.ticketId)
      .eq("organization_id", orgId)
      .select("id");
    if (error) throw new Error(error.message);
    // An UPDATE that matched nothing is a success to Postgres; see
    // org-write.server.ts for why that is not allowed to read as one here.
    if (!updated || updated.length === 0)
      throw new Error("The visit was booked, but it couldn't be linked to the request.");
    return { ok: true, scheduledOn: visit.scheduled_on as string };
  });

/** Reply to the client who submitted a concern (#14). Sends the reply by email
 *  and records it on the ticket so the inbox shows it was answered. */
export const replyToConcern = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ ticketId: z.string().uuid(), message: z.string().trim().min(1).max(4000) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "view_client_directory");
    const { data: ticket, error: tErr } = await context.supabase
      .from("qc_tickets")
      .select("id, status, client_id, clients(display_name, primary_email, comms_paused)")
      .eq("id", data.ticketId)
      .eq("organization_id", orgId)
      .single();
    if (tErr) throw new Error(tErr.message);
    const client = Array.isArray((ticket as any).clients) ? (ticket as any).clients[0] : (ticket as any).clients;
    const email = (client?.primary_email ?? "").trim();
    if (!email) throw new Error("This client has no email on file to reply to.");

    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) throw new Error("Email isn't configured (RESEND_API_KEY).");
    const { data: org } = await context.supabase.from("organizations").select("name").eq("id", orgId).maybeSingle();
    const orgName = (org as any)?.name ?? "Your service";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${orgName} <noreply@notify.houndstack.com>`,
        to: [email],
        subject: `Re: your message to ${orgName}`,
        html: `<p>Hi ${client?.display_name ?? "there"},</p><p>${data.message.replace(/\n/g, "<br>")}</p><p>- ${orgName}</p>`,
        text: `Hi ${client?.display_name ?? "there"},\n\n${data.message}\n\n- ${orgName}`,
      }),
    });
    if (!res.ok) {
      const b = await res.text().catch(() => "");
      throw new Error(`Couldn't send the reply email${b ? `: ${b.slice(0, 140)}` : ""}`);
    }

    const patch: Record<string, unknown> = {
      last_reply: data.message,
      last_reply_at: new Date().toISOString(),
    };
    // Answering an untouched concern moves it into progress.
    if ((ticket as any).status === "open") patch.status = concernStatusToDb("in_progress");
    await context.supabase.from("qc_tickets").update(patch as any).eq("id", data.ticketId).eq("organization_id", orgId);
    // Replying to a concern is an explicit manual send — lift the imported
    // comms hold now that the org has initiated contact.
    if (client?.comms_paused && (ticket as any).client_id) {
      await context.supabase
        .from("clients")
        .update({ comms_paused: false })
        .eq("id", (ticket as any).client_id);
    }
    return { ok: true, recipient: email };
  });

export const updateConcernStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        ticketId: z.string().uuid(),
        status: z.enum(CONCERN_STATUSES),
        resolutionNote: z.string().trim().max(2000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "view_client_directory");
    const patch: Record<string, unknown> = { status: concernStatusToDb(data.status) };
    if (data.status === "resolved") {
      patch.resolved_at = new Date().toISOString();
      patch.resolved_by = context.userId;
      if (data.resolutionNote) patch.resolution_note = data.resolutionNote;
    } else {
      // Reopening / moving back to in-progress clears the resolution stamp.
      patch.resolved_at = null;
      patch.resolved_by = null;
    }
    const { error } = await context.supabase
      .from("qc_tickets")
      .update(patch as any)
      .eq("id", data.ticketId)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
