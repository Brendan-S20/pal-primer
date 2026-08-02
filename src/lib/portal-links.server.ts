// Server-only helpers for building canonical portal links and ensuring every
// org has a portal_slug. Import inside server-function/route handlers only.

import { appOrigin } from "@/lib/app-origin";
function appUrl(): string {
  return appOrigin();
}

export function slugify(txt: string): string {
  return (txt || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: string | null | undefined): boolean {
  return !!v && UUID_RE.test(v);
}

/**
 * Return a URL-safe, unique slug candidate for an org, resolving collisions
 * with -2, -3, … against the given admin client. Never returns a UUID-shaped
 * slug (that segment is reserved for legacy tokens in route disambiguation).
 */
async function uniqueSlug(admin: any, name: string, orgId: string): Promise<string> {
  let base = slugify(name);
  if (!base) base = "company";
  if (isUuid(base)) base = `co-${base}`;
  let cand = base;
  let n = 1;
  // Bounded loop; collisions are rare.
  for (let i = 0; i < 50; i++) {
    const { data } = await admin
      .from("organizations")
      .select("id")
      .eq("portal_slug", cand)
      .neq("id", orgId)
      .maybeSingle();
    if (!data) return cand;
    n += 1;
    cand = `${base}-${n}`;
  }
  return `${base}-${orgId.slice(0, 6)}`;
}

/**
 * Guarantee the org has a portal_slug, generating and persisting one from its
 * name if missing (covers orgs created after the backfill migration). Returns
 * the slug. Uses the service-role client.
 */
export async function ensureOrgSlug(orgId: string): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as any;
  const { data: org } = await admin
    .from("organizations")
    .select("id, name, portal_slug")
    .eq("id", orgId)
    .maybeSingle();
  if (!org) throw new Error("Organization not found");
  if (org.portal_slug) return org.portal_slug as string;
  const slug = await uniqueSlug(admin, org.name ?? "", orgId);
  await admin.from("organizations").update({ portal_slug: slug }).eq("id", orgId);
  return slug;
}

/**
 * Build the canonical portal deep link for a client. Falls back to the legacy
 * /portal/{token} form only if a slug truly can't be resolved, so a link is
 * never broken. Pass a known slug to skip the lookup.
 */
export async function buildPortalLink(
  orgId: string,
  token: string | null | undefined,
  knownSlug?: string | null,
): Promise<string | undefined> {
  if (!token) return undefined;
  let slug = knownSlug ?? null;
  if (!slug) {
    try {
      slug = await ensureOrgSlug(orgId);
    } catch {
      slug = null;
    }
  }
  return slug ? `${appUrl()}/portal/${slug}/${token}` : `${appUrl()}/portal/${token}`;
}
