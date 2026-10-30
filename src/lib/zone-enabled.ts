// Turning a zone off and on (#449). Pure: the server function and the Zones
// page both read these, so the count the confirm shows and the count the
// activity log records are the same count.
//
// What "off" means is decided in three places, all of which read `enabled`:
//   - matchZone (zone-match.ts) skips it, so address lookup, new properties,
//     the office quote, the receptionist and the leads list never pick it;
//   - public_quote (20261029180000) skips it, so the signup page and the lead
//     form cannot quote from it;
//   - redetectZonesForOrg leaves a property already in it where it is, so
//     that client keeps their schedule and price.
// Routing never reads a zone: it plans the visits that exist. A client kept
// in an off zone keeps their visits and is routed as before, and an off zone
// gains no new clients to route.

import type { AppRole } from "@/hooks/useMyRole";

/** Only an owner turns a zone on or off. Dispatchers and office managers see
 *  the status. The database holds the same rule (tg_zones_enabled_owner_only). */
export function canToggleZone(role: AppRole | null | undefined): boolean {
  return role === "owner";
}

export interface ZonePropertyRow {
  id: string;
  client_id: string | null;
  zone_id: string | null;
}

export interface ActiveServiceRow {
  client_id: string | null;
  property_id: string | null;
}

/** Distinct clients with an active service on a property in each zone. */
export function activeClientsByZone(
  properties: readonly ZonePropertyRow[],
  activeServices: readonly ActiveServiceRow[],
): Record<string, number> {
  const zoneOf = new Map<string, string>();
  for (const p of properties) if (p.zone_id) zoneOf.set(p.id, p.zone_id);
  const clients = new Map<string, Set<string>>();
  for (const s of activeServices) {
    if (!s.property_id || !s.client_id) continue;
    const zone = zoneOf.get(s.property_id);
    if (!zone) continue;
    if (!clients.has(zone)) clients.set(zone, new Set());
    clients.get(zone)!.add(s.client_id);
  }
  const out: Record<string, number> = {};
  for (const [zone, set] of clients) out[zone] = set.size;
  return out;
}

/**
 * The zone columns to write after a property's address is edited.
 * `autoZoneId` is what the matcher says now, which never names an off zone.
 *   - In an off zone: nothing changes, so the client keeps the zone, its
 *     schedule and its price. The same rule as redetectZonesForOrg.
 *   - A manual override: only the detected zone is refreshed.
 *   - Otherwise the effective zone follows the detected one.
 */
export function zonePatchAfterEdit(input: {
  autoZoneId: string | null;
  hasOverride: boolean;
  inOffZone: boolean;
}): { auto_zone_id?: string | null; zone_id?: string | null } {
  if (input.inOffZone) return {};
  if (input.hasOverride) return { auto_zone_id: input.autoZoneId };
  return { auto_zone_id: input.autoZoneId, zone_id: input.autoZoneId };
}

const clientsWord = (n: number) => `${n} active ${n === 1 ? "client" : "clients"}`;

/** Status label for the switch. */
export function zoneStatusLabel(enabled: boolean): "On" | "Off" {
  return enabled ? "On" : "Off";
}

/** The plain sentence a zone card and the drawer show while a zone is off. */
export function offZoneNotice(activeClients: number): string {
  const base =
    "Off. New addresses, the signup page and the lead form skip this zone. Its shape, ZIPs and pricing are kept.";
  return activeClients > 0
    ? `${base} ${clientsWord(activeClients)} in it keep their schedule and price.`
    : base;
}

/** The confirm shown before turning off a zone with active clients, or null
 *  when there is nobody in it and the switch can just flip. */
export function turnOffConfirm(
  zoneName: string,
  activeClients: number,
): { title: string; description: string; confirmLabel: string } | null {
  if (activeClients <= 0) return null;
  return {
    title: `Turn off ${zoneName}?`,
    description: `${zoneName} has ${clientsWord(activeClients)}. They keep their schedule and price. New addresses, the signup page and the lead form will skip this zone until you turn it back on.`,
    confirmLabel: "Turn off zone",
  };
}

export function toggledToast(zoneName: string, enabled: boolean, propertiesUpdated = 0): string {
  const head = enabled ? `${zoneName} is on.` : `${zoneName} is off.`;
  if (enabled && propertiesUpdated > 0) {
    return `${head} ${propertiesUpdated} ${propertiesUpdated === 1 ? "property" : "properties"} joined it.`;
  }
  return head;
}
