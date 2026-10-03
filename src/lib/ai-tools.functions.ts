import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { generateStructured } from "@/lib/ai.server";
import { resolveOrgAiCall } from "@/lib/ai-credentials.server";
import { grossReceivedCents, receivedPaymentStatuses } from "@/lib/revenue";
import { MARKETING_AI_LAUNCHED } from "@/lib/ai-launch";
import { suggestZonePrices, zoneSkipRate } from "@/lib/zone-price-suggestion";
import { buildWeeklyDigestSummary } from "@/lib/digest-insights";
import { draftReviewReplyFromTemplate } from "@/lib/review-reply-template";

// The office tools that sit inside their workflows (punch list #11).
//
// Until 2026-10-03 every one of these was a model call. The owner's rule since
// then: a model only where the job is language. Churn risk, zone prices, the
// weekly digest and review replies are arithmetic or a choice between a few
// fixed answers over data we already hold, so each is now a pure function in
// its own file, free, on every plan, and the same answer every time. AI
// dispatch is gone entirely: the Schedule's route planner assigns with real
// road distances, where the model was guessing from postal prefixes.
//
// Marketing posts are the one model call left here, and they are switched off
// at launch (ai-launch.ts).

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
    // Refused here as well as hidden in the panel. A panel that says "coming
    // soon" over a server function that still answers is a feature anyone with
    // the devtools open can use, and every call is a model call we pay for.
    if (!MARKETING_AI_LAUNCHED) {
      throw new Error("Marketing posts are coming soon. They are not available yet.");
    }
    const staff = await callerOrg(context);
    const { data: org } = await context.supabase
      .from("organizations")
      .select("name, slug, google_review_url")
      .eq("id", staff.organization_id)
      .single();

    const output = await generateStructured({
      ...(await resolveOrgAiCall(staff.organization_id, "marketing_content")),
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

    // A template by star rating (review-reply-template.ts). Same return shape
    // as the model version, so the panel did not change.
    return draftReviewReplyFromTemplate({
      rating: data.rating,
      reviewText: data.reviewText,
      reviewerName: data.reviewerName,
      businessName: org?.name ?? null,
    });
  });

// ---------------- Churn scoring ----------------

export const scoreChurn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid().optional() }).parse(d ?? {}))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "use_ai_tools");
    const staff = await callerOrg(context);
    // Weighted rules, not a model (churn-score.ts has the weights and why),
    // and the same run Analytics uses (churn-run.server.ts).
    const { runChurnScoring } = await import("@/lib/churn-run.server");
    return runChurnScoring(context.supabase, staff.organization_id, data.clientId);
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
      // Bounded above by today as well. With only a lower bound, every visit
      // already booked for the rest of the week counted as "scheduled", so the
      // completion rate fell for reasons that had nothing to do with the work.
      context.supabase
        .from("visits")
        .select("status, scheduled_on")
        .eq("organization_id", orgId)
        .gte("scheduled_on", weekAgoDate)
        .lte("scheduled_on", orgDay(now.getTime())),
      context.supabase
        .from("invoices")
        .select("status, total_cents, tax_cents, issued_at")
        .eq("organization_id", orgId)
        .gte("issued_at", weekAgoIso),
      // IMP-10: this had NO status filter at all, so a declined card and a
      // pending intent both counted as revenue collected — and the number fed
      // an assistant that answers "how did we do this week" in plain English.
      // Wrong in the flattering direction, stated confidently.
      context.supabase
        .from("payments")
        .select("amount_cents, tax_cents, status, paid_at")
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
      // Sales tax is billed with the invoice but is not the business's
      // revenue; zero on every invoice until a rate is set.
      (s: number, i: any) => s + (i.total_cents ?? 0) - (i.tax_cents ?? 0),
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

    // The summary is built from `stats` by rules (digest-insights.ts), in the
    // same sections the model used to be asked for. Nothing in it is a figure
    // `stats` does not hold, which a model summary could not promise.
    const text = buildWeeklyDigestSummary(stats);

    return { stats, summary: text };
  });

// ---------------- Zone-pricing suggestions ----------------

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
    // Paged (BUG-23). Ninety days of visits passes PostgREST's silent
    // 1000-row cap for any org with more than a few dozen weekly clients, and
    // the rule below reads "fewer than 20 completed" as "too little to judge".
    // A truncated count would hold a zone for a reason that is not true.
    const { fetchAllPages } = await import("@/lib/supabase-paging.server");
    const visits = await fetchAllPages<any>((from, to) =>
      context.supabase
        .from("visits")
        .select("id, zone_id, status, subscriptions(price_cents, frequency)")
        .eq("organization_id", orgId)
        .in("zone_id", zoneIds)
        .gte("scheduled_on", since)
        .order("id")
        .range(from, to),
    );

    const stats = zones.map((z: any) => {
      const zv = visits.filter((v: any) => v.zone_id === z.id);
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
        // skipped / (completed + skipped): the rate the suggestion decides on.
        // It was skipped / every visit in the window, which counted visits
        // still in the future and so understated the rate the column showed.
        skip_rate_pct: Math.round(zoneSkipRate(completed.length, skipped.length) * 100),
        avg_visit_price_cents: avg,
      };
    });

    // A written rule (zone-price-suggestion.ts), not a model. Same shape as
    // before, one row per zone with its stats, so PricingPanel reads it as it
    // did.
    return suggestZonePrices(stats);
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
