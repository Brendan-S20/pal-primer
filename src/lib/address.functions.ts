// Address-search server functions: the backend proxy in front of the
// AddressProvider (API keys never reach the browser). When no provider is
// configured these degrade gracefully - the UI shows plain manual entry.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";

// Best-effort abuse guards for the paid Google proxy: a short-TTL cache so
// each keystroke doesn't re-average the org's properties, and a per-user
// sliding window so a scripted client can't run up the Places bill.
const biasCache = new Map<
  string,
  { at: number; value: { latitude: number; longitude: number } | null }
>();
const BIAS_TTL_MS = 60_000;
const rateBuckets = new Map<string, number[]>();
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_CALLS = 30;

function checkRate(userId: string): void {
  const now = Date.now();
  const hits = (rateBuckets.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_CALLS)
    throw new Error("Too many address searches. Slow down a moment.");
  hits.push(now);
  rateBuckets.set(userId, hits);
  if (rateBuckets.size > 1000) {
    for (const [k, v] of rateBuckets)
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateBuckets.delete(k);
  }
}

/** Rough center of the org's service area, used to bias and rank
 * autocomplete results: the business's own geocoded address first, then the
 * average of its geocoded properties, then its zone centers. See
 * serviceAreaCenter in lib/address/near-business.ts for why the business
 * location leads (#783: a new business has no properties, and its bias used
 * to be null, which is how Lansing got Council Bluffs). */
export async function workspaceBias(
  supabase: any,
  orgId: string,
): Promise<{ latitude: number; longitude: number } | null> {
  const cached = biasCache.get(orgId);
  if (cached && Date.now() - cached.at < BIAS_TTL_MS) return cached.value;
  const { serviceAreaCenter } = await import("@/lib/address/near-business");
  const { data: org } = await supabase
    .from("organizations")
    .select("latitude, longitude")
    .eq("id", orgId)
    .maybeSingle();
  let value = serviceAreaCenter({ business: org ?? null });
  if (!value) {
    const { data: props } = await supabase
      .from("properties")
      .select("latitude, longitude")
      .eq("organization_id", orgId)
      .not("latitude", "is", null)
      .limit(100);
    value = serviceAreaCenter({ properties: props ?? [] });
  }
  if (!value) {
    const { data: zones } = await supabase
      .from("zones")
      .select("center_latitude, center_longitude, latitude, longitude")
      .eq("organization_id", orgId)
      .limit(20);
    value = serviceAreaCenter({ zones: zones ?? [] });
  }
  biasCache.set(orgId, { at: Date.now(), value });
  return value;
}

/** Is smart address search available? The UI uses this to decide between
 * the autocomplete input and plain manual fields. */
export const addressSearchStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { getAddressProvider } = await import("@/lib/address/index.server");
    const provider = getAddressProvider();
    return { enabled: !!provider, provider: provider?.name ?? null };
  });

export const autocompleteAddress = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        query: z.string().min(3).max(200),
        sessionToken: z.string().min(8).max(64).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { getAddressProvider } = await import("@/lib/address/index.server");
    const provider = getAddressProvider();
    if (!provider) return { suggestions: [] };
    checkRate(context.userId);
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const bias = await workspaceBias(context.supabase, orgId);
    const raw = await provider.autocomplete(data.query, {
      bias,
      sessionToken: data.sessionToken,
    });
    // Nearest first and nothing a business could not plausibly serve, when
    // we know where the business is (#783). The distance is internal: the
    // browser gets the same three fields it always did.
    const { nearBusinessFirst } = await import("@/lib/address/near-business");
    const suggestions = nearBusinessFirst(raw, { centerKnown: !!bias }).map(
      ({ id, mainText, secondaryText }) => ({ id, mainText, secondaryText }),
    );
    return { suggestions };
  });

export const resolveAddress = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        placeId: z.string().min(3).max(300),
        sessionToken: z.string().min(8).max(64).optional(),
        // The row the person picked, as shown (#805). Only a fallback for
        // the street line when Google's components have no house number.
        mainText: z.string().max(300).optional(),
        secondaryText: z.string().max(300).optional(),
        accountType: z.enum(["residential", "commercial"]).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { getAddressProvider } = await import("@/lib/address/index.server");
    const provider = getAddressProvider();
    if (!provider) throw new Error("Address search isn't configured");
    checkRate(context.userId);
    const details = await provider.details(data.placeId, {
      sessionToken: data.sessionToken,
      suggestion: { mainText: data.mainText ?? null, secondaryText: data.secondaryText ?? null },
    });
    if (!details) throw new Error("Couldn't load that address. Enter it manually instead.");

    // Automatic zone lookup from the resolved point + ZIP (same matcher the
    // rest of the app uses).
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const { data: zones } = await context.supabase
      .from("zones")
      .select(
        "id, name, priority, account_type, postal_prefix, zip_codes, geo_match_mode, boundary, center_latitude, center_longitude, radius_meters, drive_time_minutes, enabled",
      )
      .eq("organization_id", orgId);
    const { matchZone } = await import("@/lib/zone-match");
    const zone = matchZone((zones ?? []) as any[], {
      postalCode: details.postalCode,
      point:
        details.latitude != null && details.longitude != null
          ? { lat: details.latitude, lng: details.longitude }
          : null,
      accountType: data.accountType ?? null,
    });

    return {
      address: details,
      zoneId: zone ? (zone.id as string) : null,
      zoneName: zone ? ((zone as any).name as string) : null,
    };
  });
