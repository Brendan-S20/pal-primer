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

    const all = points.map(
      ({ v }) => [v.properties!.latitude!, v.properties!.longitude!] as [number, number],
    );
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

export function buildTechGroups(visits: MapVisit[], staff: { id: string; display_name: string }[]): TechGroup[] {
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
    groups.push({ staffId: s.id, name: s.display_name, color: TECH_COLORS[ci % TECH_COLORS.length], visits: list });
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
