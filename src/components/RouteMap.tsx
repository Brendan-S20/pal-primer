import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isNative, getPositionNative, openAppSettings, platform } from "@/lib/native";
import { AlertTriangle, Loader2, LocateFixed } from "lucide-react";
import type { TileVariant } from "@/lib/map-tiles";
import { useMapRenderer } from "@/lib/maps/use-map-renderer";
import {
  OverlayGroup,
  US_VIEW,
  type LatLng,
  type LineHandle,
  type MarkerHandle,
  type ReadOnlyMapRenderer,
} from "@/lib/maps/types";

export type MapVisit = {
  id: string;
  sequence?: number | null;
  status?: string;
  clients?: { display_name?: string | null } | null;
  zones?: { name?: string | null } | null;
  properties?: {
    street?: string | null;
    city?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  } | null;
};

export type TechGroup = {
  staffId: string | null;
  name: string;
  color: string;
  /** Set only in perDay mode. One group per tech per day, so a polyline never
   *  joins stops from different days — `sequence` restarts at 1 each morning. */
  day?: string;
  visits: MapVisit[];
  startLat?: number | null;
  startLng?: number | null;
  startAddress?: string | null;
  endLat?: number | null;
  endLng?: number | null;
  endAddress?: string | null;
};

const TECH_COLORS = [
  "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed",
  "#0891b2", "#db2777", "#65a30d", "#c026d3", "#0d9488",
];

function prettyStatus(s?: string) {
  if (s === "in_progress") return "In progress";
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/** "Tue 12 Aug" — the pin has to say WHICH day on a week or month map. */
function formatDay(iso?: string | null) {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function statusEmoji(s?: string) {
  if (s === "completed") return "✓";
  if (s === "skipped") return "⤼";
  if (s === "in_progress") return "▶";
  return "";
}

/* ────────────────────────────────────────────────────────────────────────────
 * Wheel zoom, and why it is gated instead of simply switched on
 * ───────────────────────────────────────────────────────────────────────────
 *
 * QA asked for "scrolling to zoom in and out", and it should indeed be a basic
 * function. The obvious fix — `scrollWheelZoom: true` — is the one thing we
 * must not do here, and the reason is where this map lives: it is DOCKED BESIDE
 * THE CALENDAR on /routes and inside the card on the dashboard. A person
 * scrolling the schedule passes the pointer over the map constantly, and a map
 * that grabs the wheel turns "read the rest of the week" into "the page froze
 * and the map is now at street level in Kansas". On a laptop trackpad, where a
 * scroll is two fingers and happens by the dozen, that is not an annoyance; it
 * is a page you cannot read.
 *
 * So the wheel is handled by us, not by Leaflet's handler, under this rule:
 *
 *   UNAMBIGUOUS gestures always act on the map.
 *     - ctrl/⌘ + wheel. It is also, usefully, exactly what a trackpad PINCH
 *       emits: the browser reports a pinch as a wheel event with `ctrlKey`
 *       set, so pinch-to-zoom on a MacBook works without anyone being told.
 *     - two-finger pinch on a touchscreen (Leaflet's `touchZoom`, left on).
 *       Two fingers on a map is never a request to scroll the page.
 *
 *   AMBIGUOUS gestures go to the page until the map is ARMED by clicking or
 *   tapping it — after which a plain wheel zooms, which is the "basic
 *   function" that was asked for, one click away and with no modifier to
 *   remember. Pointing at a thing and then turning the wheel is the same
 *   contract Google Maps and every embedded map on the web uses.
 *     - a plain wheel with the map un-armed → the page scrolls, and we show a
 *       hint saying which two things WOULD have zoomed. Silently doing nothing
 *       is how a gate like this gets reported as a broken map.
 *     - a one-finger drag on touch is the same problem wearing gloves, so
 *       `dragging` starts disabled on mobile and the same tap arms it.
 *
 * The map disarms when a MOUSE pointer leaves it, so arming one map does not
 * follow you up the page. A touch pointer "leaving" is not a thing you can
 * observe, so touch stays armed until the component unmounts.
 */

/** What a wheel event over the map should do. Spelled out as words rather than
 *  a boolean so the call site — and the test — read as the decision they are. */
export type WheelOutcome = "zoom the map" | "let the page scroll";

/** The whole gate, kept pure so it can be tested without a browser, a Leaflet
 *  instance or a wheel. `metaKey` as well as `ctrlKey`: ⌘+scroll is the muscle
 *  memory on macOS, and a Mac user who tries it and gets nothing concludes the
 *  modifier idea does not work here. */
export function wheelZoomIntent(
  e: { ctrlKey?: boolean; metaKey?: boolean },
  armed: boolean,
): WheelOutcome {
  if (e.ctrlKey || e.metaKey) return "zoom the map";
  return armed ? "zoom the map" : "let the page scroll";
}

/** Pixels of accumulated wheel travel per zoom level. Leaflet's own default is
 *  60 and it feels right; borrowing the number keeps the gated wheel feeling
 *  like the handler it replaces. */
export const WHEEL_PX_PER_ZOOM = 60;

/** Wheel deltas in PIXELS, sign flipped so positive means "zoom in".
 *
 *  `deltaMode` is not a formality: Firefox on Windows reports lines (mode 1,
 *  ~3 per notch) and some setups report pages (mode 2). Reading `deltaY` raw
 *  gives a map that needs twenty notches per zoom level on one browser and
 *  jumps four levels on another. */
export function normalizeWheelDelta(e: { deltaY: number; deltaMode?: number }): number {
  const mode = e.deltaMode ?? 0;
  const px = mode === 1 ? e.deltaY * 16 : mode === 2 ? e.deltaY * 400 : e.deltaY;
  return -px;
}

/* ────────────────────────────────────────────────────────────────────────────
 * "Where am I", and what to say when the browser will not tell us
 * ───────────────────────────────────────────────────────────────────────────
 *
 * The Geolocation API fails in four ordinary ways and every one of them is
 * invisible unless something says so out loud: the user denied it once weeks
 * ago and the browser now refuses without prompting; the device has no fix; it
 * timed out; or the page is not in a SECURE CONTEXT.
 *
 * That last one is the trap in local dev. `navigator.geolocation` is exposed
 * only over https or on localhost — open the dev server from a phone on the LAN
 * (http://192.168.x.x:5173) and the object is either missing entirely or every
 * call fails with POSITION_UNAVAILABLE, which reads as "your phone is broken"
 * rather than "this page is http". So the message says it.
 *
 * These two functions are pure and exported for exactly one reason: the denial
 * path is the one that must never be silent, and a message you can assert on
 * is a message that stays.
 */

/** W3C GeolocationPositionError codes. Named because `err.code === 1` at a call
 *  site tells the next reader nothing, and the constants live on an instance we
 *  do not have when we are only handed a plain object. */
export const GEOLOCATION_PERMISSION_DENIED = 1;
export const GEOLOCATION_POSITION_UNAVAILABLE = 2;
export const GEOLOCATION_TIMEOUT = 3;

/** What to show when there is no Geolocation API at all. */
export function geolocationUnsupportedMessage(secureContext: boolean): string {
  return secureContext
    ? "This browser does not offer location. You can still pan and zoom the map by hand."
    : "Location needs a secure connection. This page is on plain http, so the browser hides location entirely. Open it over https (or on localhost) and press this again.";
}

/** What to show when a NATIVE fix fails.
 *
 *  Separate from the browser messages because every way out those offer is
 *  wrong inside an app: there is no "site settings" on an iPhone, https is not
 *  something the tech can change, and an iOS denial is cleared in Settings
 *  rather than by pressing the button again — the system prompt does not come
 *  back. Pure and exported for the same reason as its browser twin: the denial
 *  path must never be silent, and a message you can assert on is one that
 *  stays. */
export function nativeGeolocationErrorMessage(
  reason: "denied" | "unavailable" | "timeout",
  os: "ios" | "android" = "ios",
): string {
  // R2-54: the steps are the platform's own. "Location Services" and "While
  // Using the App" are iOS words; a Pixel says Permissions › Location and
  // "Allow only while using the app", and its master switch is just Location.
  // Both now come with an Open Settings button beside them (see the map's
  // alert box), so the steps start from the app's own page.
  switch (reason) {
    case "denied":
      return os === "android"
        ? "HoundStack does not have permission to use your location. Tap Open Settings, then Permissions › Location, choose Allow only while using the app, and press the button again."
        : "HoundStack does not have permission to use your location. Tap Open Settings, then Location, choose While Using the App, and press the button again.";
    case "timeout":
      return os === "android"
        ? "Locating timed out. Check that Location is switched on in quick settings, then try again."
        : "Locating timed out. Check that Location Services are switched on in Settings, then try again.";
    default:
      return "Your device could not work out where it is. Move somewhere with a clearer view of the sky and try again.";
  }
}

/** What to show when a `getCurrentPosition` call comes back with an error.
 *
 *  Every branch returns a non-empty sentence, and every branch says what the
 *  person can DO next. "Location unavailable" is a status; "allow location for
 *  this site in your browser settings, then press it again" is a way out. */
export function geolocationErrorMessage(
  err: { code?: number; message?: string } | null | undefined,
  opts: { secureContext?: boolean } = {},
): string {
  // Defaulting to "secure" so a caller that cannot tell (a test, a server
  // render) never blames https for a plain denial.
  const secure = opts.secureContext !== false;
  const fallback = "Could not get your location. Try again in a moment.";
  if (!err || typeof err.code !== "number") return fallback;
  switch (err.code) {
    case GEOLOCATION_PERMISSION_DENIED:
      // Deliberately NOT conditioned on the secure context. A denial is a
      // denial, and telling someone to switch to https when what happened is
      // that they pressed "Block" sends them to fix the wrong thing.
      return "Location permission is blocked for this site. Allow it in your browser's site settings, then press the button again.";
    case GEOLOCATION_POSITION_UNAVAILABLE:
      return secure
        ? "Your device could not work out where it is. Move somewhere with a clearer view of the sky and try again."
        : "Location needs a secure connection. Over plain http the browser reports your position as unavailable. Open this page over https (or on localhost).";
    case GEOLOCATION_TIMEOUT:
      return "Locating timed out. Check that location services are switched on, then try again.";
    default:
      return fallback;
  }
}

/** Whether the page is allowed to ask for location at all. Its own function so
 *  the two messages above can be told which world they are in, and so a
 *  non-browser caller does not throw on `window`. */
export function inSecureContext(): boolean {
  if (typeof window === "undefined") return true;
  return window.isSecureContext !== false;
}

export function RouteMap({
  groups,
  height = 380,
  onVisitClick,
  drawRoutes = true,
  /** Many days on one map. Routes still draw (grouped per tech per day) but
   *  start faint, because a month at full strength is visual mud. Hover brings
   *  the one day up. Kept separate from `drawRoutes`: whether polylines EXIST
   *  and how loud they are are different questions, and coupling them is why
   *  week/month had no routes to highlight at all. */
  multiDay = false,
  baseStyle,
  hoveredVisitId,
  onHoverVisit,
}: {
  groups: TechGroup[];
  height?: number;
  onVisitClick?: (visitId: string) => void;
  /** Base map style. Changing it swaps the imagery in place rather than
   *  rebuilding the map, so pan and zoom survive picking a different style —
   *  and, on Google, so a style change is not a second billed map load. */
  baseStyle?: TileVariant;
  /** Which visit the CALENDAR or BOARD is hovering, so the map can point at
   *  the same one. Hovering a card used to leave the map inert — the two panes
   *  showed the same visits and could not tell you which was which. */
  hoveredVisitId?: string | null;
  /** Hovering a pin reports back, so the card highlights too. */
  onHoverVisit?: (visitId: string | null) => void;
  /** Ordered polylines + sequence numbers only make sense for a single day's
   * route. Multi-day views (Routes week/month) pass false to plot plain
   * per-tech pins — a volume view, not a driving order. */
  drawRoutes?: boolean;
  multiDay?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** The map. Created once, when the container first comes on screen, and
   *  reused for every data change after that — see use-map-renderer.ts.
   *  Typed as the READ-ONLY renderer on purpose: this map only shows things,
   *  and keeping it to that half of the interface is what lets a native
   *  renderer (@capacitor/google-maps, planned) stand in for it later. */
  const renderer: ReadOnlyMapRenderer | null = useMapRenderer(containerRef, {
    initialView: US_VIEW,
    style: baseStyle ?? "street",
    gestures: "gated",
  });
  /** For the location button, whose handler is bound once. */
  const rendererRef = useRef<ReadOnlyMapRenderer | null>(null);
  const markerRefs = useRef<Map<string, MarkerHandle>>(new Map());
  /** visit id -> the route legs touching that stop. Rebuilt whenever the layer
   *  is, and cleared alongside it: stale overlays here would be styled on
   *  hover after being removed from the map. */
  const legRefs = useRef<Map<string, LineHandle[]>>(new Map());
  /** groupKey -> every leg of that tech-day, and visitId -> its groupKey. On a
   *  multi-day map hovering one stop lights the WHOLE day it belongs to; two
   *  lit segments inside a faint week-wide web answers no question anybody
   *  has. */
  const dayLegRefs = useRef<Map<string, LineHandle[]>>(new Map());
  const groupOfVisit = useRef<Map<string, string>>(new Map());
  const layerRef = useRef<OverlayGroup | null>(null);
  /** The "you are here" dot and its accuracy ring, in a group of their OWN.
   *  The visits layer above is cleared on every data change, and a location
   *  that vanishes the next time the schedule refetches is a location the
   *  owner will press twice and then stop trusting. */
  const meRef = useRef<OverlayGroup | null>(null);
  /** Has the user pointed at this map (click / tap / keyboard focus)? See the
   *  long note above `wheelZoomIntent`. A ref, not state: it is read inside a
   *  wheel handler bound once, and re-binding listeners per render to keep a
   *  state value fresh is how a wheel gate ends up with two of them. */
  const armedRef = useRef(false);
  /** Accumulated wheel travel since the last zoom level was applied. */
  const wheelAccRef = useRef(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  // A native denial, which only Settings can undo: the alert offers the way there.
  const [geoDenied, setGeoDenied] = useState(false);
  /** Once the user has asked "where am I", stop the data effect from flinging
   *  the viewport back to the whole route. Cleared when the visit set actually
   *  changes (a different day), not when the same day merely refetches — being
   *  yanked away from your own position a few seconds after asking for it is
   *  exactly what the button was pressed to stop. */
  const suppressFitRef = useRef(false);
  const fittedKeyRef = useRef<string | null>(null);

  const points = useMemo(
    () =>
      groups.flatMap((g) =>
        g.visits
          .filter(
            (v) =>
              v.properties?.latitude != null && v.properties?.longitude != null,
          )
          .map((v) => ({ g, v })),
      ),
    [groups],
  );

  /** Identity of the plotted set, not of the array holding it. A refetch that
   *  returns the same visits produces a new array every time. */
  const pointsKey = useMemo(() => points.map(({ v }) => v.id).join(","), [points]);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    // Long enough to read, short enough that it is gone before it becomes
    // furniture. It is `pointer-events-none`, so it never blocks the map.
    hintTimer.current = setTimeout(() => setHint(null), 2600);
  }, []);

  // One pair of overlay groups per map. Declared BEFORE the data effect so
  // that, in the commit where the map arrives, the groups exist when the data
  // effect draws into them.
  useEffect(() => {
    if (!renderer) return;
    const layer = new OverlayGroup();
    const me = new OverlayGroup();
    layerRef.current = layer;
    meRef.current = me;
    rendererRef.current = renderer;
    // A new map (Google refused the key and the fallback took over) has
    // never been fitted.
    fittedKeyRef.current = null;
    armedRef.current = false;
    return () => {
      layer.clear();
      me.clear();
      layerRef.current = null;
      meRef.current = null;
      rendererRef.current = null;
    };
  }, [renderer]);

  // The wheel gate, plus the tap that opens it. Bound once per map against
  // the container, with everything mutable behind refs.
  useEffect(() => {
    const map = renderer;
    const el = containerRef.current;
    if (!map || !el) return;

    const arm = () => {
      if (armedRef.current) return;
      armedRef.current = true;
      map.setArmed(true);
      setHint(null);
    };
    const disarm = (e: PointerEvent) => {
      // Mouse only. A touch pointer "leaving" fires at the end of every tap,
      // which would disarm the map the instant the tap that armed it ended.
      if (e.pointerType !== "mouse") return;
      armedRef.current = false;
      wheelAccRef.current = 0;
      map.setArmed(false);
    };

    const onWheel = (e: WheelEvent) => {
      // Google gates the wheel itself: its cooperative gesture handling zooms
      // on ctrl/⌘ + scroll, lets a plain scroll through to the page, and
      // draws its own hint saying so. Doing it here as well would zoom twice
      // and show two hints.
      if (map.ownsWheelGate) return;
      if (wheelZoomIntent(e, armedRef.current) === "let the page scroll") {
        // No preventDefault. The page scrolls, which is the whole point, and
        // the hint says what would have zoomed instead of leaving the wheel
        // looking broken.
        showHint("Ctrl / ⌘ + scroll to zoom, or click the map first");
        return;
      }
      // We preventDefault rather than leaving it to the map: ctrl+wheel is the
      // browser's own page-zoom shortcut, and a map that zooms while the whole
      // UI also zooms is worse than one that does neither.
      e.preventDefault();
      const delta = normalizeWheelDelta(e);
      // A reversal is a new gesture, not a continuation to be cancelled out.
      if (delta > 0 !== wheelAccRef.current > 0) wheelAccRef.current = 0;
      wheelAccRef.current += delta;
      if (Math.abs(wheelAccRef.current) < WHEEL_PX_PER_ZOOM) return;
      const step = wheelAccRef.current > 0 ? 1 : -1;
      wheelAccRef.current = 0;
      map.zoomAround(e.clientX, e.clientY, step);
    };

    const onTouchMove = (e: TouchEvent) => {
      // Passive: we are not cancelling the scroll, only explaining it. Two
      // fingers is a pinch and the map already has it. Google says this
      // itself ("use two fingers to move the map").
      if (map.ownsWheelGate || armedRef.current || e.touches.length !== 1) return;
      showHint("Tap the map to pan it, pinch to zoom");
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("pointerdown", arm);
    el.addEventListener("pointerleave", disarm);
    // Keyboard reach: tabbing to the map and using the arrow keys should not
    // need a mouse click first.
    el.addEventListener("focusin", arm);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("pointerdown", arm);
      el.removeEventListener("pointerleave", disarm);
      el.removeEventListener("focusin", arm);
    };
  }, [renderer, showHint]);

  /** Centre on the device's position and drop a "you are here" dot.
   *
   *  Called ONLY from the button's onClick. Nothing on this path runs on mount:
   *  a map that fires the permission prompt as the page loads trains people to
   *  press Block, and the block is remembered for the origin — one autoloaded
   *  prompt costs the feature for good. */
  const locate = useCallback(() => {
    const map = rendererRef.current;
    const layer = meRef.current;
    if (!map || !layer) return;
    setGeoError(null);
    setGeoDenied(false);
    const secure = inSecureContext();

    /** The same dot for both paths. Two copies of this drifted apart is how
     *  "you are here" ends up looking like a stop on one platform. */
    const drawMe = (latitude: number, longitude: number, accuracy: number) => {
      layer.clear();
      const here: LatLng = { lat: latitude, lng: longitude };
      // Deliberately unlike a visit pin. A stop is a 26px filled circle in a
      // tech colour with a white ring and a NUMBER in it; this is a small
      // dark dot with no label, a white collar, and a translucent accuracy
      // ring no visit marker ever has. The colour is off the TECH_COLORS
      // palette on purpose — if "you" were drawn in #2563eb it would read as
      // the first tech's stop.
      const dot = {
        className: "route-you-are-here",
        html:
          `<div style="width:16px;height:16px;border-radius:9999px;background:#0f172a;` +
          `border:3px solid #fff;box-shadow:0 0 0 3px rgba(15,23,42,.35),0 1px 4px rgba(0,0,0,.45);"></div>`,
      };
      if (Number.isFinite(accuracy) && accuracy > 0) {
        layer.add(
          map.addCircle(here, accuracy, {
            color: "#0f172a",
            weight: 1,
            opacity: 0.5,
            fillColor: "#0f172a",
            fillOpacity: 0.08,
            interactive: false,
          }),
        );
      }
      layer.add(
        map.addMarker({
          ...dot,
          position: here,
          size: [16, 16],
          anchor: [8, 8],
          zIndex: 1000,
          // Permanent, not on hover: hover does not exist on a phone, and an
          // unlabelled dot on a map full of dots is a thing to be confused by.
          label: { text: "You are here", permanent: true, className: "route-you-are-here-label" },
        }),
      );
      suppressFitRef.current = true;
      map.setView(here, Math.max(map.getZoom(), 15));
    };

    // NATIVE FIRST, and not as an optimisation. In a Capacitor bundle the
    // origin is capacitor://localhost, so `inSecureContext()` and the
    // `navigator.geolocation` probe below both answer a question about a
    // browser that is not the one running. Worse, the browser path's advice —
    // open it over https, allow it in site settings — is unfollowable on a
    // phone. The plugin also asks iOS properly, which is the only way the
    // system permission sheet ever appears.
    if (isNative()) {
      setLocating(true);
      void getPositionNative().then((r) => {
        setLocating(false);
        if (!r) return;
        if (r.ok) drawMe(r.latitude, r.longitude, r.accuracy);
        else {
          setGeoError(
            nativeGeolocationErrorMessage(r.reason, platform() === "android" ? "android" : "ios"),
          );
          setGeoDenied(r.reason === "denied");
        }
      });
      return;
    }

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoError(geolocationUnsupportedMessage(secure));
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const { latitude, longitude, accuracy } = pos.coords;
        drawMe(latitude, longitude, accuracy);
      },
      (err) => {
        // Never silent. This callback existing at all is half the requirement;
        // the other half is that it puts something on the screen.
        setLocating(false);
        setGeoError(geolocationErrorMessage(err, { secureContext: secure }));
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  }, []);

  useEffect(() => {
    return () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, []);

  // The style lives in its own effect. Rebuilding the map to change it would
  // reset the viewport — and on Google, cost a map load.
  useEffect(() => {
    if (renderer && baseStyle) renderer.setStyle(baseStyle);
  }, [renderer, baseStyle]);

  useEffect(() => {
    const map = renderer;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clear();
    markerRefs.current.clear();
    legRefs.current.clear();
    dayLegRefs.current.clear();
    groupOfVisit.current.clear();
    if (points.length === 0) return;

    // Draw ordered polylines per tech + numbered markers
    for (const g of groups) {
      // Unique per tech AND day. Two techs can share a day and one tech spans
      // many, so neither alone identifies a route.
      const groupKey = `${g.staffId ?? "u"}|${g.day ?? ""}`;
      const pushDayLeg = (seg: LineHandle) => {
        const l = dayLegRefs.current.get(groupKey) ?? [];
        l.push(seg);
        dayLegRefs.current.set(groupKey, l);
      };
      for (const v of g.visits) groupOfVisit.current.set(v.id, groupKey);

      const pts = g.visits
        .filter((v) => v.properties?.latitude != null && v.properties?.longitude != null)
        .sort((a, b) => (a.sequence ?? 9999) - (b.sequence ?? 9999));
      if (pts.length === 0) continue;

      const latlngs: LatLng[] = pts.map((v) => ({
        lat: v.properties!.latitude!,
        lng: v.properties!.longitude!,
      }));
      if (drawRoutes && latlngs.length > 1) {
        for (let i = 0; i < latlngs.length - 1; i++) {
          const seg = layer.add(
            map.addPolyline({
              path: [latlngs[i], latlngs[i + 1]],
              color: g.color,
              weight: multiDay ? 2 : 3,
              opacity: multiDay ? 0.12 : 0.7,
            }),
          );
          // Registered against BOTH endpoints: hovering a stop should light
          // the leg arriving and the leg leaving, which together are "where
          // this stop sits in the run".
          for (const id of [pts[i].id, pts[i + 1].id]) {
            const list = legRefs.current.get(id) ?? [];
            list.push(seg);
            legRefs.current.set(id, list);
          }
          pushDayLeg(seg);
        }
      }

      // Start / end anchors — dashed lines from home base to first stop and
      // from last stop to end location.
      const hasStart = drawRoutes && g.startLat != null && g.startLng != null;
      const hasEnd = drawRoutes && g.endLat != null && g.endLng != null;
      const start: LatLng | null = hasStart ? { lat: g.startLat!, lng: g.startLng! } : null;
      const end: LatLng | null = hasEnd ? { lat: g.endLat!, lng: g.endLng! } : null;
      if (start && latlngs.length > 0) {
        const seg = layer.add(
          map.addPolyline({
            path: [start, latlngs[0]],
            color: g.color,
            weight: 2,
            opacity: 0.5,
            dashed: true,
          }),
        );
        const list = legRefs.current.get(pts[0].id) ?? [];
        list.push(seg);
        legRefs.current.set(pts[0].id, list);
        pushDayLeg(seg);
      }
      if (end && latlngs.length > 0) {
        const seg = layer.add(
          map.addPolyline({
            path: [latlngs[latlngs.length - 1], end],
            color: g.color,
            weight: 2,
            opacity: 0.5,
            dashed: true,
          }),
        );
        const lastId = pts[pts.length - 1].id;
        const list = legRefs.current.get(lastId) ?? [];
        list.push(seg);
        legRefs.current.set(lastId, list);
        pushDayLeg(seg);
      }
      if (start) {
        layer.add(
          map.addMarker({
            position: start,
            className: "route-anchor",
            html: `<div style="background:white;color:${g.color};border:2px solid ${g.color};border-radius:6px;padding:1px 6px;font-size:10px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.25);">S</div>`,
            size: [22, 18],
            anchor: [11, 9],
            title: `${g.name}: start`,
            popupHtml: `<div style="min-width:140px"><div style="font-weight:600">${escapeHtml(g.name)}: start</div><div style="font-size:11px;color:#555">${escapeHtml(g.startAddress ?? "Home base")}</div></div>`,
          }),
        );
      }
      if (end) {
        layer.add(
          map.addMarker({
            position: end,
            className: "route-anchor",
            html: `<div style="background:${g.color};color:white;border:2px solid white;border-radius:6px;padding:1px 6px;font-size:10px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.25);">E</div>`,
            size: [22, 18],
            anchor: [11, 9],
            title: `${g.name}: end`,
            popupHtml: `<div style="min-width:140px"><div style="font-weight:600">${escapeHtml(g.name)}: end</div><div style="font-size:11px;color:#555">${escapeHtml(g.endAddress ?? "End of day")}</div></div>`,
          }),
        );
      }

      pts.forEach((v, idx) => {
        const label = String(v.sequence ?? idx + 1);
        const done = v.status === "completed" || v.status === "skipped";
        // In multi-day mode per-day sequences repeat (1,2,3 every day), so
        // pins drop the number and popups lead with the date instead.
        const pinText = drawRoutes ? statusEmoji(v.status) || label : statusEmoji(v.status) || "•";
        const addr = [v.properties?.street, v.properties?.city].filter(Boolean).join(", ");
        const detail =
          `<div style="min-width:170px">` +
          `<div style="font-weight:600">${escapeHtml(v.clients?.display_name ?? "-")}</div>` +
          // The day, always — a week or month map shows several, and a pin
          // that will not say which day it is cannot be acted on.
          `<div style="font-size:11px;color:#555">${escapeHtml(formatDay((v as any).scheduled_on))}</div>` +
          `<div style="font-size:11px;color:#555">${escapeHtml(addr)}</div>` +
          // Whose route, and where in it — the two questions a pin on a
          // multi-tech map is actually being asked.
          `<div style="font-size:11px;margin-top:3px"><span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${g.color};margin-right:5px"></span>${escapeHtml(g.name)}` +
          (v.sequence != null ? ` · stop #${v.sequence}` : "") +
          `</div>` +
          (v.status && v.status !== "scheduled"
            ? `<div style="font-size:11px;color:#888">${escapeHtml(prettyStatus(v.status))}</div>`
            : "") +
          `</div>`;
        const m = layer.add(
          map.addMarker({
            position: latlngs[idx],
            className: "route-marker",
            html: `<div style="background:${done ? "#94a3b8" : g.color};color:white;border:2px solid white;border-radius:9999px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.3);">${pinText}</div>`,
            size: [26, 26],
            anchor: [13, 13],
            // Plain text for the accessible name; the HTML is for the eye.
            title: drawRoutes
              ? `#${label} · ${v.clients?.display_name ?? "-"}`
              : `${(v as any).scheduled_on ?? ""} · ${v.clients?.display_name ?? "-"}`,
            popupHtml: detail,
            // Tooltip as well as popup: a popup needs a click, and "what is
            // this pin?" should not cost one.
            tooltipHtml: detail,
            onClick: onVisitClick ? () => onVisitClick(v.id) : undefined,
            onHover: onHoverVisit ? (over) => onHoverVisit(over ? v.id : null) : undefined,
          }),
        );
        markerRefs.current.set(v.id, m);
      });
    }

    const all: LatLng[] = points.map(({ v }) => ({
      lat: v.properties!.latitude!,
      lng: v.properties!.longitude!,
    }));
    for (const g of groups) {
      if (g.startLat != null && g.startLng != null) all.push({ lat: g.startLat, lng: g.startLng });
      if (g.endLat != null && g.endLng != null) all.push({ lat: g.endLat, lng: g.endLng });
    }
    // A genuinely different set of visits (a new day) earns a fresh fit even if
    // the user located themselves on the previous one; a refetch of the same
    // day does not.
    if (fittedKeyRef.current !== pointsKey) {
      fittedKeyRef.current = pointsKey;
      suppressFitRef.current = false;
    }
    if (all.length > 0 && !suppressFitRef.current) {
      // Cap the zoom so a day with a single geocoded visit fits to
      // neighborhood level instead of snapping to one street (C8).
      map.fitBounds(all, { padding: 30, maxZoom: 14 });
    }
    // Rebuilt above, so anything the previous pass registered is stale.
  }, [renderer, points, pointsKey, groups, onVisitClick, drawRoutes, multiDay, onHoverVisit]);

  // Point at whichever visit another pane is hovering.
  //
  // Restyling the existing pin rather than re-rendering the layer: rebuilding
  // every pin on each mouseover would fight the map for a frame at exactly the
  // moment the pointer is moving.
  useEffect(() => {
    for (const [id, m] of markerRefs.current) m.setHighlighted(id === hoveredVisitId);
    // Legs are restyled in two passes — every leg back to base, then the
    // hovered stop's legs up — because one leg can belong to two stops. A
    // single pass that only lowered "the previous stop's" legs would leave a
    // shared leg stuck bright when the pointer moved between neighbours.
    for (const [id, segs] of legRefs.current) {
      const on = id === hoveredVisitId;
      for (const seg of segs) {
        const dashed = seg.dashed;
        if (!on) {
          seg.setStyle(
            multiDay
              ? { weight: dashed ? 1.5 : 2, opacity: 0.12 }
              : { weight: dashed ? 2 : 3, opacity: dashed ? 0.5 : 0.7 },
          );
        }
      }
    }
    const hoveredGroup = hoveredVisitId ? groupOfVisit.current.get(hoveredVisitId) : undefined;
    const toRaise = multiDay && hoveredGroup
      ? (dayLegRefs.current.get(hoveredGroup) ?? [])
      : (legRefs.current.get(hoveredVisitId ?? "") ?? []);
    for (const seg of toRaise) {
      const dashed = seg.dashed;
      seg.setStyle({ weight: dashed ? 3 : 5, opacity: multiDay ? 0.95 : 1 });
      seg.bringToFront();
    }
  }, [hoveredVisitId, points, renderer, multiDay]);

  return (
    <div
      style={{ height, width: "100%" }}
      // `relative` so the controls below can sit over the map; `isolate` keeps
      // Leaflet's own z-indexes (panes run 200–1000) inside this box and off
      // the rest of the page, which is why the overlays can use z-[1100]
      // without outranking a dialog.
      //
      // The two arbitrary-variant rules give Leaflet's own +/- buttons a 44px
      // target below `md`. They are 30px out of the box, which is the same
      // "aim at it" target CLAUDE.md called out on the tab bar, and they are
      // the answer for anyone who does not want to scroll to zoom at all.
      className={
        "relative isolate rounded-lg border overflow-hidden z-0 " +
        // `touch:`, not `max-md:`. Leaflet's zoom buttons are 30px out of the
        // box, and the width-based escape stopped at 767px — so on an iPad,
        // where the map is biggest and pinch-zoom competes with page scroll,
        // the two controls that avoid scrolling to zoom at all were the
        // smallest targets on the screen.
        // `!` is load bearing, and it took a measurement to find out. Leaflet
        // adds its own `leaflet-touch` class on a touch device and ships
        // `.leaflet-touch .leaflet-bar a { width:30px; height:30px }` — the
        // same specificity as the override below, so the tie went to whichever
        // stylesheet came last, and it was not this one. The override was
        // being beaten by the exact condition it exists to handle: it looked
        // correct in the source, compiled correctly into the stylesheet, and
        // measured 30.0px in the browser.
        // These rules size the LEAFLET fallback's buttons. Google's are 44px
        // from `controlSize` in src/lib/maps/google-renderer.ts.
        "touch:[&_.leaflet-control-zoom_a]:!h-11 touch:[&_.leaflet-control-zoom_a]:!w-11 " +
        "touch:[&_.leaflet-control-zoom_a]:!leading-[2.75rem]"
      }
    >
      <div ref={containerRef} className="absolute inset-0" />

      {/* Always visible, never hover-revealed: on a phone there is no hover,
          and "centre on me" is the one control a person standing in a driveway
          actually needs. 44px box around a 16px glyph — the ui/dialog.tsx
          pattern — at every width, because a control this small has nothing to
          gain from being smaller on a laptop. */}
      <div className="absolute right-2 top-2 z-[1100] flex max-w-[calc(100%-1rem)] flex-col items-end gap-1.5">
        <button
          type="button"
          onClick={locate}
          disabled={locating}
          aria-label="Show my current location"
          title="Show my current location"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border bg-background/95 text-foreground shadow-sm transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          {locating ? (
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          ) : (
            <LocateFixed className="h-4 w-4 shrink-0" />
          )}
          <span className="sr-only">Show my current location</span>
        </button>
        {geoError && (
          // `role="alert"` so a screen reader hears it, and a real box on the
          // map so everyone else sees it. Silence was the failure mode being
          // fixed: the old button-less map simply never said anything.
          <div
            role="alert"
            className="flex max-w-[min(15rem,calc(100vw-5rem))] items-start gap-1.5 rounded-md border bg-background/95 px-2 py-1.5 text-xs leading-snug text-foreground shadow-sm"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            {/* min-w-0 so the message wraps inside the box instead of setting
                its width — CLAUDE.md's flex-row rule. */}
            <div className="min-w-0 flex-1">
              <span className="min-w-0">{geoError}</span>
              {geoDenied && (
                <button
                  type="button"
                  onClick={() => void openAppSettings()}
                  className="mt-1 flex min-h-11 items-center font-semibold text-primary underline underline-offset-2"
                >
                  Open Settings
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setGeoError(null);
                setGeoDenied(false);
              }}
              aria-label="Dismiss location message"
              className="-my-1.5 -mr-1 flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground"
            >
              <span aria-hidden="true" className="text-sm leading-none">
                ×
              </span>
            </button>
          </div>
        )}
      </div>

      {hint && (
        // pointer-events-none: it appears while the user is mid-scroll, and a
        // toast that swallows the next click is worse than no toast.
        //
        // bottom-9, not bottom-2 (2026-10-03): the bottom ~30px of a Google
        // map is its logo (left) and the "Map data / Terms" line (right), which
        // the Maps Platform terms require to stay visible. A centred pill at
        // bottom-2 covered one or the other on a phone-width map.
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute inset-x-2 bottom-9 z-[1100] mx-auto w-fit max-w-[calc(100%-1rem)] rounded-full bg-foreground/85 px-3 py-1.5 text-center text-xs text-background shadow"
        >
          {hint}
        </div>
      )}
    </div>
  );
}

/** Which colour each tech is drawn in, keyed by staff id.
 *
 *  Built by delegating to `buildTechGroups` rather than re-deriving the
 *  assignment, because the assignment is not a pure function of the staff list:
 *  the colour index advances only for techs who actually have visits in the
 *  window. Any second implementation would agree on the common case and drift
 *  the moment someone has an empty day — leaving a chip and its own map pin in
 *  different colours, which is worse than having no colour at all. */
export function techColorMap(
  visits: MapVisit[],
  staff: Parameters<typeof buildTechGroups>[1],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of buildTechGroups(visits, staff)) {
    if (g.staffId) m.set(g.staffId, g.color);
  }
  return m;
}

export function buildTechGroups(
  visits: MapVisit[],
  staff: Array<{
    id: string;
    display_name: string;
    start_latitude?: number | null;
    start_longitude?: number | null;
    start_address?: string | null;
    end_latitude?: number | null;
    end_longitude?: number | null;
    end_address?: string | null;
  }>,
  /** Split each tech into one group PER DAY. Required on any multi-day map:
   *  without it a tech's stops from different days land in one polyline. */
  perDay = false,
): TechGroup[] {
  const byStaff = new Map<string | null, MapVisit[]>();
  for (const v of visits) {
    const k = (v as any).assigned_staff_id ?? null;
    if (!byStaff.has(k)) byStaff.set(k, []);
    byStaff.get(k)!.push(v);
  }
  const groups: TechGroup[] = [];
  for (const [si, s] of staff.entries()) {
    const list = byStaff.get(s.id) ?? [];
    if (list.length === 0) continue;
    // One colour per TECH, chosen before any per-day split, and keyed on the
    // tech's place in the staff list rather than on who happens to have work
    // in this window. It used to advance only for techs with visits, so the
    // same person was blue in Week and red in Month whenever somebody earlier
    // in the list had an empty week (found 2026-09-27, persona review), while
    // the page promised a colour means one person. techColorMap() reads this
    // same function so a calendar chip and its map pin still agree, and a
    // tech with five days of work still has one colour, not five.
    const color = TECH_COLORS[si % TECH_COLORS.length];

    const base = {
      staffId: s.id,
      name: s.display_name,
      color,
      startLat: s.start_latitude ?? null,
      startLng: s.start_longitude ?? null,
      startAddress: s.start_address ?? null,
      endLat: s.end_latitude ?? null,
      endLng: s.end_longitude ?? null,
      endAddress: s.end_address ?? null,
    };

    if (!perDay) {
      groups.push({ ...base, visits: list });
      continue;
    }

    // `sequence` restarts at 1 every day. Grouped by tech alone across a week,
    // sorting by sequence interleaves the days — Mon#1, Tue#1, Wed#1, Mon#2 —
    // and the polyline zig-zags across the whole window. That is why week and
    // month were drawn with no routes at all: the disable was a workaround for
    // this key, not a decision that routes are unwanted there.
    const byDay = new Map<string, MapVisit[]>();
    for (const v of list) {
      const d = (v as any).scheduled_on ?? "";
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push(v);
    }
    for (const [day, dayVisits] of [...byDay.entries()].sort()) {
      groups.push({ ...base, day, visits: dayVisits });
    }
  }
  // Unassigned visits used to be one flat slate-gray group — on a day with no
  // assignments yet every pin looked identical and the map read as broken
  // (P2). Split them by zone so the geography stays color-scannable.
  const unassigned = byStaff.get(null) ?? [];
  // After every tech's slot, so an unassigned zone never borrows a colour
  // that belongs to a person.
  let ci = staff.length;
  if (unassigned.length) {
    const byZone = new Map<string, MapVisit[]>();
    for (const v of unassigned) {
      const z = v.zones?.name ?? "No zone";
      if (!byZone.has(z)) byZone.set(z, []);
      byZone.get(z)!.push(v);
    }
    const zoneNames = Array.from(byZone.keys()).sort();
    for (const z of zoneNames) {
      groups.push({
        staffId: null,
        name: zoneNames.length > 1 || z !== "No zone" ? `Unassigned · ${z}` : "Unassigned",
        color: TECH_COLORS[ci % TECH_COLORS.length],
        visits: byZone.get(z)!,
      });
      ci++;
    }
  }
  return groups;
}

/**
 * One legend row per THING ON THE MAP, not per polyline group.
 *
 * buildTechGroups returns one group per polyline, which is not one per tech:
 * perDay splits a tech into a group per day (so a week legend read "Sam, Sam,
 * Sam, Sam, Sam"), and unassigned work splits by zone into several groups that
 * all carry staffId null. The legend keyed rows by `staffId ?? "u"`, so both
 * shapes produced duplicate React keys; the E2E suite caught the null case as
 * a console error the evening the demo seed began putting unassigned work in
 * two zones on the org's own today.
 *
 * Keyed by staff id for a tech (one row however many days it spans; the colour
 * is per tech already) and by name for an unassigned zone group, whose name
 * carries the zone and is therefore unique among them.
 */
export function legendEntries(
  groups: ReadonlyArray<Pick<TechGroup, "staffId" | "name" | "color">>,
): Array<{ key: string; name: string; color: string }> {
  const out = new Map<string, { key: string; name: string; color: string }>();
  for (const g of groups) {
    const key = g.staffId ? `staff:${g.staffId}` : `unassigned:${g.name}`;
    if (!out.has(key)) out.set(key, { key, name: g.name, color: g.color });
  }
  return [...out.values()];
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
