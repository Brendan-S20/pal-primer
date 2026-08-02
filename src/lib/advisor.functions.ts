import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import type { DigestInsights, DigestMetrics } from "@/lib/digest.server";

// AI Business Advisor (BUILD-8 — owner asked for this to be built out rather
// than retired).
//
// The analysis engine already existed, but it was reachable in exactly one way:
// a weekly email. So an owner could only get advice on the schedule we chose,
// couldn't ask for a longer view, and couldn't see the numbers the advice came
// from.
//
// Split into two calls on purpose. Metrics are a handful of database queries and
// cost nothing, so they load on their own. Insights are a model call, which under
// the new billing model spends the org's AI allowance — so it runs when someone
// ASKS for it, never as a side effect of opening a tab. That split also happens
// to be the better product: the numbers appear immediately, and the commentary is
// something you request on top of them rather than something you have to scroll
// past to reach the data.

const windowInput = z.object({
  windowDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(7),
});

export type AdvisorMetricsResult = {
  metrics: DigestMetrics;
  windowDays: number;
};

export type AdvisorInsightsResult = {
  insights: DigestInsights;
  /** False when the model was unreachable and the deterministic fallback
   *  produced this. The UI says so rather than passing arithmetic off as
   *  analysis. */
  aiGenerated: boolean;
  windowDays: number;
};

/** Free: database only. Safe to load whenever the tab opens. */
export const getAdvisorMetrics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => windowInput.parse(d))
  .handler(async ({ data, context }): Promise<AdvisorMetricsResult | null> => {
    // Revenue, A/R, and churn — the same boundary /analytics sits behind.
    // Dispatchers and techs are ops-only (Q-1) and must not see this.
    const { orgId } = await requirePermission(context.supabase, context.userId, "view_financials");
    const { computeDigestMetrics } = await import("@/lib/digest.server");
    const metrics = await computeDigestMetrics(orgId, data.windowDays);
    if (!metrics) return null;
    return { metrics, windowDays: data.windowDays };
  });

/** Costs AI allowance. Only ever called from an explicit user action. */
export const getAdvisorInsights = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => windowInput.parse(d))
  .handler(async ({ data, context }): Promise<AdvisorInsightsResult | null> => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "view_financials");
    const { computeDigestMetrics, generateDigestInsights } = await import("@/lib/digest.server");

    // Recomputed rather than accepted from the client. Metrics are the model's
    // entire input, and taking them over the wire would let a caller feed
    // arbitrary numbers into an org-scoped AI call.
    const metrics = await computeDigestMetrics(orgId, data.windowDays);
    if (!metrics) return null;

    // generateDigestInsights falls back to deterministic arithmetic when the
    // model is unreachable, and it does so silently — right for an email that
    // must go out regardless, wrong for a screen that would otherwise imply an
    // AI read the business. It reports which one ran.
    // BUILD-2: the Advisor is its own line on the usage breakdown — the
    // owner asked for this one, unlike the weekly digest.
    const insights = await generateDigestInsights(metrics, "business_advisor");
    return { insights, aiGenerated: insights.aiGenerated, windowDays: data.windowDays };
  });
