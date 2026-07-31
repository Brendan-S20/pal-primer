import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { generateStructured, generateAiText } from "@/lib/ai.server";
import { resolveOrgAiConfig } from "@/lib/ai-credentials.server";
import { grossReceivedCents, receivedPaymentStatuses } from "@/lib/revenue";

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
        kind: z.enum([
          "facebook_post",
          "instagram_caption",
          "email_blast",
          "google_business_update",
          "flyer_headline",
        ]),
        topic: z.string().trim().min(3).max(400),
        tone: z.enum(["friendly", "professional", "playful", "urgent"]).default("friendly"),
        includeCta: z.boolean().default(true),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "use_ai_tools");
    const staff = await callerOrg(context);
    const { data: org } = await context.supabase
      .from("organizations")
      .select("name, slug, google_review_url")
      .eq("id", staff.organization_id)
      .single();

    const output = await generateStructured({
      config: await resolveOrgAiConfig(staff.organization_id),
      label: "Marketing content",
      schema: z.object({
        title: z.string(),
        body: z.string(),
        hashtags: z.array(z.string()).max(8),
        cta: z.string(),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          hashtags: { type: "array", items: { type: "string" }, maxItems: 8 },
          cta: {
            type: "string",
            description: "Short call to action (empty string if none requested).",
          },
        },
        required: ["title", "body", "hashtags", "cta"],
      },
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
    await requirePermission(context.supabase, context.userId, "use_ai_tools");
    const staff = await callerOrg(context);
    const { data: org } = await context.supabase
      .from("organizations")
      .select("name")
      .eq("id", staff.organization_id)
      .single();

    const output = await generateStructured({
      config: await resolveOrgAiConfig(staff.organization_id),
      label: "Review reply",
      schema: z.object({
        reply: z.string(),
        notes: z.string(),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          reply: { type: "string", description: "The public reply text." },
          notes: { type: "string", description: 'Internal operational follow-up, or "none".' },
        },
        required: ["reply", "notes"],
      },
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

async function gatherChurnSignals(
  supabase: any,
  organizationId: string,
  clientId?: string,
): Promise<ChurnSignals[]> {
  // NB: clients has no `status` column — active clients are `active = true`.
  let q = supabase
    .from("clients")
    .select("id, display_name, created_at, sms_opt_out, active")
    .eq("organization_id", organizationId)
    .eq("active", true);
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
  .inputValidator((d) => z.object({ clientId: z.string().uuid().optional() }).parse(d ?? {}))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "use_ai_tools");
    const staff = await callerOrg(context);
    const signals = await gatherChurnSignals(
      context.supabase,
      staff.organization_id,
      data.clientId,
    );
    if (!signals.length) return { scored: 0 };

    const output = await generateStructured({
      config: await resolveOrgAiConfig(staff.organization_id),
      label: "Churn scoring",
      maxTokens: 16384,
      schema: z.object({
        scores: z.array(
          z.object({
            client_id: z.string(),
            score: z.number().int().min(0).max(100),
            reason: z.string(),
          }),
        ),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          scores: {
            type: "array",
            items: {
              type: "object",
              properties: {
                client_id: { type: "string" },
                score: { type: "integer", minimum: 0, maximum: 100 },
                reason: { type: "string", description: "One short sentence." },
              },
              required: ["client_id", "score", "reason"],
            },
          },
        },
        required: ["scores"],
      },
      prompt:
        `Score churn risk (0-100, higher = more likely to cancel soon) for these pet-waste-removal customers based on activity signals. ` +
        `Weigh unpaid invoices, high skip rate, long gap since last completed visit, and short tenure with skips. Return one short reason per client.\n\n` +
        `Signals JSON:\n${JSON.stringify(signals, null, 2)}`,
    });

    // Persist
    for (const s of output.scores) {
      await context.supabase
        .from("clients")
        .update({
          churn_score: s.score,
          churn_reason: s.reason,
          churn_scored_at: new Date().toISOString(),
        })
        .eq("id", s.client_id)
        .eq("organization_id", staff.organization_id);
    }
    return { scored: output.scores.length };
  });

export const listChurnRisk = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "use_ai_tools");
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
    await requirePermission(context.supabase, context.userId, "use_ai_tools");
    const staff = await callerOrg(context);
    const orgId = staff.organization_id;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
    const weekAgoIso = weekAgo.toISOString();

    // The org is fetched BEFORE the rest, not alongside it, because its
    // timezone decides the window. `scheduled_on` is a DATE column, so
    // comparing it against a UTC-derived day is the BUG-12 mistake: for an org
    // west of UTC the boundary lands up to a day early and quietly shifts which
    // visits count as "this week" — in a summary an assistant then reads out as
    // fact. One extra round trip is the right price.
    const { data: org } = await context.supabase
      .from("organizations")
      .select("name, timezone")
      .eq("id", orgId)
      .single();
    const { DEFAULT_TIMEZONE } = await import("@/lib/route-window");
    const { orgLocalDay } = await import("@/lib/cpa-reports");
    const tz = (org as { timezone?: string | null } | null)?.timezone || DEFAULT_TIMEZONE;
    const orgDay = (ms: number) => orgLocalDay(new Date(ms), tz);
    const weekAgoDate = orgDay(weekAgo.getTime());

    const [
      { data: visits },
      { data: invoices },
      { data: payments },
      { data: newClients },
      { data: leads },
      { data: churn },
    ] = await Promise.all([
      // timezone: the reversal reader buckets by the ORG's calendar day, so a
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
      // IMP-10: this had NO status filter at all, so a declined card and a
      // pending intent both counted as revenue collected — and the number fed
      // an assistant that answers "how did we do this week" in plain English.
      // Wrong in the flattering direction, stated confidently.
      context.supabase
        .from("payments")
        .select("amount_cents, status, paid_at")
        .eq("organization_id", orgId)
        .in("status", receivedPaymentStatuses())
        .gte("paid_at", weekAgoIso),
      context.supabase
        .from("clients")
        .select("id")
        .eq("organization_id", orgId)
        .gte("created_at", weekAgoIso),
      // The org filter is belt-and-braces: `leads` SELECT is org-scoped by RLS
      // (verified), so this is not a leak today. But it is the only query in
      // this Promise.all without one, and "safe because a policy elsewhere says
      // so" is a bad thing to have to rediscover — especially in a figure fed
      // to an assistant that states it as fact.
      context.supabase
        .from("leads")
        .select("id, status")
        .eq("organization_id", orgId)
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

    // IMP-10, the other half of the rule. `revenue.ts` counts a refunded
    // payment at full value on purpose — the money did arrive — but that is
    // only truthful if the reversal is deducted in the period IT happened, and
    // nothing here was doing that. So a week in which a $5,000 charge was
    // disputed reported the same revenue_collected_cents as a week in which it
    // was not, and this number is read out loud by an assistant answering "how
    // did we do this week". Wrong in the flattering direction, stated
    // confidently, with no line an owner could trace it back to.
    const { loadOrgReversals, totalReversals } = await import("@/lib/reversals.server");
    const reversals = totalReversals(
      await loadOrgReversals(context.supabase, {
        orgId,
        timezone: tz,
        // Same window as the payments query above, expressed in the org's own
        // days — a refund netted against a different span is not a correction.
        from: weekAgoDate,
        to: orgDay(now.getTime()),
      }),
    );
    const revenueGrossCollected = grossReceivedCents(payments ?? []);
    const revenueCollected = revenueGrossCollected - reversals.netCents;
    const revenueInvoiced = (invoices ?? []).reduce(
      (s: number, i: any) => s + (i.total_cents ?? 0),
      0,
    );
    const openInvoices = (invoices ?? []).filter((i: any) => i.status === "open").length;

    const stats = {
      org: org?.name ?? "Your business",
      completed,
      skipped,
      scheduled,
      completion_rate: scheduled ? Math.round((completed / scheduled) * 100) : 0,
      revenue_collected_cents: revenueCollected,
      // The components ride along so the digest can name a dispute as the
      // reason revenue moved, instead of attributing it to lost business.
      revenue_collected_gross_cents: revenueGrossCollected,
      refunds_chargebacks_cents: reversals.netCents,
      refunds_chargebacks_count: reversals.count,
      revenue_invoiced_cents: revenueInvoiced,
      open_invoices: openInvoices,
      new_clients: (newClients ?? []).length,
      new_leads: (leads ?? []).length,
      at_risk: churn ?? [],
    };

    const text = await generateAiText({
      config: await resolveOrgAiConfig(staff.organization_id),
      label: "Weekly digest",
      prompt:
        `Write a concise weekly owner digest for a pet waste removal business. ` +
        `Use short section headings ("This week", "Money", "Growth", "Watch list") and plain prose bullet points. ` +
        `No emoji. End with 2-3 concrete recommended actions for the owner.\n\n` +
        `revenue_collected_cents is already NET of the refunds and chargebacks that landed this week. ` +
        `If refunds_chargebacks_cents is non-zero, name it under "Money" — a reversal and a sales slump ask for different responses.\n\n` +
        `Stats JSON:\n${JSON.stringify(stats, null, 2)}`,
    });

    return { stats, summary: text };
  });

// ---------------- Value-aware AI dispatch ----------------

export const suggestDispatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ day: z.string().min(8).max(10) }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "use_ai_tools");
    const staff = await callerOrg(context);
    const orgId = staff.organization_id;

    const [{ data: visits, error: vErr }, { data: techs, error: sErr }] = await Promise.all([
      context.supabase
        .from("visits")
        .select(
          "id, assigned_staff_id, sequence, status, client_id, zone_id, " +
            "clients(display_name, churn_score, credit_balance_cents), " +
            "properties(street, city, postal_code, latitude, longitude), " +
            "zones(name, postal_prefix), " +
            "subscriptions(price_cents, frequency, billing_cadence)",
        )
        .eq("organization_id", orgId)
        .eq("scheduled_on", data.day)
        .in("status", ["scheduled", "in_progress"]),
      context.supabase
        .from("staff")
        .select("id, display_name, role, start_latitude, start_longitude, active")
        .eq("organization_id", orgId)
        .eq("active", true),
    ]);
    if (vErr) throw new Error(vErr.message);
    if (sErr) throw new Error(sErr.message);
    if (!visits?.length)
      return { day: data.day, suggestions: [], notes: "No open visits on this day." };

    const visitPayload = visits.map((v: any) => ({
      id: v.id,
      current_staff_id: v.assigned_staff_id,
      current_sequence: v.sequence,
      client: v.clients?.display_name,
      churn_score: v.clients?.churn_score ?? null,
      price_cents: v.subscriptions?.price_cents ?? 0,
      frequency: v.subscriptions?.frequency ?? null,
      zone: v.zones?.name ?? null,
      postal: v.properties?.postal_code ?? null,
      lat: v.properties?.latitude ?? null,
      lng: v.properties?.longitude ?? null,
    }));
    const staffPayload = (techs ?? []).map((s: any) => ({
      id: s.id,
      name: s.display_name,
      role: s.role,
      start_lat: s.start_latitude,
      start_lng: s.start_longitude,
    }));

    const output = await generateStructured({
      config: await resolveOrgAiConfig(staff.organization_id),
      label: "AI dispatch",
      maxTokens: 8192,
      schema: z.object({
        notes: z.string(),
        suggestions: z.array(
          z.object({
            visit_id: z.string(),
            suggested_staff_id: z.string().nullable(),
            reason: z.string(),
            priority: z.enum(["high", "medium", "low"]),
          }),
        ),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          notes: {
            type: "string",
            description:
              "Brief overall dispatcher notes. If no changes are worth making, say why here.",
          },
          suggestions: {
            type: "array",
            description:
              "One entry per visit whose assignment should change. Empty if the current plan is already optimal.",
            items: {
              type: "object",
              properties: {
                visit_id: { type: "string" },
                suggested_staff_id: { type: ["string", "null"] },
                reason: { type: "string", description: "One sentence." },
                priority: { type: "string", enum: ["high", "medium", "low"] },
              },
              required: ["visit_id", "suggested_staff_id", "reason", "priority"],
            },
          },
        },
        required: ["notes", "suggestions"],
      },
      prompt:
        `You are a dispatch assistant for a pet-waste-removal business. Suggest visit-to-tech assignments for ${data.day} that:\n` +
        `1) Prioritize high-value clients (higher price_cents) and at-risk clients (churn_score >= 60) for the most experienced techs (role manager/owner over tech).\n` +
        `2) Group stops in the same zone / postal prefix on the same tech to minimize drive time.\n` +
        `3) Balance total revenue across techs so no one is under-loaded while another is overloaded.\n` +
        `4) Prefer keeping current assignment if it's already good — only recommend moves with real upside.\n\n` +
        `Return one suggestion PER visit that should change. Do not include visits where the current assignment is already optimal. ` +
        `Give a one-sentence reason each. Priority=high when both value and routing improve; medium when routing only; low when marginal.\n\n` +
        `Visits:\n${JSON.stringify(visitPayload)}\n\nTechs:\n${JSON.stringify(staffPayload)}`,
    });

    // Enrich suggestions with display info the UI needs
    const byVisit = new Map(visits.map((v: any) => [v.id, v]));
    const byStaff = new Map((techs ?? []).map((s: any) => [s.id, s]));
    const enriched = output.suggestions
      .filter((s) => byVisit.has(s.visit_id))
      .map((s) => {
        const v: any = byVisit.get(s.visit_id);
        return {
          ...s,
          client: v.clients?.display_name,
          current_staff: v.assigned_staff_id
            ? ((byStaff.get(v.assigned_staff_id) as any)?.display_name ?? null)
            : null,
          suggested_staff: s.suggested_staff_id
            ? ((byStaff.get(s.suggested_staff_id) as any)?.display_name ?? null)
            : null,
          zone: v.zones?.name ?? null,
          price_cents: v.subscriptions?.price_cents ?? 0,
        };
      });

    return { day: data.day, notes: output.notes, suggestions: enriched };
  });

export const applyDispatchSuggestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        changes: z
          .array(z.object({ visit_id: z.string().uuid(), staff_id: z.string().uuid().nullable() }))
          .min(1)
          .max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "use_ai_tools");
    let applied = 0;
    for (const c of data.changes) {
      const { error } = await context.supabase.rpc("reassign_visit", {
        _visit_id: c.visit_id,
        _staff_id: c.staff_id as string,
      });
      if (!error) applied++;
    }
    return { applied };
  });

// ---------------- AI zone-pricing suggestions ----------------

export const suggestZonePricing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({}).parse(d ?? {}))
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "use_ai_tools");
    const staff = await callerOrg(context);
    const orgId = staff.organization_id;
    const since = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

    const { data: zones, error } = await context.supabase
      .from("zones")
      .select("id, name, postal_prefix, account_type, price_note")
      .eq("organization_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);
    if (!zones?.length) return { suggestions: [], notes: "No zones defined." };

    const zoneIds = zones.map((z: any) => z.id);
    const { data: visits } = await context.supabase
      .from("visits")
      .select("zone_id, status, subscriptions(price_cents, frequency)")
      .eq("organization_id", orgId)
      .in("zone_id", zoneIds)
      .gte("scheduled_on", since);

    const stats = zones.map((z: any) => {
      const zv = (visits ?? []).filter((v: any) => v.zone_id === z.id);
      const completed = zv.filter((v: any) => v.status === "completed");
      const skipped = zv.filter((v: any) => v.status === "skipped");
      const prices = completed
        .map((v: any) => v.subscriptions?.price_cents ?? 0)
        .filter((n: number) => n > 0);
      const avg = prices.length
        ? Math.round(prices.reduce((a: number, b: number) => a + b, 0) / prices.length)
        : 0;
      return {
        zone_id: z.id,
        name: z.name,
        postal_prefix: z.postal_prefix,
        account_type: z.account_type,
        current_price_note: z.price_note,
        completed_90d: completed.length,
        skipped_90d: skipped.length,
        skip_rate_pct: zv.length ? Math.round((skipped.length / zv.length) * 100) : 0,
        avg_visit_price_cents: avg,
      };
    });

    const output = await generateStructured({
      config: await resolveOrgAiConfig(staff.organization_id),
      label: "Zone pricing",
      maxTokens: 8192,
      schema: z.object({
        notes: z.string(),
        suggestions: z.array(
          z.object({
            zone_id: z.string(),
            suggested_price_cents: z.number().int().min(0),
            delta_pct: z.number().int().min(-50).max(200),
            confidence: z.enum(["low", "medium", "high"]),
            reason: z.string(),
          }),
        ),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          notes: {
            type: "string",
            description:
              "Brief overall pricing notes. If no changes are recommended, say why here.",
          },
          suggestions: {
            type: "array",
            description: "One entry per zone with a recommended price.",
            items: {
              type: "object",
              properties: {
                zone_id: { type: "string" },
                suggested_price_cents: { type: "integer", minimum: 0 },
                delta_pct: { type: "integer", minimum: -50, maximum: 200 },
                confidence: { type: "string", enum: ["low", "medium", "high"] },
                reason: { type: "string", description: "One sentence." },
              },
              required: ["zone_id", "suggested_price_cents", "delta_pct", "confidence", "reason"],
            },
          },
        },
        required: ["notes", "suggestions"],
      },
      prompt:
        `You are a pricing analyst for a pet-waste-removal business. Recommend a per-visit price (in cents) for each zone based on the 90-day stats. ` +
        `Raise prices where demand is strong (high completed count, low skip rate) or costs are higher (commercial). Lower or hold where skip rate is high or volume is thin. ` +
        `Suggest realistic residential per-visit pricing typically between $12 and $45 unless commercial. Give a one-sentence reason. Confidence high only when 20+ completed visits.\n\n` +
        `Zones:\n${JSON.stringify(stats)}`,
    });

    const byZone = new Map(stats.map((s) => [s.zone_id, s]));
    const enriched = output.suggestions
      .filter((s) => byZone.has(s.zone_id))
      .map((s) => ({ ...s, ...(byZone.get(s.zone_id) as any) }));

    return { notes: output.notes, suggestions: enriched };
  });

export const applyZonePricing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        changes: z
          .array(z.object({ zone_id: z.string().uuid(), price_note: z.string().max(200) }))
          .min(1)
          .max(200),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "use_ai_tools");
    const staff = await callerOrg(context);
    let applied = 0;
    for (const c of data.changes) {
      const { error } = await context.supabase
        .from("zones")
        .update({ price_note: c.price_note })
        .eq("id", c.zone_id)
        .eq("organization_id", staff.organization_id);
      if (!error) applied++;
    }
    return { applied };
  });
