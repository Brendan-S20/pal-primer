import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getMyLiveShare,
  postLiveLocation,
  stopLiveLocation,
  type MyLiveShare,
} from "@/lib/live-tracking.functions";
import { POST_INTERVAL_MS } from "@/lib/live-tracking";

/**
 * Share the tech's position with the customer of THIS visit, while the
 * "on my way" window is open, and only while the app is on screen.
 *
 * Every card on My Day calls this with its own visit; they all read one
 * shared query (`["live-share"]`), and only the card the server names as
 * active starts watching the device. The window itself is decided twice: by
 * the server here (getMyLiveShare), and by the database on every write
 * (may_share_live_location), so a phone that has the rule wrong is refused
 * rather than believed.
 *
 * Stops on: the visit leaving `scheduled` (start, complete, skip), the two
 * hours running out, the tech pressing Stop, the server refusing a write, the
 * card unmounting (the app closed or the tech left My Day), and pauses while
 * the page is hidden — "only while the app is open" is enforced here as well
 * as by the OS.
 */

export const LIVE_SHARE_QUERY_KEY = ["live-share"] as const;

export type ShareState =
  | { kind: "off" }
  /** Tracking is on for the business, and this is the tech's next stop:
   *  Navigate will start sharing. Shown so it is never a surprise. */
  | { kind: "armed" }
  | {
      kind: "sharing";
      customerName: string;
      until: Date;
      /** Null until the device answers; "denied" means the tech said no. */
      problem: "denied" | "unavailable" | null;
      stop: () => void;
      stopping: boolean;
    };

type Fix = { lat: number; lng: number; accuracy: number | null; at: number };

/** A fix older than this is not posted: a phone that has lost the sky (a
 *  garage, a tunnel) must not keep telling the customer where it last was as
 *  if it were now. The page stops drawing a position 10 minutes after the
 *  last post, so this is the stricter of the two. */
const STALE_FIX_MS = 2 * 60_000;

export function useShareLocationEnRoute(visit: { id: string; status: string }): ShareState {
  const qc = useQueryClient();
  const loadFn = useServerFn(getMyLiveShare);
  const postFn = useServerFn(postLiveLocation);
  const stopFn = useServerFn(stopLiveLocation);

  const q = useQuery<MyLiveShare>({
    queryKey: LIVE_SHARE_QUERY_KEY,
    queryFn: () => loadFn(),
    // Off for the business: ask once and leave it. On: ask again every 30s
    // and on every return to the app, which is when a tech who tapped
    // Navigate (and so left for the maps app) comes back.
    refetchInterval: (query) => (query.state.data?.enabled ? POST_INTERVAL_MS : false),
    refetchOnWindowFocus: true,
    staleTime: 15_000,
    retry: false,
  });

  const data = q.data;
  const active =
    data?.enabled && data.active && data.active.visitId === visit.id && visit.status === "scheduled"
      ? data.active
      : null;
  const until = active ? new Date(active.until) : null;
  const untilMs = until?.getTime() ?? 0;

  const [problem, setProblem] = useState<"denied" | "unavailable" | null>(null);
  const [stopping, setStopping] = useState(false);
  const [expired, setExpired] = useState(false);
  const [refused, setRefused] = useState(false);
  const latest = useRef<Fix | null>(null);

  const sharing = !!active && !expired && !refused;

  // A new window (a newer "on my way", or another visit) starts clean.
  useEffect(() => {
    setExpired(false);
    setRefused(false);
    setProblem(null);
    latest.current = null;
  }, [active?.visitId, untilMs]);

  // The two hours end on the phone too, not only on the server.
  useEffect(() => {
    if (!active) return;
    const ms = untilMs - Date.now();
    if (ms <= 0) {
      setExpired(true);
      return;
    }
    const t = setTimeout(() => setExpired(true), ms);
    return () => clearTimeout(t);
  }, [active?.visitId, untilMs]);

  // Watch the device while sharing.
  useEffect(() => {
    if (!sharing) return;
    let cancelled = false;
    let stopWatch: (() => void) | null = null;
    const onFix = (lat: number, lng: number, accuracy: number | null) => {
      latest.current = { lat, lng, accuracy, at: Date.now() };
      setProblem(null);
    };

    (async () => {
      try {
        const { watchPositionNative } = await import("@/lib/native");
        const native = await watchPositionNative(
          (p) => onFix(p.latitude, p.longitude, p.accuracy),
          (reason) => setProblem(reason),
        );
        if (native) {
          if (cancelled) native();
          else stopWatch = native;
          return;
        }
      } catch {
        /* fall through to the browser */
      }
      if (cancelled) return;
      if (typeof navigator === "undefined" || !navigator.geolocation) {
        setProblem("unavailable");
        return;
      }
      const id = navigator.geolocation.watchPosition(
        (p) => onFix(p.coords.latitude, p.coords.longitude, p.coords.accuracy ?? null),
        (e) => setProblem(e.code === e.PERMISSION_DENIED ? "denied" : "unavailable"),
        { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
      );
      stopWatch = () => navigator.geolocation.clearWatch(id);
    })();

    return () => {
      cancelled = true;
      stopWatch?.();
    };
  }, [sharing, visit.id]);

  // Post the latest fix every 30 seconds: throttled by construction, however
  // often the device reports, and sent again when the tech is standing still
  // (a watch reports movement, not time) so the customer's "updated" stays
  // true. Never a stale fix, and never while the page is hidden.
  useEffect(() => {
    if (!sharing) return;
    const send = async () => {
      const fix = latest.current;
      if (!fix || Date.now() - fix.at > STALE_FIX_MS) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      try {
        const r = await postFn({
          data: { visitId: visit.id, lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy },
        });
        if (r.stop) {
          setRefused(true);
          qc.invalidateQueries({ queryKey: LIVE_SHARE_QUERY_KEY });
        }
      } catch (e) {
        console.warn("live location post failed", visit.id, e);
      }
    };
    // The first fix goes as soon as there is one, then every 30s.
    const first = setInterval(() => {
      if (latest.current) {
        clearInterval(first);
        void send();
      }
    }, 1_000);
    const every = setInterval(() => void send(), POST_INTERVAL_MS);
    return () => {
      clearInterval(first);
      clearInterval(every);
    };
  }, [sharing, visit.id, postFn, qc]);

  const stop = useCallback(() => {
    setStopping(true);
    setRefused(true);
    stopFn({ data: { visitId: visit.id } })
      .catch((e) => console.warn("stop sharing failed", visit.id, e))
      .finally(() => {
        setStopping(false);
        qc.invalidateQueries({ queryKey: LIVE_SHARE_QUERY_KEY });
      });
  }, [stopFn, visit.id, qc]);

  if (sharing && active && until) {
    return {
      kind: "sharing",
      customerName: active.customerName,
      until,
      problem,
      stop,
      stopping,
    };
  }
  if (data?.enabled && data.nextVisitId === visit.id && visit.status === "scheduled") {
    return { kind: "armed" };
  }
  return { kind: "off" };
}
