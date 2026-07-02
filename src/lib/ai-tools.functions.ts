import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { generateText, Output } from "ai";

const MODEL = "google/gemini-3-flash-preview";

function gateway() {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  return createLovableAiGatewayProvider(key);
}

async function callerOrg(context: { supabase: any; userId: string }) {
  const { data: staff, error } = await context.supabase
    .from("staff")
    .select("id, organization_id")
    .eq("user_id", context.userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!staff) throw new Error("No staff record for current user");
  return staff as { id: string; organization_id: string };
}

// ---------------- Marketing content ----------------

export const generateMarketingContent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        kind: z.enum(["facebook_post", "instagram_caption", "email_blast", "google_business_update", "flyer_headline"]),
        topic: z.string().trim().min(3).max(400),
        tone: z.enum(["friendly", "professional", "playful", "urgent"]).default("friendly"),
        includeCta: z.boolean().default(true),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const staff = await callerOrg(context);
    const { data: org } = await context.supabase
      .from("organizations")
      .select("name, slug, google_review_url")
      .eq("id", staff.organization_id)
      .single();

    const provider = gateway();
    const { output } = await generateText({
      model: provider(MODEL),
      output: Output.object({
        schema: z.object({
          title: z.string(),
          body: z.string(),
          hashtags: z.array(z.string()).max(8),
          cta: z.string(),
        }),
      }),
      prompt:
        `Write a ${data.kind.replace(/_/g, " ")} for a pet-waste removal company called "${org?.name ?? "our company"}".\n` +
        `Tone: ${data.tone}. Topic/angle: ${data.topic}.\n` +
        (data.includeCta ? `Include a short call to action.\n` : `No hard CTA.\n`) +
        `Keep it concise and specific to residential dog-waste cleanup. Avoid emoji spam.`,
    });
    return output;
  });

// ---------------- Review reply drafting ----------------

export const draftReviewReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        reviewText: z.string().trim().min(3).max(4000),
        rating: z.number().int().min(1).max(5),
        reviewerName: z.string().trim().max(120).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const staff = await callerOrg(context);
    const { data: org } = await context.supabase
      .from("organizations")
      .select("name")
      .eq("id", staff.organization_id)
      .single();

    const provider = gateway();
    const { output } = await generateText({
      model: provider(MODEL),
      output: Output.object({
        schema: z.object({
          reply: z.string(),
          notes: z.string(),
        }),
      }),
      prompt:
        `You are the owner of "${org?.name ?? "our pet waste business"}" replying publicly to a Google review.\n` +
        `Reviewer: ${data.reviewerName ?? "the customer"}. Rating: ${data.rating}/5.\n` +
        `Review text:\n"""${data.reviewText}"""\n\n` +
        `Write a warm, professional public reply (2-4 sentences). If the review is negative, acknowledge the specific concern, do not argue, and invite them to contact the office. If positive, thank them by name and mention a specific detail they raised. No emoji.\n` +
        `In "notes", flag any operational follow-up we should take internally (or "none").`,
    });
    return output;
  });

// ---------------- Churn scoring ----------------

interface ChurnSignals {
  client_id: string;
  display_name: string;
  tenure_days: number;
  days_since_last_visit: number | null;
  completed_last_30: number;
  skipped_last_30: number;
  unpaid_invoice_count: number;
  unpaid_total_cents: number;
  sms_opt_out: boolean;
}

async function gatherChurnSignals(supabase: any, organizationId: string, clientId?: string): Promise<ChurnSignals[]> {
  let q = supabase
    .from("clients")
    .select("id, display_name, created_at, sms_opt_out, status")
    .eq("organization_id", organizationId)
    .eq("status", "active");
  if (clientId) q = q.eq("id", clientId);
  const { data: clients, error } = await q.limit(500);
  if (error) throw new Error(error.message);
  if (!clients?.length) return [];

  const ids = clients.map((c: any) => c.id);
  const now = Date.now();
  const cutoff = new Date(now - 30 * 24 * 3600_000).toISOString();

  const [{ data: visits }, { data: invoices }] = await Promise.all([
    supabase
      .from("visits")
      .select("client_id, status, completed_at, scheduled_on")
      .in("client_id", ids)
      .gte("scheduled_on", cutoff.slice(0, 10)),
    supabase
      .from("invoices")
      .select("client_id, status, total_cents")
      .in("client_id", ids)
      .in("status", ["open", "uncollectible"]),
  ]);

  return clients.map((c: any) => {
    const cVisits = (visits ?? []).filter((v: any) => v.client_id === c.id);
    const completed = cVisits.filter((v: any) => v.status === "completed");
    const skipped = cVisits.filter((v: any) => v.status === "skipped");
    const lastCompleted = completed
      .map((v: any) => (v.completed_at ? new Date(v.completed_at).getTime() : 0))
      .reduce((a: number, b: number) => Math.max(a, b), 0);
    const cInvs = (invoices ?? []).filter((i: any) => i.client_id === c.id);
    return {
      client_id: c.id,
      display_name: c.display_name,
      tenure_days: Math.floor((now - new Date(c.created_at).getTime()) / 86400000),
      days_since_last_visit: lastCompleted ? Math.floor((now - lastCompleted) / 86400000) : null,
      completed_last_30: completed.length,
      skipped_last_30: skipped.length,
      unpaid_invoice_count: cInvs.length,
      unpaid_total_cents: cInvs.reduce((s: number, i: any) => s + (i.total_cents ?? 0), 0),
      sms_opt_out: !!c.sms_opt_out,
    };
  });
}

export const scoreChurn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ clientId: z.string().uuid().optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const staff = await callerOrg(context);
    const signals = await gatherChurnSignals(context.supabase, staff.organization_id, data.clientId);
    if (!signals.length) return { scored: 0 };

    const provider = gateway();
    const { output } = await generateText({
      model: provider(MODEL),
      output: Output.object({
        schema: z.object({
          scores: z.array(
            z.object({
              client_id: z.string(),
              score: z.number().int().min(0).max(100),
              reason: z.string(),
            }),
          ),
        }),
      }),
      prompt:
        `Score churn risk (0-100, higher = more likely to cancel soon) for these pet-waste-removal customers based on activity signals. ` +
        `Weigh unpaid invoices, high skip rate, long gap since last completed visit, and short tenure with skips. Return one short reason per client.\n\n` +
        `Signals JSON:\n${JSON.stringify(signals, null, 2)}`,
    });

    // Persist
    for (const s of output.scores) {
      await context.supabase
        .from("clients")
        .update({ churn_score: s.score, churn_reason: s.reason, churn_scored_at: new Date().toISOString() })
        .eq("id", s.client_id)
        .eq("organization_id", staff.organization_id);
    }
    return { scored: output.scores.length };
  });

export const listChurnRisk = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const staff = await callerOrg(context);
    const { data, error } = await context.supabase
      .from("clients")
      .select("id, display_name, churn_score, churn_reason, churn_scored_at")
      .eq("organization_id", staff.organization_id)
      .not("churn_score", "is", null)
      .order("churn_score", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

// ---------------- Weekly owner digest ----------------

export const generateWeeklyDigest = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const staff = await callerOrg(context);
    const orgId = staff.organization_id;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
    const weekAgoIso = weekAgo.toISOString();
    const weekAgoDate = weekAgoIso.slice(0, 10);

    const [
      { data: org },
      { data: visits },
      { data: invoices },
      { data: payments },
      { data: newClients },
      { data: leads },
      { data: churn },
    ] = await Promise.all([
      context.supabase.from("organizations").select("name").eq("id", orgId).single(),
      context.supabase
        .from("visits")
        .select("status, scheduled_on")
        .eq("organization_id", orgId)
        .gte("scheduled_on", weekAgoDate),
      context.supabase
        .from("invoices")
        .select("status, total_cents, issued_at")
        .eq("organization_id", orgId)
        .gte("issued_at", weekAgoIso),
      context.supabase
        .from("payments")
        .select("amount_cents, paid_at")
        .eq("organization_id", orgId)
        .gte("paid_at", weekAgoIso),
      context.supabase
        .from("clients")
        .select("id")
        .eq("organization_id", orgId)
        .gte("created_at", weekAgoIso),
      context.supabase
        .from("leads")
        .select("id, status")
        .gte("created_at", weekAgoIso),
      context.supabase
        .from("clients")
        .select("id, display_name, churn_score, churn_reason")
        .eq("organization_id", orgId)
        .gte("churn_score", 70)
        .order("churn_score", { ascending: false })
        .limit(10),
    ]);

    const completed = (visits ?? []).filter((v: any) => v.status === "completed").length;
    const skipped = (visits ?? []).filter((v: any) => v.status === "skipped").length;
    const scheduled = (visits ?? []).length;
    const revenueCollected = (payments ?? []).reduce((s: number, p: any) => s + (p.amount_cents ?? 0), 0);
    const revenueInvoiced = (invoices ?? []).reduce((s: number, i: any) => s + (i.total_cents ?? 0), 0);
    const openInvoices = (invoices ?? []).filter((i: any) => i.status === "open").length;

    const stats = {
      org: org?.name ?? "Your business",
      completed,
      skipped,
      scheduled,
      completion_rate: scheduled ? Math.round((completed / scheduled) * 100) : 0,
      revenue_collected_cents: revenueCollected,
      revenue_invoiced_cents: revenueInvoiced,
      open_invoices: openInvoices,
      new_clients: (newClients ?? []).length,
      new_leads: (leads ?? []).length,
      at_risk: churn ?? [],
    };

    const provider = gateway();
    const { text } = await generateText({
      model: provider(MODEL),
      prompt:
        `Write a concise weekly owner digest for a pet waste removal business. ` +
        `Use short section headings ("This week", "Money", "Growth", "Watch list") and plain prose bullet points. ` +
        `No emoji. End with 2-3 concrete recommended actions for the owner.\n\n` +
        `Stats JSON:\n${JSON.stringify(stats, null, 2)}`,
    });

    return { stats, summary: text };
  });
