import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addBaseTiles, type TileVariant } from "@/lib/map-tiles";

// Fix Leaflet default icon paths (they break under bundlers).
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

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

type TechGroup = {
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
  /** Base tiles. Changing it swaps the layer in place rather than rebuilding
   *  the map, so pan and zoom survive picking a different style. */
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
  const markerRefs = useRef<Map<string, L.Marker>>(new Map());
  /** visit id -> the route legs touching that stop. Rebuilt whenever the layer
   *  is, and cleared alongside it: stale Leaflet objects here would be styled
   *  on hover after being removed from the map. */
  const legRefs = useRef<Map<string, L.Polyline[]>>(new Map());
  /** groupKey -> every leg of that tech-day, and visitId -> its groupKey. On a
   *  multi-day map hovering one stop lights the WHOLE day it belongs to; two
   *  lit segments inside a faint week-wide web answers no question anybody
   *  has. */
  const dayLegRefs = useRef<Map<string, L.Polyline[]>>(new Map());
  const groupOfVisit = useRef<Map<string, string>>(new Map());
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

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

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [39.5, -98.35],
      zoom: 4,
      scrollWheelZoom: true,
    });
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
  }, []);

  // Base tiles live in their own effect keyed on the style. Rebuilding the map
  // to change basemap would reset the viewport, so switching style would fling
  // you back to the whole-country default view every time.
  const baseRef = useRef<L.Layer[]>([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const l of baseRef.current) map.removeLayer(l);
    baseRef.current = [];
    const before = new Set<L.Layer>();
    map.eachLayer((l) => before.add(l));
    addBaseTiles(map, baseStyle);
    map.eachLayer((l) => {
      if (!before.has(l) && l instanceof L.TileLayer) {
        baseRef.current.push(l);
        // Tiles belong underneath every pin and polyline.
        l.setZIndex(0);
      }
    });
  }, [baseStyle]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
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
      const pushDayLeg = (seg: L.Polyline) => {
        const l = dayLegRefs.current.get(groupKey) ?? [];
        l.push(seg);
        dayLegRefs.current.set(groupKey, l);
      };
      for (const v of g.visits) groupOfVisit.current.set(v.id, groupKey);

      const pts = g.visits
        .filter((v) => v.properties?.latitude != null && v.properties?.longitude != null)
        .sort((a, b) => (a.sequence ?? 9999) - (b.sequence ?? 9999));
      if (pts.length === 0) continue;

      const latlngs = pts.map(
        (v) => [v.properties!.latitude!, v.properties!.longitude!] as [number, number],
      );
      if (drawRoutes && latlngs.length > 1) {
        for (let i = 0; i < latlngs.length - 1; i++) {
          const seg = L.polyline([latlngs[i], latlngs[i + 1]], {
            color: g.color,
            weight: multiDay ? 2 : 3,
            opacity: multiDay ? 0.12 : 0.7,
          }).addTo(layer);
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
      if (hasStart && latlngs.length > 0) {
        const seg = L.polyline([[g.startLat!, g.startLng!], latlngs[0]], {
          color: g.color, weight: 2, opacity: 0.5, dashArray: "6 6",
        }).addTo(layer);
        const list = legRefs.current.get(pts[0].id) ?? [];
        list.push(seg);
        legRefs.current.set(pts[0].id, list);
        pushDayLeg(seg);
      }
      if (hasEnd && latlngs.length > 0) {
        const seg = L.polyline([latlngs[latlngs.length - 1], [g.endLat!, g.endLng!]], {
          color: g.color, weight: 2, opacity: 0.5, dashArray: "6 6",
        }).addTo(layer);
        const lastId = pts[pts.length - 1].id;
        const list = legRefs.current.get(lastId) ?? [];
        list.push(seg);
        legRefs.current.set(lastId, list);
        pushDayLeg(seg);
      }
      if (hasStart) {
        const startIcon = L.divIcon({
          className: "route-anchor",
          html: `<div style="background:white;color:${g.color};border:2px solid ${g.color};border-radius:6px;padding:1px 6px;font-size:10px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.25);">S</div>`,
          iconSize: [22, 18], iconAnchor: [11, 9],
        });
        L.marker([g.startLat!, g.startLng!], { icon: startIcon })
          .addTo(layer)
          .bindPopup(`<div style="min-width:140px"><div style="font-weight:600">${escapeHtml(g.name)}: start</div><div style="font-size:11px;color:#555">${escapeHtml(g.startAddress ?? "Home base")}</div></div>`);
      }
      if (hasEnd) {
        const endIcon = L.divIcon({
          className: "route-anchor",
          html: `<div style="background:${g.color};color:white;border:2px solid white;border-radius:6px;padding:1px 6px;font-size:10px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.25);">E</div>`,
          iconSize: [22, 18], iconAnchor: [11, 9],
        });
        L.marker([g.endLat!, g.endLng!], { icon: endIcon })
          .addTo(layer)
          .bindPopup(`<div style="min-width:140px"><div style="font-weight:600">${escapeHtml(g.name)}: end</div><div style="font-size:11px;color:#555">${escapeHtml(g.endAddress ?? "End of day")}</div></div>`);
      }

      pts.forEach((v, idx) => {
        const label = String(v.sequence ?? idx + 1);
        const done = v.status === "completed" || v.status === "skipped";
        // In multi-day mode per-day sequences repeat (1,2,3 every day), so
        // pins drop the number and popups lead with the date instead.
        const pinText = drawRoutes ? statusEmoji(v.status) || label : statusEmoji(v.status) || "•";
        const icon = L.divIcon({
          className: "route-marker",
          html: `<div style="background:${done ? "#94a3b8" : g.color};color:white;border:2px solid white;border-radius:9999px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.3);">${pinText}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });
        const m = L.marker(latlngs[idx], { icon }).addTo(layer);
        markerRefs.current.set(v.id, m);
        const addr = [v.properties?.street, v.properties?.city].filter(Boolean).join(", ");
        const title = drawRoutes
          ? `#${label} · ${escapeHtml(v.clients?.display_name ?? "-")}`
          : `${escapeHtml((v as any).scheduled_on ?? "")} · ${escapeHtml(v.clients?.display_name ?? "-")}`;
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
        m.bindPopup(detail);
        // Tooltip as well as popup: a popup needs a click, and "what is this
        // pin?" should not cost one.
        m.bindTooltip(detail, { direction: "top", offset: [0, -12], opacity: 1 });
        if (onVisitClick) m.on("click", () => onVisitClick(v.id));
        if (onHoverVisit) {
          m.on("mouseover", () => onHoverVisit(v.id));
          m.on("mouseout", () => onHoverVisit(null));
        }
      });
    }

    const all: [number, number][] = points.map(
      ({ v }) => [v.properties!.latitude!, v.properties!.longitude!] as [number, number],
    );
    for (const g of groups) {
      if (g.startLat != null && g.startLng != null) all.push([g.startLat, g.startLng]);
      if (g.endLat != null && g.endLng != null) all.push([g.endLat, g.endLng]);
    }
    if (all.length > 0) {
      // Cap the zoom so a day with a single geocoded visit fits to
      // neighborhood level instead of snapping to one street (C8).
      map.fitBounds(L.latLngBounds(all), { padding: [30, 30], maxZoom: 14 });
    }
    // Rebuilt above, so anything the previous pass registered is stale.
  }, [points, groups, onVisitClick, drawRoutes, onHoverVisit]);

  // Point at whichever visit another pane is hovering.
  //
  // Scaling the existing marker rather than re-rendering the layer: rebuilding
  // every pin on each mouseover would fight the map for a frame at exactly the
  // moment the pointer is moving.
  useEffect(() => {
    for (const [id, m] of markerRefs.current) {
      const el = (m as any).getElement?.() as HTMLElement | undefined;
      if (!el) continue;
      const on = id === hoveredVisitId;
      el.style.transition = "transform 90ms ease-out";
      el.style.transform = `${el.style.transform.replace(/ scale\([^)]*\)/, "")}${on ? " scale(1.45)" : ""}`;
      el.style.zIndex = on ? "1000" : "";
      el.style.filter = on ? "drop-shadow(0 0 6px rgba(0,0,0,.45))" : "";
    }
    // Legs are restyled in two passes — every leg back to base, then the
    // hovered stop's legs up — because one leg can belong to two stops. A
    // single pass that only lowered "the previous stop's" legs would leave a
    // shared leg stuck bright when the pointer moved between neighbours.
    for (const [id, segs] of legRefs.current) {
      const on = id === hoveredVisitId;
      for (const seg of segs) {
        const dashed = Boolean((seg.options as any).dashArray);
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
      const dashed = Boolean((seg.options as any).dashArray);
      seg.setStyle({ weight: dashed ? 3 : 5, opacity: multiDay ? 0.95 : 1 });
      seg.bringToFront();
    }
  }, [hoveredVisitId, points]);

  useEffect(() => {
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ height, width: "100%" }}
      className="isolate rounded-lg border overflow-hidden z-0"
    />
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
  let ci = 0;
  for (const s of staff) {
    const list = byStaff.get(s.id) ?? [];
    if (list.length === 0) continue;
    // One colour per TECH, chosen before any per-day split, and the index
    // advances once per tech. techColorMap() reads this same function so a
    // calendar chip and its map pin agree; if the index advanced per GROUP
    // instead, a tech with five days of work would consume five colours and
    // every chip would desync from its pin.
    const color = TECH_COLORS[ci % TECH_COLORS.length];
    ci++;

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

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
