// The directory's server functions (#630, phase 1).
//
// Visitors: searchDirectory and getDirectoryProfiles read through the two
// public RPCs with the PUBLISHABLE key, so the database decides what is
// public (published rows of live businesses, public columns only, and for a
// search, only businesses whose zones do not say "outside") and this file
// cannot widen it. Neither uses the service role.
//
// Owners: getMyDirectoryProfile / saveMyDirectoryProfile. The save asks for an
// owner here, before any RPC, and set_directory_profile asks again on the
// caller's own client; nothing here writes a profile with the service role.
//
// The quote is not here: it goes through /api/public/leads, the one way a lead
// gets in from outside, behind its honeypot, time check and rate limit.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveSupabaseUrl } from "@/lib/supabase-url";
import {
  DIRECTORY_AREAS_MAX,
  DIRECTORY_AREA_NAME_MAX,
  DIRECTORY_HIGHLIGHTS_MAX,
  DIRECTORY_HIGHLIGHT_MAX,
  DIRECTORY_SEARCH_LINES,
  DIRECTORY_TAGLINE_MAX,
  MAX_COMPARE,
  cleanHighlights,
  directoryContentProblems,
  isDirectorySlug,
  oneLine,
  BOOKING_POLICY_MAX,
  cleanBookingPolicy,
  type DirectoryArea,
  type DirectoryListedService,
  type DirectoryListing,
  type DirectoryPackage,
  type DirectoryPhoto,
  type DirectoryProfile,
  isDirectoryPhotoUrl,
} from "@/lib/directory";
import { isPublicBookingMode, type PublicBookingMode } from "@/lib/public-booking-mode";

export const ONLY_AN_OWNER_CHANGES_THE_DIRECTORY =
  "Only an owner can change the directory profile.";

/** The publishable-key client. The directory RPCs are granted to anon; this
 *  is the same key every browser holds, so nothing read here is more than a
 *  visitor could read. Untyped on purpose: supabase/types.ts does not know
 *  the directory yet and is not edited by this change (#749, #733, #717,
 *  #716); the shapes are pinned in lib/directory.ts instead. */
function visitorDb(): SupabaseClient {
  return createClient(resolveSupabaseUrl(), process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

/** Rows as the RPC returns them, narrowed to the public shape. Anything the
 *  RPC might one day add is dropped here rather than passed to a page. */
export function toDirectoryProfiles(rows: unknown): DirectoryProfile[] {
  if (!Array.isArray(rows)) return [];
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const asRow = (v: unknown) => (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return rows.flatMap((raw: unknown) => {
    const r = asRow(raw);
    if (typeof r.slug !== "string" || typeof r.display_name !== "string") return [];
    const services: unknown[] = Array.isArray(r.services) ? r.services : [];
    return [
      {
        slug: r.slug,
        display_name: r.display_name,
        logo_url: typeof r.logo_url === "string" ? r.logo_url : null,
        bio: typeof r.bio === "string" ? r.bio : null,
        service_lines: strs(r.service_lines),
        coverage_zips: strs(r.coverage_zips),
        coverage_cities: strs(r.coverage_cities),
        services: services.flatMap((raw: unknown) => {
          const s = asRow(raw);
          return typeof s.label === "string" && typeof s.service_line === "string"
            ? [
                {
                  label: s.label,
                  service_line: s.service_line,
                  price_from_cents:
                    typeof s.price_from_cents === "number" ? s.price_from_cents : null,
                  price_unit: typeof s.price_unit === "string" ? s.price_unit : null,
                },
              ]
            : [];
        }),
        published_at: typeof r.published_at === "string" ? r.published_at : null,
      },
    ];
  });
}

/** Rows of directory_public_listings narrowed to PUBLIC_LISTING_FIELDS: the
 *  profile's own fields as toDirectoryProfiles keeps them, plus tagline,
 *  highlights and areas (name and ZIPs only), the booking fields and the
 *  approved photos (url, alt, position). Anything else the view might one
 *  day carry is dropped here. */
export function toDirectoryListings(rows: unknown): DirectoryListing[] {
  if (!Array.isArray(rows)) return [];
  type Row = Record<string, unknown>;
  const isRow = (v: unknown): v is Row => !!v && typeof v === "object";
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const bySlug = new Map<string, Row>();
  for (const r of rows) if (isRow(r) && typeof r.slug === "string") bySlug.set(r.slug, r);
  return toDirectoryProfiles(rows).map((p) => {
    const r = bySlug.get(p.slug) ?? {};
    const areas: DirectoryArea[] = (Array.isArray(r.areas) ? r.areas : []).flatMap((a: unknown) =>
      isRow(a) && typeof a.name === "string" ? [{ name: a.name, zips: strs(a.zips) }] : [],
    );
    // The services as toDirectoryProfiles kept them, in the same order, each
    // with the three step-7 keys read from the row it came from. A mode this
    // reader does not know, or a row from a database the step-7 view has not
    // reached, reads request_only: the safe answer is always "ask".
    const rawServices = (Array.isArray(r.services) ? r.services : []).filter(
      (s: unknown): s is Row =>
        isRow(s) && typeof s.label === "string" && typeof s.service_line === "string",
    );
    const services: DirectoryListedService[] = p.services.map((svc, i) => {
      const raw = rawServices[i] ?? {};
      const mode: PublicBookingMode = isPublicBookingMode(raw.booking_mode)
        ? raw.booking_mode
        : "request_only";
      const pk = isRow(raw.package) ? raw.package : null;
      const pack: DirectoryPackage | null =
        mode === "package" &&
        pk &&
        typeof pk.name === "string" &&
        typeof pk.sessions_count === "number" &&
        typeof pk.price_cents === "number"
          ? { name: pk.name, sessions_count: pk.sessions_count, price_cents: pk.price_cents }
          : null;
      return {
        ...svc,
        // A package mode with no package to show is not sold here either.
        booking_mode: mode === "package" && !pack ? "request_only" : mode,
        booking_key: typeof raw.booking_key === "string" ? raw.booking_key : "",
        package: pack,
      };
    });
    const booksOnline =
      r.books_online === true && services.some((s) => s.booking_mode !== "request_only");
    // Photos (step 5b): url, alt and position only, a url only if it is the
    // HoundStack path the view makes for THIS listing, and never one without
    // alt text. A row from before step 5b reads as no photos.
    const photos: DirectoryPhoto[] = (Array.isArray(r.photos) ? r.photos : [])
      .flatMap((ph: unknown) =>
        isRow(ph) &&
        typeof ph.url === "string" &&
        isDirectoryPhotoUrl(ph.url, p.slug) &&
        typeof ph.alt === "string" &&
        ph.alt.trim() !== "" &&
        typeof ph.position === "number"
          ? [{ url: ph.url, alt: ph.alt, position: ph.position }]
          : [],
      )
      .sort((a, b) => a.position - b.position);
    return {
      ...p,
      services,
      tagline: typeof r.tagline === "string" ? r.tagline : null,
      highlights: strs(r.highlights),
      areas,
      books_online: booksOnline,
      booking_policy_text: typeof r.booking_policy_text === "string" ? r.booking_policy_text : null,
      book_path: booksOnline && typeof r.book_path === "string" ? r.book_path : null,
      photos,
    };
  });
}

/**
 * Search by service and ZIP.
 *
 * One call, with the publishable key and nothing else. The database answers
 * "which published profiles confirmed this ZIP for this line, and whose zones
 * do not now say 'outside' for it": since 20261112020000, directory_search
 * asks directory_zone_verdict (a port of lib/lead-service-area.ts's verdict)
 * itself, so a business whose CURRENT zones say "outside" is dropped without
 * the service role ever being used here. "unknown" (no zones, a lookup that
 * failed) keeps the listing: the owner confirmed the ZIP, and a false
 * "outside" costs more than a missing one. The standalone directory app (DIRECTORY_BRAND)
 * makes this same call with the same key.
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
    return { profiles: toDirectoryProfiles(rows) };
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
    tagline: string | null;
    highlights: string[];
    areas: DirectoryArea[];
    listed: Array<{ service_id: string; price_from_cents: number | null }>;
  };
  /** Book online on the directory (step 7): the owner's switch and policy,
   *  and the two other gates, so the page can say which one is missing. */
  booking: MyDirectoryBooking;
};

export type MyDirectoryBooking = {
  /** False on a database 20261112100000 has not reached: the switch is
   *  shown off and cannot be turned on yet. */
  available: boolean;
  enabled: boolean;
  policyText: string;
  publicSignupEnabled: boolean;
  chargesEnabled: boolean;
};

/** Postgres / PostgREST for "that column or function is not there yet". */
function notThereYet(error: { code?: string } | null | undefined): boolean {
  return ["42703", "PGRST204", "PGRST202", "42883"].includes(error?.code ?? "");
}

export const getMyDirectoryProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyDirectoryProfile> => {
    const { orgId, role } = await caller(context.supabase, context.userId);
    const sb = context.supabase as SupabaseClient;
    const [org, services, zones, profile, listed, areas, booking] = await Promise.all([
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
          "slug, published, display_name, show_logo, bio, coverage_zips, coverage_cities, confirmed_at, tagline, highlights",
        )
        .eq("organization_id", orgId)
        .maybeSingle(),
      sb
        .from("directory_profile_services")
        .select("service_id, price_from_cents, position")
        .eq("organization_id", orgId)
        .order("position"),
      sb
        .from("directory_profile_areas")
        .select("name, zips, position")
        .eq("organization_id", orgId)
        .order("position"),
      // Its own read, so a database without the step-7 columns costs the
      // switch and nothing else on the page.
      sb
        .from("organizations")
        .select(
          "directory_booking_enabled, booking_policy_text, public_signup_enabled, stripe_connect_charges_enabled",
        )
        .eq("id", orgId)
        .maybeSingle(),
    ]);
    const b = booking.error ? null : booking.data;
    if (booking.error && !notThereYet(booking.error))
      console.error("directory booking settings read failed", orgId, booking.error);
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
            ...(profile.data as Omit<
              NonNullable<MyDirectoryProfile["profile"]>,
              "listed" | "areas" | "highlights"
            >),
            highlights: (profile.data.highlights as string[] | null) ?? [],
            areas: ((areas.data ?? []) as Array<{ name: string; zips: string[] | null }>).map(
              (a) => ({ name: a.name, zips: a.zips ?? [] }),
            ),
            listed: (
              (listed.data ?? []) as Array<{ service_id: string; price_from_cents: number | null }>
            ).map((l) => ({ service_id: l.service_id, price_from_cents: l.price_from_cents })),
          }
        : null,
      booking: {
        available: !!b,
        enabled: b?.directory_booking_enabled === true,
        policyText: (b?.booking_policy_text as string | null) ?? "",
        publicSignupEnabled: b?.public_signup_enabled === true,
        chargesEnabled: b?.stripe_connect_charges_enabled === true,
      },
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
    tagline: z.string().transform(oneLine).pipe(z.string().max(DIRECTORY_TAGLINE_MAX)).nullable(),
    highlights: z
      .array(z.string().max(500))
      .max(20)
      .transform(cleanHighlights)
      .pipe(z.array(z.string().max(DIRECTORY_HIGHLIGHT_MAX)).max(DIRECTORY_HIGHLIGHTS_MAX)),
    areas: z
      .array(
        z.object({
          name: z.string().transform(oneLine).pipe(z.string().min(1).max(DIRECTORY_AREA_NAME_MAX)),
          zips: z
            .array(
              z
                .string()
                .trim()
                .regex(/^\d{5}$/),
            )
            .min(1)
            .max(200),
        }),
      )
      .max(DIRECTORY_AREAS_MAX),
    // Step 7. Optional, and OMITTED MEANS UNCHANGED (#929): a caller that
    // saves the profile without these two leaves the owner's switch and
    // policy as they are. Only a value that is sent is written: false turns
    // the switch off, and null or blank clears the policy.
    bookOnline: z.boolean().optional(),
    bookingPolicyText: z
      .string()
      .max(4000)
      .nullable()
      .optional()
      .transform((v) => (v === undefined ? undefined : cleanBookingPolicy(v)))
      .pipe(
        z
          .string()
          .max(BOOKING_POLICY_MAX, `Keep the policy to ${BOOKING_POLICY_MAX} characters.`)
          .nullable()
          .optional(),
      ),
  })
  .superRefine((v, ctx) => {
    for (const p of directoryContentProblems({
      tagline: v.tagline ?? "",
      highlights: v.highlights,
      areas: v.areas,
      coverageZips: v.coverageZips,
    })) {
      ctx.addIssue({ code: "custom", message: p.message });
    }
    if (v.published && !v.coverageZips.length) {
      ctx.addIssue({ code: "custom", message: "Add at least one ZIP code before you publish." });
    }
    if (v.published && !v.services.length) {
      ctx.addIssue({ code: "custom", message: "List at least one service before you publish." });
    }
  });

/** The switch and policy as a save asked for them: each one undefined when
 *  the caller left it out, which means "leave it as it is". */
export type DirectoryBookingInput = {
  bookOnline?: boolean;
  bookingPolicyText?: string | null;
};

/**
 * What set_directory_booking is called with, or null when nothing was sent
 * and nothing is written (#929). The writer takes both values, so a save
 * that sends only one carries the other through from `current` (what the
 * organization holds now). A field that was sent always wins, so an
 * explicit off or an explicit clear is still written.
 */
export function directoryBookingWrite(
  input: DirectoryBookingInput,
  current: { enabled: boolean; policyText: string | null } | null,
): { _enabled: boolean; _policy_text: string | null } | null {
  const sentSwitch = input.bookOnline !== undefined;
  const sentPolicy = input.bookingPolicyText !== undefined;
  if (!sentSwitch && !sentPolicy) return null;
  return {
    _enabled: sentSwitch ? input.bookOnline! : (current?.enabled ?? false),
    _policy_text: sentPolicy
      ? cleanBookingPolicy(input.bookingPolicyText)
      : cleanBookingPolicy(current?.policyText),
  };
}

/** Saves the directory switch and policy, touching neither unless the
 *  caller sent it (#929). Exported for its test. */
export async function saveDirectoryBooking(
  supabase: unknown,
  orgId: string,
  input: DirectoryBookingInput,
): Promise<void> {
  const sb = supabase as any;
  const sentSwitch = input.bookOnline !== undefined;
  const sentPolicy = input.bookingPolicyText !== undefined;
  if (!sentSwitch && !sentPolicy) return;
  // Only one was sent: read the other, so the writer puts it back as it was.
  let current: { enabled: boolean; policyText: string | null } | null = null;
  if (!sentSwitch || !sentPolicy) {
    const { data: row, error } = await sb
      .from("organizations")
      .select("directory_booking_enabled, booking_policy_text")
      .eq("id", orgId)
      .maybeSingle();
    if (error) {
      // Not there yet: nothing to keep, and the write below says so.
      if (!notThereYet(error)) throw new Error(error.message);
    } else if (!row) {
      throw new Error("Your profile was saved, but Book online could not be read. Try again.");
    } else {
      current = {
        enabled: row.directory_booking_enabled === true,
        policyText: (row.booking_policy_text as string | null) ?? null,
      };
    }
  }
  const write = directoryBookingWrite(input, current)!;
  const { error: bErr } = await sb.rpc("set_directory_booking", { _org: orgId, ...write });
  if (bErr) {
    // On a database the step-7 migration has not reached there is nothing
    // to save unless the owner asked for something.
    if (notThereYet(bErr) && !write._enabled && !write._policy_text) return;
    if (notThereYet(bErr))
      throw new Error(
        "Your profile was saved. Book online and the policy can't be saved yet: try again later.",
      );
    throw new Error(bErr.message);
  }
}

export const saveMyDirectoryProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => directoryProfileSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId, role } = await caller(context.supabase, context.userId);
    if (role !== "owner") throw new Error(ONLY_AN_OWNER_CHANGES_THE_DIRECTORY);
    const sb = context.supabase as SupabaseClient;
    const { error } = await sb.rpc("set_directory_profile", {
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
      _tagline: data.tagline,
      _highlights: data.highlights,
      _areas: data.areas.map((a) => ({ name: a.name, zips: a.zips })),
    });
    if (error) {
      if (/directory_profiles_slug_key|duplicate key/i.test(error.message)) {
        throw new Error("That web address is taken. Try another.");
      }
      throw new Error(error.message);
    }
    // The directory switch and policy (step 7), owner-only in the database
    // too, and written only when the caller sent them (#929).
    await saveDirectoryBooking(context.supabase, orgId, data);
    return { ok: true };
  });
