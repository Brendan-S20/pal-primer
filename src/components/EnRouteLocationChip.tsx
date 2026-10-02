import { MapPin, Radio } from "lucide-react";
import { useShareLocationEnRoute } from "@/hooks/useShareLocationEnRoute";
import { orgLocalTime } from "@/lib/org-day";
import { useOrgTimezone } from "@/hooks/useOrgToday";

/**
 * What the tech sees about live tracking, on the visit card it concerns.
 *
 * Sharing: "Sharing your location with <customer> until you arrive", with a
 * Stop button. Always visible while it is happening, never hidden behind a
 * menu, because it is the tech's location and the tech has to know.
 *
 * Armed: on the next stop only, a one-line note that tracking is on for the
 * business, so the first time it starts is not a surprise.
 *
 * Renders nothing otherwise, including for every card when the business has
 * tracking off. My Day renders this with one line per card.
 */
export function EnRouteLocationChip({ visit }: { visit: { id: string; status: string } }) {
  const s = useShareLocationEnRoute(visit);
  const tz = useOrgTimezone();

  if (s.kind === "off") return null;

  if (s.kind === "armed") {
    return (
      <p className="mb-3 flex items-start gap-1.5 text-xs text-muted-foreground">
        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          Live tracking is on. Once this customer is told you&apos;re on the way, they can see
          your approximate location until you start the visit (2 hours at most), while this app
          is open.
        </span>
      </p>
    );
  }

  return (
    <div
      role="status"
      className="mb-3 flex items-center gap-2 rounded-lg border border-blue-500/40 bg-blue-500/10 p-2 pl-3 text-sm text-blue-900 dark:text-blue-200"
    >
      <Radio className="h-4 w-4 shrink-0 animate-pulse" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-medium break-words">
          Sharing your location with {s.customerName} until you arrive
        </div>
        <div className="text-xs opacity-80">
          {s.problem === "denied"
            ? "Location is turned off for this app, so they see the arrival time only."
            : s.problem === "unavailable"
              ? "Waiting for a location fix."
              : `Approximate, while this app is open. Ends when you start, or at ${orgLocalTime(s.until, tz)}.`}
        </div>
      </div>
      <button
        type="button"
        onClick={s.stop}
        disabled={s.stopping}
        className="shrink-0 rounded-md border border-blue-500/50 bg-background px-3 text-sm font-medium min-h-9 touch:min-h-11 touch:min-w-11 disabled:opacity-50"
      >
        {s.stopping ? "Stopping…" : "Stop"}
      </button>
    </div>
  );
}
