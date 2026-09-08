// Do this organization's zones actually cover its customers?
//
// Nothing in the product asks that question, and on 2026-09-08 the demo
// organization answered it badly: two zones scoped to New York ZIPs
// (10001-10003, 10023-10024, with a boundary drawn over Manhattan) and 110 of
// 110 active properties in Michigan. Running the real matcher over the real
// rows returned NO MATCH for every one of them.
//
// The damage that does is quiet, which is why it needs a screen rather than a
// log line:
//
//   * A rate card that reaches nobody looks identical to one that reaches
//     everybody. The zones page lists two healthy-looking zones either way.
//   * `properties.zone_id` OUTLIVES the configuration that produced it. 54 of
//     those Michigan properties still carry a zone with `auto_zone_id` set --
//     assignments made when the zones were configured differently, which no
//     re-run of the matcher would reproduce today. Every screen that reads
//     `zone_id` therefore reports a zone the rules no longer agree with, and
//     it reports it with a straight face.
//   * Anything built on zones (pricing, the drift report, routing) inherits
//     both problems and cannot tell either from a correct answer.
//
// ── WHAT "STALE" MEANS HERE, PRECISELY ─────────────────────────────────────
//
// Stale is "the stored answer differs from the answer the matcher gives
// today", in EITHER direction:
//
//   stored a zone, matcher says none      -> orphaned (the 54 above)
//   stored a zone, matcher says a DIFFERENT one -> reassigned
//   stored nothing, matcher says a zone   -> unassigned
//
// All three are drift between data and rules. They are counted separately
// because they need different actions: an orphan means the zone moved out
// from under the property, a reassignment means boundaries changed, and an
// unassigned one means a redetect never ran or was never triggered.
//
// ── WHY THIS RECOMPUTES RATHER THAN TRUSTING auto_zone_id ──────────────────
//
// `auto_zone_id` records what the matcher said WHEN IT LAST RAN, which is
// exactly the value that goes stale. Comparing it against `zone_id` would
// only find manual overrides. The question here is what the matcher says NOW,
// so the only way to answer it is to run the matcher now.

import { matchZone, type ZoneMatchFields } from "@/lib/zone-match";

export interface CoverageZone extends ZoneMatchFields {
  id: string;
  name: string;
}

export interface CoverageProperty {
  id: string;
  postalCode: string | null;
  point: { lat: number; lng: number } | null;
  accountType: "residential" | "commercial" | null;
  /** What the row says today. */
  storedZoneId: string | null;
}

export type CoverageVerdict =
  | "agrees"
  | "orphaned"
  | "reassigned"
  | "unassigned"
  | "uncovered";

export interface CoverageRow {
  propertyId: string;
  storedZoneId: string | null;
  /** What the matcher says today, recomputed. Null when nothing matches. */
  matchedZoneId: string | null;
  matchedZoneName: string | null;
  verdict: CoverageVerdict;
}

export interface ZoneCoverage {
  total: number;
  /** The matcher assigns some zone today. */
  covered: number;
  /** The matcher assigns nothing today, whatever the row stores. */
  uncovered: number;
  /** Rows where stored and recomputed disagree, any direction. */
  stale: number;
  orphaned: number;
  reassigned: number;
  unassigned: number;
  /** Per zone, how many properties it would win today. A zone with 0 here is
   *  a rate card nobody is on. */
  perZone: Array<{ zoneId: string; zoneName: string; wouldMatch: number }>;
  rows: CoverageRow[];
}

export function computeZoneCoverage(
  zones: CoverageZone[],
  properties: CoverageProperty[],
): ZoneCoverage {
  const perZone = new Map<string, { zoneId: string; zoneName: string; wouldMatch: number }>();
  for (const z of zones) perZone.set(z.id, { zoneId: z.id, zoneName: z.name, wouldMatch: 0 });

  const rows: CoverageRow[] = properties.map((p) => {
    const m = matchZone(zones, {
      postalCode: p.postalCode,
      point: p.point,
      accountType: p.accountType,
    });
    if (m) {
      const entry = perZone.get(m.id);
      if (entry) entry.wouldMatch += 1;
    }

    const matchedZoneId = m?.id ?? null;
    let verdict: CoverageVerdict;
    if (matchedZoneId === p.storedZoneId) {
      // Includes both-null: a property in no zone that the matcher also puts
      // in no zone is CONSISTENT, even though it is uncovered. The two facts
      // are separate and the summary reports them separately.
      verdict = matchedZoneId === null ? "uncovered" : "agrees";
    } else if (matchedZoneId === null) {
      verdict = "orphaned";
    } else if (p.storedZoneId === null) {
      verdict = "unassigned";
    } else {
      verdict = "reassigned";
    }

    return {
      propertyId: p.id,
      storedZoneId: p.storedZoneId,
      matchedZoneId,
      matchedZoneName: m?.name ?? null,
      verdict,
    };
  });

  const count = (v: CoverageVerdict) => rows.filter((r) => r.verdict === v).length;
  const orphaned = count("orphaned");
  const reassigned = count("reassigned");
  const unassigned = count("unassigned");

  return {
    total: rows.length,
    covered: rows.filter((r) => r.matchedZoneId !== null).length,
    uncovered: rows.filter((r) => r.matchedZoneId === null).length,
    stale: orphaned + reassigned + unassigned,
    orphaned,
    reassigned,
    unassigned,
    perZone: [...perZone.values()],
    rows,
  };
}

/**
 * The one sentence worth putting at the top of the zones page, or null when
 * there is nothing wrong worth interrupting for.
 *
 * Returns null on an org with no properties: a new account has not failed to
 * cover its customers, it has no customers, and an alarm there would train
 * people to ignore this one. Same for zero zones, which is the state every
 * org starts in.
 */
export function describeCoverageProblem(c: ZoneCoverage): string | null {
  if (c.total === 0 || c.perZone.length === 0) return null;

  if (c.covered === 0) {
    return `None of your ${c.total} properties fall inside any zone you have set up. Every rate card here currently applies to nobody.`;
  }

  const dead = c.perZone.filter((z) => z.wouldMatch === 0);
  const parts: string[] = [];

  if (c.uncovered > 0) {
    parts.push(`${c.uncovered} of ${c.total} properties fall outside every zone`);
  }
  if (c.orphaned > 0) {
    parts.push(
      `${c.orphaned} still carry a zone the rules would no longer give them`,
    );
  }
  if (dead.length > 0) {
    parts.push(
      dead.length === 1
        ? `${dead[0].zoneName} matches no properties`
        : `${dead.length} zones match no properties`,
    );
  }

  if (parts.length === 0) return null;
  return `${parts.join(", ")}.`;
}
