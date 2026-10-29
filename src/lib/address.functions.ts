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
const biasCache = new Map<string, { at: number; value: { latitude: number; longitude: number } | null }>();
const BIAS_TTL_MS = 60_000;
const rateBuckets = new Map<string, number[]>();
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_CALLS = 30;

function checkRate(userId: string): void {
  const now = Date.now();
  const hits = (rateBuckets.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_CALLS) throw new Error("Too many address searches. Slow down a moment.");
  hits.push(now);
  rateBuckets.set(userId, hits);
  if (rateBuckets.size > 1000) {
    for (const [k, v] of rateBuckets) if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateBuckets.delete(k);
  }
}

/** Rough center of the org's service area (average of geocoded properties,
 * falling back to zone centers) used to bias autocomplete results. */
async function workspaceBias(
  supabase: any,
  orgId: string,
): Promise<{ latitude: number; longitude: number } | null> {
  const cached = biasCache.get(orgId);
  if (cached && Date.now() - cached.at < BIAS_TTL_MS) return cached.value;
  const { data: props } = await supabase
    .from("properties")
    .select("latitude, longitude")
    .eq("organization_id", orgId)
    .not("latitude", "is", null)
    .limit(100);
  const pts = (props ?? []).filter((p: any) => p.latitude != null && p.longitude != null);
  if (pts.length > 0) {
    const value = {
      latitude: pts.reduce((s: number, p: any) => s + Number(p.latitude), 0) / pts.length,
      longitude: pts.reduce((s: number, p: any) => s + Number(p.longitude), 0) / pts.length,
    };
    biasCache.set(orgId, { at: Date.now(), value });
    return value;
  }
  const { data: zones } = await supabase
    .from("zones")
    .select("center_latitude, center_longitude, latitude, longitude")
    .eq("organization_id", orgId)
    .limit(20);
  const zpts = (zones ?? [])
    .map((z: any) => ({
      latitude: Number(z.center_latitude ?? z.latitude),
      longitude: Number(z.center_longitude ?? z.longitude),
    }))
    .filter((p: any) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
  if (zpts.length > 0) {
    const value = {
      latitude: zpts.reduce((s: number, p: any) => s + p.latitude, 0) / zpts.length,
      longitude: zpts.reduce((s: number, p: any) => s + p.longitude, 0) / zpts.length,
    };
    biasCache.set(orgId, { at: Date.now(), value });
    return value;
  }
  biasCache.set(orgId, { at: Date.now(), value: null });
  return null;
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
    const suggestions = await provider.autocomplete(data.query, {
      bias,
      sessionToken: data.sessionToken,
    });
    return { suggestions };
  });

export const resolveAddress = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        placeId: z.string().min(3).max(300),
        sessionToken: z.string().min(8).max(64).optional(),
        accountType: z.enum(["residential", "commercial"]).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { getAddressProvider } = await import("@/lib/address/index.server");
    const provider = getAddressProvider();
    if (!provider) throw new Error("Address search isn't configured");
    checkRate(context.userId);
    const details = await provider.details(data.placeId, { sessionToken: data.sessionToken });
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
