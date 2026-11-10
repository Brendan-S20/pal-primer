// The directory's server functions (#630, phase 1).
//
// Visitors: searchDirectory and getDirectoryProfiles read through the two
// public RPCs with the PUBLISHABLE key, so the database decides what is
// public (published rows of live businesses, public columns only) and this
// file cannot widen it.
//
// Owners: getMyDirectoryProfile / saveMyDirectoryProfile. The save asks for an
// owner here, before any RPC, and set_directory_profile asks again on the
// caller's own client; nothing here writes a profile with the service role.
//
// The quote is not here: it goes through /api/public/leads, the one way a lead
// gets in from outside, behind its honeypot, time check and rate limit.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveSupabaseUrl } from "@/lib/supabase-url";
import {
  DIRECTORY_SEARCH_LINES,
  MAX_COMPARE,
  isDirectorySlug,
  type DirectoryProfile,
} from "@/lib/directory";

export const ONLY_AN_OWNER_CHANGES_THE_DIRECTORY =
  "Only an owner can change the directory profile.";

/** The publishable-key client. The directory RPCs are granted to anon; this
 *  is the same key every browser holds, so nothing read here is more than a
 *  visitor could read. Untyped on purpose: supabase/types.ts does not know
 *  the directory yet and is not edited by this change (#749, #733, #717,
 *  #716); the shapes are pinned in lib/directory.ts instead. */
function visitorDb(): any {
  return createClient(resolveSupabaseUrl(), process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

/** Rows as the RPC returns them, narrowed to the public shape. Anything the
 *  RPC might one day add is dropped here rather than passed to a page. */
export function toDirectoryProfiles(rows: unknown): DirectoryProfile[] {
  if (!Array.isArray(rows)) return [];
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  return rows.flatMap((r: any) => {
    if (!r || typeof r.slug !== "string" || typeof r.display_name !== "string") return [];
    const services = Array.isArray(r.services) ? r.services : [];
    return [
      {
        slug: r.slug,
        display_name: r.display_name,
        logo_url: typeof r.logo_url === "string" ? r.logo_url : null,
        bio: typeof r.bio === "string" ? r.bio : null,
        service_lines: strs(r.service_lines),
        coverage_zips: strs(r.coverage_zips),
        coverage_cities: strs(r.coverage_cities),
        services: services.flatMap((s: any) =>
          s && typeof s.label === "string" && typeof s.service_line === "string"
            ? [
                {
                  label: s.label,
                  service_line: s.service_line,
                  price_from_cents:
                    typeof s.price_from_cents === "number" ? s.price_from_cents : null,
                  price_unit: typeof s.price_unit === "string" ? s.price_unit : null,
                },
              ]
            : [],
        ),
        published_at: typeof r.published_at === "string" ? r.published_at : null,
      },
    ];
  });
}

/**
 * Search by service and ZIP.
 *
 * The database answers "which published profiles confirmed this ZIP for this
 * line". Then each is checked against the business's CURRENT zones with
 * lib/lead-service-area.server.ts, the same verdict /leads shows the office:
 * a business whose zones now say "outside" for this ZIP is dropped, because
 * listing it would send a visitor a quote form the business will turn down.
 * "unknown" (no zones, a lookup that failed) keeps the listing: the owner
 * confirmed the ZIP, and a false "outside" costs more than a missing one.
 */
export const searchDirectory = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z
      .object({
        line: z.enum(DIRECTORY_SEARCH_LINES),
        zip: z
          .string()
          .trim()
          .regex(/^\d{5}$/),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { data: rows, error } = await visitorDb().rpc("directory_search", {
      _service_line: data.line,
      _zip: data.zip,
    });
    if (error) throw new Error("The directory is unavailable right now.");
    const found = toDirectoryProfiles(rows);
    if (!found.length) return { profiles: found };
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { leadServiceAreas } = await import("@/lib/lead-service-area.server");
      const verdicts = await Promise.all(
        found.map(async (p) => {
          const { data: orgId } = await (supabaseAdmin as any).rpc("directory_org_for_quote", {
            _slug: p.slug,
          });
          if (typeof orgId !== "string") return "unknown" as const;
          const [v] = await leadServiceAreas(supabaseAdmin, orgId, [data.zip]);
          return v;
        }),
      );
      return { profiles: found.filter((_, i) => verdicts[i] !== "outside") };
    } catch (e) {
      console.error("directory zone check failed; keeping confirmed ZIPs", e);
      return { profiles: found };
    }
  });

/** One profile (the profile page and the quote page) or up to three (compare). */
export const getDirectoryProfiles = createServerFn({ method: "GET" })
  .inputValidator((d) =>
    z
      .object({
        slugs: z
          .array(z.string().trim().toLowerCase())
          .min(1)
          .max(MAX_COMPARE)
          .transform((a) => a.filter(isDirectorySlug)),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    if (!data.slugs.length) return { profiles: [] as DirectoryProfile[] };
    const { data: rows, error } = await visitorDb().rpc("directory_profiles_by_slug", {
      _slugs: data.slugs,
    });
    if (error) throw new Error("The directory is unavailable right now.");
    const profiles = toDirectoryProfiles(rows);
    // In the order the visitor asked for them.
    profiles.sort((a, b) => data.slugs.indexOf(a.slug) - data.slugs.indexOf(b.slug));
    return { profiles };
  });

// ── The owner's settings ───────────────────────────────────────────────────

async function caller(supabase: unknown, userId: string) {
  const { resolveCaller } = await import("@/lib/authz.server");
  return resolveCaller(supabase, userId);
}

export type MyDirectoryProfile = {
  canEdit: boolean;
  orgName: string;
  hasLogo: boolean;
  /** ZIPs the business's zones list, to start the coverage from. */
  zoneZips: string[];
  services: Array<{
    id: string;
    name: string;
    service_line: string;
    price_unit: string | null;
    base_price_cents: number | null;
    active: boolean;
  }>;
  profile: null | {
    slug: string;
    published: boolean;
    display_name: string;
    show_logo: boolean;
    bio: string | null;
    coverage_zips: string[];
    coverage_cities: string[];
    confirmed_at: string | null;
    listed: Array<{ service_id: string; price_from_cents: number | null }>;
  };
};

export const getMyDirectoryProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyDirectoryProfile> => {
    const { orgId, role } = await caller(context.supabase, context.userId);
    const sb = context.supabase as any;
    const [org, services, zones, profile, listed] = await Promise.all([
      sb.from("organizations").select("name, logo_url").eq("id", orgId).maybeSingle(),
      sb
        .from("services")
        .select("id, name, service_line, price_unit, base_price_cents, active")
        .eq("organization_id", orgId)
        .order("name"),
      sb.from("zones").select("zip_codes, enabled").eq("organization_id", orgId),
      sb
        .from("directory_profiles")
        .select(
          "slug, published, display_name, show_logo, bio, coverage_zips, coverage_cities, confirmed_at",
        )
        .eq("organization_id", orgId)
        .maybeSingle(),
      sb
        .from("directory_profile_services")
        .select("service_id, price_from_cents, position")
        .eq("organization_id", orgId)
        .order("position"),
    ]);
    const zoneZips = Array.from(
      new Set(
        ((zones.data ?? []) as Array<{ zip_codes: string[] | null; enabled: boolean | null }>)
          .filter((z) => z.enabled !== false)
          .flatMap((z) => z.zip_codes ?? [])
          .filter((z) => /^\d{5}$/.test(z)),
      ),
    ).sort();
    return {
      canEdit: role === "owner",
      orgName: (org.data?.name as string) ?? "",
      hasLogo: !!org.data?.logo_url,
      zoneZips,
      services: (services.data ?? []) as MyDirectoryProfile["services"],
      profile: profile.data
        ? {
            ...(profile.data as Omit<NonNullable<MyDirectoryProfile["profile"]>, "listed">),
            listed: (
              (listed.data ?? []) as Array<{ service_id: string; price_from_cents: number | null }>
            ).map((l) => ({ service_id: l.service_id, price_from_cents: l.price_from_cents })),
          }
        : null,
    };
  });

export const directoryProfileSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .refine(isDirectorySlug, "Use 3 to 60 lowercase letters, numbers and dashes."),
    displayName: z.string().trim().min(1).max(120),
    bio: z.string().trim().max(1200).nullable(),
    showLogo: z.boolean(),
    coverageZips: z
      .array(
        z
          .string()
          .trim()
          .regex(/^\d{5}$/),
      )
      .max(200),
    coverageCities: z.array(z.string().trim().min(1).max(80)).max(30),
    services: z
      .array(
        z.object({
          serviceId: z.string().uuid(),
          priceFromCents: z.number().int().min(0).max(10_000_000).nullable(),
        }),
      )
      .max(50),
    published: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.published && !v.coverageZips.length) {
      ctx.addIssue({ code: "custom", message: "Add at least one ZIP code before you publish." });
    }
    if (v.published && !v.services.length) {
      ctx.addIssue({ code: "custom", message: "List at least one service before you publish." });
    }
  });

export const saveMyDirectoryProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => directoryProfileSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId, role } = await caller(context.supabase, context.userId);
    if (role !== "owner") throw new Error(ONLY_AN_OWNER_CHANGES_THE_DIRECTORY);
    const { error } = await (context.supabase as any).rpc("set_directory_profile", {
      _org: orgId,
      _slug: data.slug,
      _display_name: data.displayName,
      _bio: data.bio,
      _show_logo: data.showLogo,
      _coverage_zips: data.coverageZips,
      _coverage_cities: data.coverageCities,
      _services: data.services.map((s) => ({
        service_id: s.serviceId,
        price_from_cents: s.priceFromCents,
      })),
      _published: data.published,
    });
    if (error) {
      if (/directory_profiles_slug_key|duplicate key/i.test(error.message)) {
        throw new Error("That web address is taken. Try another.");
      }
      throw new Error(error.message);
    }
    return { ok: true };
  });
