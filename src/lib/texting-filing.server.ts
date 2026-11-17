// Server-only (#971): what a business's filing copy is built from, read once
// for both the Settings review and the filing itself, so the two cannot be
// built from different facts.

import { appUrl } from "@/lib/app-origin";
import { serviceLinesOrDefault } from "@/lib/service-lines";

export type FilingContext = {
  businessName: string;
  lines: string[];
  portalUrl: string;
  bookingUrl: string | null;
  /** The link a review request carries, when the business has set one. */
  googleReviewUrl: string | null;
};

export async function filingContextFor(orgId: string): Promise<FilingContext> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as any;
  const [{ data: org }, { data: lines }] = await Promise.all([
    db
      .from("organizations")
      .select("name, slug, portal_slug, google_review_url")
      .eq("id", orgId)
      .maybeSingle(),
    // Its own read, like onboarding's: a database without the column fails
    // this alone and falls open to pet waste.
    db.from("organizations").select("service_lines").eq("id", orgId).maybeSingle(),
  ]);
  const portalSlug = (org?.portal_slug as string | null) ?? (org?.slug as string | null) ?? null;
  return {
    businessName: (org?.name as string | null) ?? "",
    lines: [...serviceLinesOrDefault(lines?.service_lines)],
    portalUrl: appUrl(portalSlug ? `/portal/${portalSlug}` : "/portal"),
    bookingUrl: org?.slug ? appUrl(`/signup/${org.slug}`) : null,
    googleReviewUrl: (org?.google_review_url as string | null) ?? null,
  };
}
