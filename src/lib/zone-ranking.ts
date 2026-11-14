// Service areas are ranked, and the ranking settles a ZIP two of them list.
//
// Brendan, 2026-11-10 (#858): "have it auto fill, and then there should be a
// ranking system for priority; sometimes the zip codes are going to
// automatically overlap and there's too much steps to walkthrough and
// manually fix that." Every drawn area now fills its own ZIPs on save
// (zones.functions.ts), so two circles that touch both list the ZIPs where
// they meet, and somebody has to say which one gets an address there.
//
// ── THE RANK IS THE PRIORITY ──────────────────────────────────────────────
//
// `zones.priority` has been the overlap tie-breaker since 20260716201000:
// among zones that match an address at the same level (two that list the ZIP,
// two circles that both hold the pin), the higher number wins, in
// zone-match.ts and in public_quote alike. A ranking is that number with the
// typing taken away: rank 1 is the highest priority, and reordering the list
// writes the whole business's priorities as N down to 1. Nothing that reads
// `priority` -- the matcher, the signup quote, the redetect, the coverage
// check -- changes, which is the point: the rule stays one rule.
//
// What the ranking does NOT change is the specificity ladder above it. A
// drawn polygon that holds an address's pin still beats any zone that merely
// lists the ZIP, whatever their ranks, because a pin inside a drawn boundary
// is a more exact claim than a five-digit code. The ranking decides among
// equals, which with filled ZIPs is most overlaps: a visitor who types a ZIP
// on the signup page, a lead form, a new client with no pin yet.
//
// ── WHO WON WHAT ──────────────────────────────────────────────────────────
//
// "Won" and "lost" are not computed here by comparing priorities. Each ZIP is
// put to matchZone with a postal code and no pin, the way the signup page and
// the lead form ask, so what the screen says a zone won is what a visitor in
// that ZIP is quoted from. If the matcher's tie-break ever changes, this
// follows it with no change here.

import { matchZone, zoneIsOn, type ZoneMatchFields } from "./zone-match";

export interface RankedZone extends ZoneMatchFields {
  id: string;
  name: string;
  created_at?: string | null;
}

/** The business's areas top to bottom: highest priority first. Equal
 *  priorities -- a business the migration has not reached, or two areas
 *  written with the same typed number -- fall back to id, which is the
 *  matcher's own last tie-break, so the list reads in the order the matcher
 *  would pick. */
export function rankedZones<Z extends RankedZone>(zones: readonly Z[]): Z[] {
  return [...zones].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.id).localeCompare(String(b.id)),
  );
}

/** 1-based rank of each zone in the ranking. */
export function rankOf<Z extends RankedZone>(zones: readonly Z[]): Map<string, number> {
  return new Map(rankedZones(zones).map((z, i) => [z.id, i + 1]));
}

/** The priorities to write for a top-to-bottom order: the top gets N, the
 *  bottom gets 1. Dense, so a later "move up" is always one swap away and a
 *  new area at the bottom (priority 0) is below every one of them. */
export function prioritiesForOrder(idsTopToBottom: readonly string[]): Map<string, number> {
  const n = idsTopToBottom.length;
  return new Map(idsTopToBottom.map((id, i) => [id, n - i]));
}

/** The order the server writes for a reorder request: the ids the caller
 *  sent, in their order, then any of the business's areas it left out in
 *  their current order. Ids that are not the business's are dropped. */
export function fullOrder<Z extends RankedZone>(
  requested: readonly string[],
  zones: readonly Z[],
): string[] {
  const known = new Set(zones.map((z) => z.id));
  const out: string[] = [];
  for (const id of requested) if (known.has(id) && !out.includes(id)) out.push(id);
  for (const z of rankedZones(zones)) if (!out.includes(z.id)) out.push(z.id);
  return out;
}

/** The lowest priority the schema accepts (zones.functions.ts). */
export const MIN_PRIORITY = -999;

/** Where a new area goes: the bottom of the list (#858, "new areas go to the
 *  bottom"). One below the business's lowest, or 0 for its first area. When
 *  that would fall under the floor, the whole list is renumbered densely
 *  first and the new one takes 0 beneath it. */
export function placeAtBottom<Z extends RankedZone>(
  zones: readonly Z[],
): { priority: number; renumber: Map<string, number> | null } {
  if (zones.length === 0) return { priority: 0, renumber: null };
  const lowest = Math.min(...zones.map((z) => z.priority ?? 0));
  if (lowest - 1 >= MIN_PRIORITY) return { priority: lowest - 1, renumber: null };
  return { priority: 0, renumber: prioritiesForOrder(rankedZones(zones).map((z) => z.id)) };
}

/** Move one area a step up or down the ranking. The order returned is the
 *  whole list, top to bottom. */
export function moveInRanking<Z extends RankedZone>(
  zones: readonly Z[],
  id: string,
  direction: "up" | "down",
): string[] {
  const order = rankedZones(zones).map((z) => z.id);
  const i = order.indexOf(id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= order.length) return order;
  [order[i], order[j]] = [order[j], order[i]];
  return order;
}

/** Which zone gets a visitor in each ZIP any zone that is on lists: the
 *  matcher's answer for the ZIP alone. */
export function zipWinners<Z extends RankedZone>(zones: readonly Z[]): Map<string, Z> {
  const on = zones.filter(zoneIsOn);
  const out = new Map<string, Z>();
  const seen = new Set<string>();
  for (const z of on) {
    for (const zip of z.zip_codes ?? []) {
      if (seen.has(zip)) continue;
      seen.add(zip);
      const winner = matchZone(on, { postalCode: zip });
      if (winner) out.set(zip, winner);
    }
  }
  return out;
}

export interface ZipOutcome {
  id: string;
  name: string;
  /** Listed ZIPs a visitor in which is quoted from this zone. */
  won: string[];
  /** Listed ZIPs that go to another zone, by that zone. */
  lostTo: Array<{ id: string; name: string; zips: string[] }>;
}

/** For each zone that is on: which of its ZIPs it keeps and which a
 *  higher-ranked zone takes. A zone that is off matches nothing and is
 *  skipped; its ZIPs stay listed for the day it is turned back on. */
export function zipOutcomes<Z extends RankedZone>(zones: readonly Z[]): ZipOutcome[] {
  const winners = zipWinners(zones);
  return zones.filter(zoneIsOn).map((z) => {
    const won: string[] = [];
    const lost = new Map<string, { id: string; name: string; zips: string[] }>();
    for (const zip of new Set(z.zip_codes ?? [])) {
      const w = winners.get(zip);
      if (!w || w.id === z.id) {
        won.push(zip);
        continue;
      }
      const entry = lost.get(w.id) ?? { id: w.id, name: w.name, zips: [] };
      entry.zips.push(zip);
      lost.set(w.id, entry);
    }
    return { id: z.id, name: z.name, won, lostTo: [...lost.values()] };
  });
}

/** The warning Brendan asked for (#858, "Yes, warn the owner"): an area that
 *  lists ZIPs and keeps none of them, because higher-ranked areas take them
 *  all. A partial overlap is not warned about; an area with no ZIPs listed
 *  at all is a different problem (the fill), said elsewhere. */
export function areasWithNoZipLeft<Z extends RankedZone>(zones: readonly Z[]): ZipOutcome[] {
  return zipOutcomes(zones).filter(
    (o) => o.won.length === 0 && o.lostTo.some((l) => l.zips.length > 0),
  );
}

const quoteName = (name: string) => `“${name}”`;

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One sentence naming the area and the area or areas that took its ZIPs. */
export function noZipLeftSentence(o: ZipOutcome): string {
  const takers = joinNames(o.lostTo.map((l) => quoteName(l.name)));
  const n = o.lostTo.reduce((s, l) => s + l.zips.length, 0);
  const zips = n === 1 ? "its only ZIP" : `all ${n} of its ZIPs`;
  const rank = o.lostTo.length === 1 ? "ranks higher" : "rank higher";
  return `${quoteName(o.name)} keeps none of its ZIPs: ${takers} ${rank} and ${o.lostTo.length === 1 ? "takes" : "take"} ${zips}. Move ${quoteName(o.name)} up to give it ZIPs back, or change its area.`;
}

/** The short note under an area in the ranking: what it keeps and loses. */
export function outcomeSummary(o: ZipOutcome | undefined, listed: number): string {
  if (listed === 0) return "No ZIPs listed";
  if (!o) return `${listed} ${listed === 1 ? "ZIP" : "ZIPs"} listed, off`;
  const lost = o.lostTo.reduce((s, l) => s + l.zips.length, 0);
  const kept = `${o.won.length} of ${listed} ${listed === 1 ? "ZIP" : "ZIPs"}`;
  if (lost === 0) return `${kept}`;
  const takers = joinNames(o.lostTo.map((l) => quoteName(l.name)));
  return `${kept}, ${lost} to ${takers}`;
}
