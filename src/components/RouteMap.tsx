import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

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
}: {
  groups: TechGroup[];
  height?: number;
  onVisitClick?: (visitId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
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
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (points.length === 0) return;

    // Draw ordered polylines per tech + numbered markers
    for (const g of groups) {
      const pts = g.visits
        .filter((v) => v.properties?.latitude != null && v.properties?.longitude != null)
        .sort((a, b) => (a.sequence ?? 9999) - (b.sequence ?? 9999));
      if (pts.length === 0) continue;

      const latlngs = pts.map(
        (v) => [v.properties!.latitude!, v.properties!.longitude!] as [number, number],
      );
      if (latlngs.length > 1) {
        L.polyline(latlngs, { color: g.color, weight: 3, opacity: 0.7 }).addTo(layer);
      }

      // Start / end anchors — dashed lines from home base to first stop and
      // from last stop to end location.
      const hasStart = g.startLat != null && g.startLng != null;
      const hasEnd = g.endLat != null && g.endLng != null;
      if (hasStart && latlngs.length > 0) {
        L.polyline([[g.startLat!, g.startLng!], latlngs[0]], {
          color: g.color, weight: 2, opacity: 0.5, dashArray: "6 6",
        }).addTo(layer);
      }
      if (hasEnd && latlngs.length > 0) {
        L.polyline([latlngs[latlngs.length - 1], [g.endLat!, g.endLng!]], {
          color: g.color, weight: 2, opacity: 0.5, dashArray: "6 6",
        }).addTo(layer);
      }
      if (hasStart) {
        const startIcon = L.divIcon({
          className: "route-anchor",
          html: `<div style="background:white;color:${g.color};border:2px solid ${g.color};border-radius:6px;padding:1px 6px;font-size:10px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.25);">S</div>`,
          iconSize: [22, 18], iconAnchor: [11, 9],
        });
        L.marker([g.startLat!, g.startLng!], { icon: startIcon })
          .addTo(layer)
          .bindPopup(`<div style="min-width:140px"><div style="font-weight:600">${escapeHtml(g.name)} — start</div><div style="font-size:11px;color:#555">${escapeHtml(g.startAddress ?? "Home base")}</div></div>`);
      }
      if (hasEnd) {
        const endIcon = L.divIcon({
          className: "route-anchor",
          html: `<div style="background:${g.color};color:white;border:2px solid white;border-radius:6px;padding:1px 6px;font-size:10px;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.25);">E</div>`,
          iconSize: [22, 18], iconAnchor: [11, 9],
        });
        L.marker([g.endLat!, g.endLng!], { icon: endIcon })
          .addTo(layer)
          .bindPopup(`<div style="min-width:140px"><div style="font-weight:600">${escapeHtml(g.name)} — end</div><div style="font-size:11px;color:#555">${escapeHtml(g.endAddress ?? "End of day")}</div></div>`);
      }

      pts.forEach((v, idx) => {
        const label = String(v.sequence ?? idx + 1);
        const done = v.status === "completed" || v.status === "skipped";
        const icon = L.divIcon({
          className: "route-marker",
          html: `<div style="background:${done ? "#94a3b8" : g.color};color:white;border:2px solid white;border-radius:9999px;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.3);">${statusEmoji(v.status) || label}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        });
        const m = L.marker(latlngs[idx], { icon }).addTo(layer);
        const addr = [v.properties?.street, v.properties?.city].filter(Boolean).join(", ");
        m.bindPopup(
          `<div style="min-width:160px"><div style="font-weight:600">#${label} · ${escapeHtml(v.clients?.display_name ?? "—")}</div><div style="font-size:11px;color:#555">${escapeHtml(addr)}</div><div style="font-size:11px;color:#888;margin-top:2px">${escapeHtml(g.name)}</div></div>`,
        );
        if (onVisitClick) m.on("click", () => onVisitClick(v.id));
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
      map.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
    }
  }, [points, groups, onVisitClick]);

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
      className="rounded-lg border overflow-hidden z-0"
    />
  );
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
    groups.push({
      staffId: s.id,
      name: s.display_name,
      color: TECH_COLORS[ci % TECH_COLORS.length],
      visits: list,
      startLat: s.start_latitude ?? null,
      startLng: s.start_longitude ?? null,
      startAddress: s.start_address ?? null,
      endLat: s.end_latitude ?? null,
      endLng: s.end_longitude ?? null,
      endAddress: s.end_address ?? null,
    });
    ci++;
  }
  const unassigned = byStaff.get(null) ?? [];
  if (unassigned.length) {
    groups.push({ staffId: null, name: "Unassigned", color: "#64748b", visits: unassigned });
  }
  return groups;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
