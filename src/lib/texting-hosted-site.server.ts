// #969: server-side reads for the hosted texting site. Read-only, one table,
// two columns: the business's own directory listing's slug and whether it is
// published. Loaded with a dynamic import from a server function's handler.

import {
  hostedSiteBlocker,
  hostedSlugOf,
  isHostedSiteUrl,
  type HostedSite,
} from "@/lib/texting-hosted-site";

/** The business's directory listing, as the hosted path needs it. */
export async function hostedSiteFor(orgId: string): Promise<HostedSite> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as unknown as {
    from(t: "directory_profiles"): {
      select(c: "slug, published"): {
        eq(
          col: "organization_id",
          v: string,
        ): {
          maybeSingle(): Promise<{
            data: { slug: unknown; published: unknown } | null;
            error: unknown;
          }>;
        };
      };
    };
  };
  const { data, error } = await db
    .from("directory_profiles")
    .select("slug, published")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error || !data) return { slug: null, published: false };
  return {
    slug: typeof data.slug === "string" && data.slug ? data.slug : null,
    published: data.published === true,
  };
}

/**
 * Why a submit with these website fields must not go to Twilio, or null.
 * Only the hosted path is checked here: its URLs must be this business's own
 * published listing, never another business's page. The owner's own website
 * is checked by registrationDetailsSchema, as before.
 */
export async function hostedSiteRefusal(
  orgId: string,
  details: { website_url: string },
  read: (orgId: string) => Promise<HostedSite> = hostedSiteFor,
): Promise<string | null> {
  if (!isHostedSiteUrl(details.website_url)) return null;
  const site = await read(orgId);
  const blocker = hostedSiteBlocker(site);
  if (blocker) return blocker;
  if (hostedSlugOf(details.website_url) !== site.slug) {
    return "That page belongs to a different business. Use your own page, or your own website.";
  }
  return null;
}
