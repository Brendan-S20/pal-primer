import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { hostedSiteUrls, type HostedSite } from "@/lib/texting-hosted-site";

// #969: what Settings > Texting needs for the hosted page (the default): the
// business's own listing slug, whether it is published, and the three URLs
// the filing would use. Nothing else from the listing.
export const getTextingHostedSite = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({
      context,
    }): Promise<HostedSite & { urls: ReturnType<typeof hostedSiteUrls> | null }> => {
      const { orgId } = await requirePermission(
        context.supabase,
        context.userId,
        "manage_settings",
      );
      const { hostedSiteFor } = await import("@/lib/texting-hosted-site.server");
      const site = await hostedSiteFor(orgId);
      return { ...site, urls: site.slug ? hostedSiteUrls(site.slug) : null };
    },
  );
