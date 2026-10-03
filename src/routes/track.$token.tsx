// Public live-tracking page: /track/{token}. The link in the "on my way" text
// and email when the business has live tracking on. No account: the
// unguessable visits.tracking_token is the capability, the same model as the
// quote link (/q/{token}) and the pay link (/pay/i/{token}).
//
// What it can show is decided in the database, by public_visit_tracking
// (supabase/migrations/20260929100000_nobody-could-see-the-truck-coming.sql):
//
//   en route  the tech's position rounded to about 100 m, only while the tech
//             is sharing and the fix is under 10 minutes old, plus the
//             property's, rounded the same way, and the arrival window.
//   arrived   "Your tech has arrived". No location of anybody.
//   done      the visit is complete. Nothing locational.
//   ended     two hours after the message, or skipped / cancelled. Nothing.
//
// Asks again every 30 seconds while there is something that can change.
// Opened from a text on a phone essentially always, so it is laid out for
// 320px first; the map is the only wide thing and it is as wide as its card.
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { CheckCircle2, Clock, Home, Loader2, MapPin, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getPublicTracking } from "@/lib/live-tracking.functions";
import {
  PUBLIC_POLL_MS,
  trackingHeadline,
  updatedAgo,
  type PublicTracking,
} from "@/lib/live-tracking";
import { customerTitle } from "@/lib/page-title";

const TrackingMap = lazy(() => import("@/components/TrackingMap"));

export const Route = createFileRoute("/track/$token")({
  head: () => ({
    meta: [
      { title: customerTitle("Your tech is on the way") },
      // A capability URL: never indexed, never sent onward as a referrer.
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: PublicTrackingPage,
});

type Found = Extract<PublicTracking, { found: true }>;

function PublicTrackingPage() {
  const { token } = Route.useParams();
  const getFn = useServerFn(getPublicTracking);
  const q = useQuery({
    queryKey: ["public-tracking", token],
    queryFn: () => getFn({ data: { token } }),
    retry: 1,
    refetchInterval: (query) => {
      const d = query.state.data;
      return d?.found && (d.status === "en_route" || d.status === "arrived")
        ? PUBLIC_POLL_MS
        : false;
    },
    refetchOnWindowFocus: true,
  });

  if (q.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> Loading…
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="mx-auto max-w-lg space-y-3 p-6 text-center">
        <h1 className="text-lg font-semibold">This page could not be loaded</h1>
        <p className="text-sm text-muted-foreground">Please try again in a moment.</p>
        <Button variant="outline" onClick={() => q.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!q.data || !q.data.found) {
    return (
      <div className="mx-auto max-w-lg space-y-2 p-6 text-center">
        <h1 className="text-lg font-semibold">This tracking link isn&apos;t valid</h1>
        <p className="text-sm text-muted-foreground">
          The link may have been mistyped. Please contact the business that sent it.
        </p>
      </div>
    );
  }
  return <Tracking data={q.data} />;
}

function Tracking({ data }: { data: Found }) {
  const who = data.techName ?? "Your tech";
  return (
    <main className="mx-auto max-w-xl space-y-4 p-4 sm:p-6">
      <header className="space-y-1">
        <p className="text-sm font-medium text-muted-foreground break-words">{data.businessName}</p>
        <h1 className="text-2xl font-semibold break-words">
          {trackingHeadline(data.status, data.techName)}
        </h1>
        {data.status === "en_route" && data.eta ? (
          <p className="flex items-start gap-1.5 text-base">
            <Clock className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0">Arriving {data.eta}</span>
          </p>
        ) : null}
      </header>

      {data.status === "en_route" ? (
        <EnRoute data={data} who={who} />
      ) : (
        <div className="flex items-start gap-3 rounded-xl border bg-card p-4 text-sm">
          {data.status === "arrived" ? (
            <Truck className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" aria-hidden />
          ) : (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
          )}
          <p className="min-w-0">
            {data.status === "arrived"
              ? `${who} is at your property now. The map is off while the visit is under way.`
              : data.status === "done"
                ? "Thank you. This link no longer shows a location."
                : "This link no longer shows a location. If you are still expecting a visit today, contact the business that sent it."}
          </p>
        </div>
      )}
    </main>
  );
}

function EnRoute({ data, who }: { data: Found; who: string }) {
  // Leaflet needs `window`: draw after mount, never on the server.
  const [mounted, setMounted] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  useEffect(() => setMounted(true), []);
  const hasPoints = !!(data.tech || data.home);
  const ago = updatedAgo(data.tech?.recordedAt);

  return (
    <section className="space-y-3">
      <div className="overflow-hidden rounded-xl border bg-muted">
        {mounted && hasPoints && !mapFailed ? (
          <Suspense fallback={<div className="h-64 w-full sm:h-80" aria-hidden />}>
            <TrackingMap tech={data.tech} home={data.home} onFail={() => setMapFailed(true)} />
          </Suspense>
        ) : (
          <div className="flex min-h-32 items-center gap-3 p-4 text-sm">
            <MapPin className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            <p className="min-w-0">
              {mapFailed
                ? "The map could not be loaded. The arrival time above is still current."
                : hasPoints
                  ? "Loading the map…"
                  : "The map will appear here once the location is available."}
            </p>
          </div>
        )}
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 shrink-0 rounded-full bg-blue-600" aria-hidden />
          {data.tech ? `${who}, approximately` : `${who}: location not shared right now`}
        </li>
        {data.home ? (
          <li className="flex items-center gap-1.5">
            <Home className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
            Your property
          </li>
        ) : null}
      </ul>

      <p className="text-xs text-muted-foreground">
        {ago ? `${ago}. ` : ""}
        Positions are rounded to about 100 m, and are shared only from the &ldquo;on my way&rdquo;
        message until {who === "Your tech" ? "your tech" : who} arrives, while their app is open.
        This page updates by itself.
      </p>
    </section>
  );
}
