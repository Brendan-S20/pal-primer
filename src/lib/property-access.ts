// Lock box code, key location and key tag. Plain SELECT of those columns is
// revoked. This asks property_access_codes, which answers for the office
// (view_client_directory) or the tech assigned to a visit at the property
// today. A miss, including a failed call, is empty codes: the rest of the
// property still loads, and the code is not shown.
//
// The map holds only the rows the function returned. accessLoaded tells a
// property whose codes came back empty from one whose codes were refused or
// failed to load. An editor needs that, or saving blank fields would wipe
// codes it was never shown.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type PropertyAccessCodes = {
  lock_box_code: string | null;
  key_location: string | null;
  key_tag: string | null;
};

const EMPTY: PropertyAccessCodes = {
  lock_box_code: null,
  key_location: null,
  key_tag: null,
};

export async function readPropertyAccess(
  supabase: SupabaseClient<Database>,
  propertyIds: Array<string | null | undefined>,
): Promise<Map<string, PropertyAccessCodes>> {
  const ids = [...new Set(propertyIds.filter((id): id is string => !!id))];
  const out = new Map<string, PropertyAccessCodes>();
  if (!ids.length) return out;
  const { data, error } = await supabase.rpc("property_access_codes", {
    _property_ids: ids,
  });
  if (error) {
    console.warn("property access codes could not be loaded");
    return out;
  }
  for (const row of data ?? []) {
    out.set(row.property_id, {
      lock_box_code: row.lock_box_code,
      key_location: row.key_location,
      key_tag: row.key_tag,
    });
  }
  return out;
}

export function accessFor(
  map: Map<string, PropertyAccessCodes>,
  propertyId: string | null | undefined,
): PropertyAccessCodes {
  if (!propertyId) return EMPTY;
  return map.get(propertyId) ?? EMPTY;
}

/** Whether property_access_codes returned this property's row. False when the
 *  caller may not read the codes or the call failed. */
export function accessLoaded(
  map: Map<string, PropertyAccessCodes>,
  propertyId: string | null | undefined,
): boolean {
  return !!propertyId && map.has(propertyId);
}

/** Puts the codes onto each visit's property. The visit query must not
 *  select the columns itself. */
export async function stampVisitAccess<V extends { property_id?: string | null; properties?: unknown }>(
  supabase: SupabaseClient<Database>,
  visits: V[],
): Promise<V[]> {
  const access = await readPropertyAccess(
    supabase,
    visits.map((v) => v.property_id),
  );
  return visits.map((v) => {
    if (!v.properties || typeof v.properties !== "object" || Array.isArray(v.properties)) return v;
    return {
      ...v,
      properties: { ...v.properties, ...accessFor(access, v.property_id) },
    };
  });
}
