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

export const CONCERN_CATEGORY_LABELS: Record<string, string> = {
  missed_spot: "Missed spot",
  gate_left_open: "Gate left open",
  damage: "Property damage",
  wrong_yard: "Wrong yard",
  other: "Other",
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
        "id, category, message, status, created_at, resolved_at, resolution_note, last_reply, last_reply_at, client_id, visit_id, clients(display_name, primary_phone, primary_email)",
      )
      .eq("organization_id", orgId)
      // Unresolved first, then newest.
      .order("resolved_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.status !== "all") q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const counts = { open: 0, in_progress: 0, resolved: 0 };
    for (const r of rows ?? []) {
      const s = (r as any).status as ConcernStatus;
      if (s in counts) counts[s] += 1;
    }
    return { concerns: rows ?? [], counts };
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
      .select("id, status, clients(display_name, primary_email)")
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
    if ((ticket as any).status === "open") patch.status = "in_progress";
    await context.supabase.from("qc_tickets").update(patch as any).eq("id", data.ticketId).eq("organization_id", orgId);
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
    const patch: Record<string, unknown> = { status: data.status };
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
