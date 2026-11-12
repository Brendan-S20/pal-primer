// The ranking of a business's service areas (#858), and the warning for an
// area the ranking has left with no ZIPs.
//
// Brendan, 2026-11-10: "there should be a ranking system for priority;
// sometimes the zip codes are going to automatically overlap and there's too
// much steps to walkthrough and manually fix that." Now that every drawn
// area fills its ZIPs on save, two areas that touch both list the ZIPs where
// they meet. This list says which one gets them: the higher one. Rules in
// src/lib/zone-ranking.ts; the rank is zones.priority, written densely by
// reorderZones.
//
// Buttons rather than a drag handle: a drag is hover-and-mouse on the
// desktop and a fight with the scroll on a phone, and the owner does this
// on both. "Move up" and "Move down" are 44px on touch, keyboard-reachable,
// and one tap is one swap. Nothing here is hover-only.
//
// Lives in its own file so the Zones page, which #870 is moving into
// Settings, takes it with one line.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowDown, ArrowUp, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { reorderZones } from "@/lib/zones.functions";
import {
  areasWithNoZipLeft,
  moveInRanking,
  noZipLeftSentence,
  outcomeSummary,
  rankedZones,
  zipOutcomes,
  type RankedZone,
} from "@/lib/zone-ranking";
import { cn } from "@/lib/utils";

type RankingZone = RankedZone & {
  enabled?: boolean | null;
  zip_fill_pending_since?: string | null;
};

export function ZoneRankingPanel({
  zones,
  canEdit,
}: {
  zones: readonly RankingZone[];
  canEdit: boolean;
}) {
  const reorderFn = useServerFn(reorderZones);
  const qc = useQueryClient();
  const ranked = useMemo(() => rankedZones(zones), [zones]);
  const outcomes = useMemo(() => {
    const m = new Map<string, ReturnType<typeof zipOutcomes>[number]>();
    for (const o of zipOutcomes(zones)) m.set(o.id, o);
    return m;
  }, [zones]);
  const warnings = useMemo(() => areasWithNoZipLeft(zones), [zones]);

  const reorderM = useMutation({
    mutationFn: (ids: string[]) => reorderFn({ data: { ids } }),
    onSuccess: (r: { propertiesUpdated: number }) => {
      toast.success(
        r.propertiesUpdated > 0
          ? `Ranking saved. ${r.propertiesUpdated} ${r.propertiesUpdated === 1 ? "property" : "properties"} re-assigned.`
          : "Ranking saved.",
      );
      qc.invalidateQueries({ queryKey: ["zones"] });
      qc.invalidateQueries({ queryKey: ["zone-coverage"] });
    },
    onError: (e: unknown) => toast.error(`Could not save the ranking: ${(e as Error).message}`),
  });

  if (zones.length < 2) return null;

  const move = (id: string, direction: "up" | "down") =>
    reorderM.mutate(moveInRanking(zones, id, direction));

  return (
    <Card className="p-3 sm:p-4" data-testid="zone-ranking">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Ranking</h2>
          <p className="text-xs text-muted-foreground">
            When two zones list the same ZIP, the higher one here gets its addresses and quotes.
            A new zone starts at the bottom. Changing the order affects new visits and lookups
            only.
          </p>
        </div>
      </div>
      {warnings.length > 0 && (
        <ul
          role="status"
          data-testid="zone-no-zips-left"
          className="mt-3 space-y-1 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/20"
        >
          {warnings.map((w) => (
            <li key={w.id} className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
              <span className="min-w-0 break-words">{noZipLeftSentence(w)}</span>
            </li>
          ))}
        </ul>
      )}
      <ol className="mt-3 divide-y" aria-label="Zone ranking">
        {ranked.map((z, i) => {
          const listed = new Set(z.zip_codes ?? []).size;
          const outcome = outcomes.get(z.id);
          const lostAll = warnings.some((w) => w.id === z.id);
          return (
            <li
              key={z.id}
              data-testid="zone-rank-row"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5"
            >
              <span className="w-6 shrink-0 text-end text-sm tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1 basis-40">
                <p
                  className={cn(
                    "truncate text-sm font-medium",
                    z.enabled === false && "text-muted-foreground",
                  )}
                >
                  {z.name}
                  {z.enabled === false ? " (off)" : ""}
                </p>
                <p
                  className={cn(
                    "text-xs",
                    lostAll ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
                  )}
                >
                  {z.zip_fill_pending_since
                    ? "ZIPs pending: the lookup failed when this zone was saved. It is retried each time this page opens."
                    : outcomeSummary(outcome, listed)}
                </p>
              </div>
              {canEdit && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label={`Move ${z.name} up`}
                    disabled={i === 0 || reorderM.isPending}
                    onClick={() => move(z.id, "up")}
                  >
                    <ArrowUp className="h-4 w-4 shrink-0" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label={`Move ${z.name} down`}
                    disabled={i === ranked.length - 1 || reorderM.isPending}
                    onClick={() => move(z.id, "down")}
                  >
                    <ArrowDown className="h-4 w-4 shrink-0" />
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/** On a zone's card: a save whose ZIP lookup failed (#858). */
export function ZipFillPendingNote({ zone }: { zone: { zip_fill_pending_since?: string | null } }) {
  if (!zone.zip_fill_pending_since) return null;
  return (
    <p className="mt-2 text-xs text-amber-700 dark:text-amber-300" data-testid="zone-zip-pending">
      ZIPs pending: the ZIP lookup failed when this zone was saved. It is retried each time this
      page opens, and the zone still matches an address inside its area meanwhile.
    </p>
  );
}
