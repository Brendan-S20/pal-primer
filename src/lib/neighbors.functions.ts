import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { hasPermission } from "@/lib/permissions";

// Door-to-door canvassing is a FIELD activity: the /neighbors route admits
// techs, and Walk mode lets them log individual doors (add / status update /
// remove a prospect). Those individual-lead writes need only org membership,
// scoped to the caller's org (the neighbor_leads write RLS is plain
// membership). SEEDING, however, reads a CLIENT's property address to generate
// the surrounding doors, so it is gated on view_client_directory
// (dispatcher/office/owner, not techs) per I7.
async function resolveMemberOrgId(supabase: any, userId: string): Promise<string> {
  return (await resolveCaller(supabase, userId)).orgId;
}
/**
 * Who may seed doors around a given client.
 *
 * The directory holders may seed around anyone. A technician may seed around a
 * client THEY ARE ASSIGNED TO -- which is the canvassing case as it actually
 * happens: you are at the house, you knock next door. That is not a widening of
 * the client directory, because it grants nothing the tech could not already
 * read: My Day hands them that client's name, address and gate code to do the
 * work with.
 *
 * Reported from an iPhone as "I can't select a client to go off of for
 * neighbors/doors" -- the picker was hidden behind view_client_directory, and
 * this function was the reason it would not have worked even if shown.
 */
async function resolveSeederOrgId(
  supabase: any,
  userId: string,
  clientId: string,
): Promise<string> {
  const caller = await resolveCaller(supabase, userId);
  if (hasPermission(caller.role, "view_client_directory", caller.overrides)) return caller.orgId;

  const { data: staffRow } = await supabase
    .from("staff")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (staffRow?.id) {
    const { data: mine } = await supabase
      .from("visits")
      .select("id")
      .eq("organization_id", caller.orgId)
      .eq("assigned_staff_id", staffRow.id)
      .eq("client_id", clientId)
      .limit(1)
      .maybeSingle();
    if (mine) return caller.orgId;
  }
  throw new Error("Not authorized");
}

/**
 * The clients a caller may seed canvassing doors around.
 *
 * Directory holders get the roster. Everyone else gets the clients on their own
 * work -- distinct clients from the visits assigned to them -- so a technician
 * has a picker with real names in it without the client list being handed to a
 * role the product deliberately keeps it from.
 */
export const listCanvassSeedClients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const caller = await resolveCaller(supabase, userId);

    if (hasPermission(caller.role, "view_client_directory", caller.overrides)) {
      const { data, error } = await supabase
        .from("clients")
        .select("id, display_name")
        .eq("organization_id", caller.orgId)
        .eq("active", true)
        .order("display_name")
        .limit(500);
      if (error) throw new Error(error.message);
      return { clients: (data ?? []) as Array<{ id: string; display_name: string }>, scope: "org" };
    }

    const { data: staffRow } = await supabase
      .from("staff")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!staffRow?.id) return { clients: [], scope: "mine" as const };

    const { data, error } = await supabase
      .from("visits")
      .select("client_id, clients(display_name)")
      .eq("organization_id", caller.orgId)
      .eq("assigned_staff_id", staffRow.id)
      .not("client_id", "is", null)
      .limit(500);
    if (error) throw new Error(error.message);

    const seen = new Map<string, string>();
    for (const r of (data ?? []) as any[]) {
      const name = r.clients?.display_name;
      if (r.client_id && name && !seen.has(r.client_id)) seen.set(r.client_id, name);
    }
    return {
      clients: [...seen.entries()]
        .map(([id, display_name]) => ({ id, display_name }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
      scope: "mine" as const,
    };
  });

export type NeighborLead = {
  id: string;
  seed_client_id: string | null;
  seed_client_name: string | null;
  address_line: string;
  latitude: number | null;
  longitude: number | null;
  status: "new" | "contacted" | "interested" | "converted" | "not_interested";
  notes: string | null;
  contacted_at: string | null;
  created_at: string;
};

export const listNeighborLeads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId, role, overrides } = await resolveCaller(context.supabase, context.userId);
    const canSeeDirectory = hasPermission(role, "view_client_directory", overrides);
    const { data, error } = await context.supabase
      .from("neighbor_leads")
      .select(
        "id, seed_client_id, address_line, latitude, longitude, status, notes, contacted_at, created_at, clients:seed_client_id(display_name)",
      )
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    const rows: NeighborLead[] = (data ?? []).map((r: any) => ({
      id: r.id,
      seed_client_id: canSeeDirectory ? r.seed_client_id : null,
      seed_client_name: canSeeDirectory ? (r.clients?.display_name ?? null) : null,
      address_line: r.address_line,
      latitude: r.latitude,
      longitude: r.longitude,
      status: r.status,
      notes: r.notes,
      contacted_at: r.contacted_at,
      created_at: r.created_at,
    }));
    const summary = rows.reduce(
      (acc, r) => {
        acc.total++;
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      },
      { total: 0 } as Record<string, number>,
    );
    return { rows, summary };
  });

const addSchema = z.object({
  addressLine: z.string().min(3).max(240),
  seedClientId: z.string().uuid().optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

export const addNeighborLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => addSchema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveMemberOrgId(context.supabase, context.userId);
    const { data: row, error } = await context.supabase
      .from("neighbor_leads")
      .insert({
        organization_id: orgId,
        address_line: data.addressLine,
        seed_client_id: data.seedClientId || null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        notes: data.notes || null,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

const seedSchema = z.object({
  clientId: z.string().uuid(),
  count: z.number().int().min(1).max(20).default(5),
});

/**
 * Seed neighbor leads for a client by generating addresses at even offsets
 * from that client's house number on the same street, then GEOCODING each one
 * and keeping only the doors that turned out to exist.
 *
 * ── WHY IT GEOCODES ──────────────────────────────────────────────────────
 *
 * It used to write `latitude: prop.latitude, longitude: prop.longitude` on
 * every generated row -- the seed client's own coordinate, copied onto each of
 * its neighbours. Ten doors down a street would be ten rows on one point, and
 * the map would draw one pin where a street of doors should be.
 *
 * That is read off the code, not off production: the 23 canvassing leads in
 * the demo workspace arrived in four bulk inserts, and not one of the six
 * tagged to a seed client has an address on that client's street -- rows
 * reading "332 Smith St, New York, NY 10011" are tagged to a client at 1061
 * Blair Ave, Royal Oak, MI. They are hand-made demo data, and no row there
 * came out of this function. What production DOES show is the shape of the
 * fault regardless of who wrote it: 23 distinct addresses on 3 distinct
 * coordinates, because a canvassing lead's point has never had to have
 * anything to do with its text.
 *
 * Generating a house number is a guess. Copying a coordinate onto it is a
 * guess presented as a measurement, and the walk order, the map and the
 * "Navigate" link all read it as one. So each candidate now goes through the
 * same provider the address field uses: what comes back is a real door in a
 * real place, and what does not come back is dropped rather than invented.
 *
 * Two calls per door and at most 20 doors, on a button an office user pressed
 * deliberately. With no provider configured the addresses are still generated
 * -- a tech standing on the street can read the house numbers -- but they are
 * stored with NO coordinate rather than a borrowed one, and the map says so.
 */
export const seedNeighborsForClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => seedSchema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveSeederOrgId(context.supabase, context.userId, data.clientId);
    const { data: prop } = await context.supabase
      .from("properties")
      .select("street, city, region, postal_code, latitude, longitude")
      .eq("client_id", data.clientId)
      .limit(1)
      .maybeSingle();
    if (!prop?.street) throw new Error("Client has no property with a street address");

    // Parse house number from start of street
    const m = /^(\d+)\s+(.*)$/.exec(prop.street.trim());
    if (!m) throw new Error("Could not parse street number");
    const base = Number(m[1]);
    const rest = m[2];

    const tail =
      `${prop.city ? `, ${prop.city}` : ""}${prop.region ? `, ${prop.region}` : ""}` +
      `${prop.postal_code ? ` ${prop.postal_code}` : ""}`;

    // Doors this workspace already knows about, so pressing Seed twice does not
    // double the street and so a tech is never sent to knock on the door of
    // somebody who already pays them. Both are cheap reads and both were
    // missing; the second is the one that is embarrassing in the field.
    const [{ data: existingLeads }, { data: ownProps }] = await Promise.all([
      context.supabase.from("neighbor_leads").select("address_line").eq("organization_id", orgId),
      context.supabase.from("properties").select("street").eq("organization_id", orgId),
    ]);
    const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
    const known = new Set<string>();
    for (const r of (existingLeads ?? []) as Array<{ address_line?: string | null }>)
      if (r.address_line) known.add(norm(r.address_line));
    const ownStreets = new Set<string>();
    for (const r of (ownProps ?? []) as Array<{ street?: string | null }>)
      if (r.street) ownStreets.add(norm(r.street));

    const candidates: string[] = [];
    for (let i = 1; candidates.length < data.count && i <= 20; i++) {
      const offset = i * 2;
      for (const delta of [offset, -offset]) {
        const n = base + delta;
        if (n <= 0) continue;
        if (ownStreets.has(norm(`${n} ${rest}`))) continue;
        candidates.push(`${n} ${rest}${tail}`);
        if (candidates.length >= data.count) break;
      }
    }

    const { getAddressProvider } = await import("@/lib/address/index.server");
    const provider = getAddressProvider();

    type Row = {
      organization_id: string;
      seed_client_id: string;
      address_line: string;
      latitude: number | null;
      longitude: number | null;
      created_by: string;
    };
    const rows: Row[] = [];
    let unresolved = 0;
    let duplicates = 0;

    for (const candidate of candidates) {
      let line = candidate;
      let latitude: number | null = null;
      let longitude: number | null = null;

      if (provider) {
        // The provider answers about places that exist. A generated house
        // number that is a vacant lot, a parking structure, or simply not a
        // number this street uses comes back with nothing, and that is the
        // answer -- not a reason to store the guess anyway.
        try {
          const [best] = await provider.autocomplete(candidate, {
            bias:
              prop.latitude != null && prop.longitude != null
                ? { latitude: Number(prop.latitude), longitude: Number(prop.longitude) }
                : null,
          });
          const details = best ? await provider.details(best.id) : null;
          if (!details) {
            unresolved++;
            continue;
          }
          line = details.formatted || candidate;
          latitude = details.latitude;
          longitude = details.longitude;
        } catch {
          // A provider outage must not turn Seed into an error. Fall through
          // and store the generated line with no coordinate, which is what an
          // unconfigured workspace gets and is honest about what is known.
          unresolved++;
          continue;
        }
      }

      if (known.has(norm(line))) {
        duplicates++;
        continue;
      }
      known.add(norm(line));
      rows.push({
        organization_id: orgId,
        seed_client_id: data.clientId,
        address_line: line,
        latitude,
        longitude,
        created_by: context.userId,
      });
    }

    if (rows.length === 0) return { added: 0, unresolved, duplicates, geocoded: !!provider };
    const { error } = await context.supabase.from("neighbor_leads").insert(rows);
    if (error) throw new Error(error.message);
    return { added: rows.length, unresolved, duplicates, geocoded: !!provider };
  });

const updateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["new", "contacted", "interested", "converted", "not_interested"]).optional(),
  notes: z.string().max(1000).optional().nullable(),
});

export const updateNeighborLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updateSchema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveMemberOrgId(context.supabase, context.userId);
    const patch: any = {};
    if (data.status) {
      patch.status = data.status;
      if (data.status === "contacted") patch.contacted_at = new Date().toISOString();
    }
    if (data.notes !== undefined) patch.notes = data.notes;
    const { error } = await context.supabase
      .from("neighbor_leads")
      .update(patch)
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteNeighborLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveMemberOrgId(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("neighbor_leads")
      .delete()
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Where a door signs up, and whether it can.
 *
 * Walk mode's "Sign up" runs the real signup flow (quote, details, card) at
 * the doorstep, and that flow is addressed by the org's public slug. The
 * settings surface that also knows this (`getSignupSettings`) is gated on
 * manage_settings, which a technician does not hold and should not need: the
 * slug is on every yard sign and the enabled bit decides only which of two
 * panels the sheet shows. Membership is the right gate, same as every other
 * read on this page.
 *
 * `effectiveSlug` mirrors the RPC's preference order (portal_slug first), so
 * the sheet signs people up at the same address the org's own links use.
 */
export const getCanvassSignupTarget = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveMemberOrgId(context.supabase, context.userId);
    const { data: org, error } = await context.supabase
      .from("organizations")
      .select("slug, portal_slug, public_signup_enabled")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      effectiveSlug: (org?.portal_slug as string | null) ?? (org?.slug as string | null) ?? null,
      enabled: !!org?.public_signup_enabled,
    };
  });
