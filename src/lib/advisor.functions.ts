import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import type { DigestMetrics } from "@/lib/digest.server";
import type { DigestInsights } from "@/lib/digest-insights";

// Business Advisor (BUILD-8: owner asked for this to be built out rather
// than retired).
//
// The analysis engine already existed, but it was reachable in exactly one way:
// a weekly email. So an owner could only get advice on the schedule we chose,
// couldn't ask for a longer view, and couldn't see the numbers the advice came
// from.
//
// Split into two calls. Metrics load on their own as soon as the tab opens;
// the commentary is requested on top of them. That split was first made
// because the commentary was a model call that spent the org's AI allowance.
// It no longer is (2026-10-03: every input is a figure we already hold, so the
// commentary is rules in digest-insights.ts, free and the same every time),
// but the shape is still the better product: the numbers appear immediately,
// and the reading of them is something you ask for rather than scroll past.

const windowInput = z.object({
  windowDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(7),
});

export type AdvisorMetricsResult = {
  metrics: DigestMetrics;
  windowDays: number;
};

export type AdvisorInsightsResult = {
  insights: DigestInsights;
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

/** Database plus arithmetic. Called when the owner asks for a reading. */
export const getAdvisorInsights = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => windowInput.parse(d))
  .handler(async ({ data, context }): Promise<AdvisorInsightsResult | null> => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "view_financials");
    const { computeDigestMetrics } = await import("@/lib/digest.server");
    const { buildDigestInsights } = await import("@/lib/digest-insights");

    // Recomputed rather than accepted from the client: the commentary states
    // these figures back to the owner, and taking them over the wire would let
    // a caller put arbitrary numbers into an org-scoped report.
    const metrics = await computeDigestMetrics(orgId, data.windowDays);
    if (!metrics) return null;
    return { insights: buildDigestInsights(metrics), windowDays: data.windowDays };
  });
