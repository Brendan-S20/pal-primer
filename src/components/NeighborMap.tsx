import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type NeighborPin = {
  id: string;
  address: string;
  status: "new" | "contacted" | "interested" | "converted" | "not_interested";
  latitude: number | null;
  longitude: number | null;
  seedClientName?: string | null;
  isSeed?: boolean;
};

const STATUS_COLOR: Record<NeighborPin["status"], string> = {
  new: "#94a3b8", // slate
  contacted: "#3b82f6", // blue
  interested: "#f59e0b", // amber
  converted: "#10b981", // emerald
  not_interested: "#ef4444", // red
};

function pinIcon(color: string, seed: boolean) {
  const html = `
    <div style="
      width: ${seed ? 22 : 16}px;
      height: ${seed ? 22 : 16}px;
      border-radius: 50%;
      background: ${color};
      border: 2px solid white;
      box-shadow: 0 1px 4px rgba(0,0,0,0.45);
      display:flex;align-items:center;justify-content:center;
      color:white;font-size:10px;font-weight:700;
    ">${seed ? "★" : ""}</div>`;
  return L.divIcon({
    html,
    className: "neighbor-pin",
    iconSize: [seed ? 22 : 16, seed ? 22 : 16],
    iconAnchor: [seed ? 11 : 8, seed ? 11 : 8],
  });
}

export function NeighborMap({
  pins,
  height = 380,
  onSelect,
}: {
  pins: NeighborPin[];
  height?: number;
  onSelect?: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true }).setView([39.5, -98.35], 4);
    addBaseTiles(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    const geo = pins.filter((p) => p.latitude != null && p.longitude != null);
    if (geo.length === 0) return;

    for (const p of geo) {
      const marker = L.marker([p.latitude!, p.longitude!], {
        icon: pinIcon(STATUS_COLOR[p.status], !!p.isSeed),
      });
      const label =
        `<div style="font-weight:600">${p.address}</div>` +
        (p.seedClientName ? `<div style="color:#64748b;font-size:11px">Seed: ${p.seedClientName}</div>` : "") +
        `<div style="margin-top:4px;text-transform:capitalize;color:${STATUS_COLOR[p.status]};font-weight:600">${p.status.replace("_", " ")}</div>`;
      marker.bindPopup(label);
      if (onSelect) marker.on("click", () => onSelect(p.id));
      marker.addTo(layer);
    }

    const bounds = L.latLngBounds(geo.map((p) => [p.latitude!, p.longitude!] as [number, number]));
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
  }, [pins, onSelect]);

  return (
    <div className="overflow-hidden rounded-lg border">
      <div ref={containerRef} style={{ height, width: "100%" }} />
      <div className="flex flex-wrap items-center gap-3 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Dot color={STATUS_COLOR.new} /> To visit</span>
        <span className="flex items-center gap-1"><Dot color={STATUS_COLOR.contacted} /> Contacted</span>
        <span className="flex items-center gap-1"><Dot color={STATUS_COLOR.interested} /> Interested</span>
        <span className="flex items-center gap-1"><Dot color={STATUS_COLOR.converted} /> Signed up</span>
        <span className="flex items-center gap-1"><Dot color={STATUS_COLOR.not_interested} /> Passed</span>
        <span className="ml-auto">★ = seed client</span>
      </div>
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{ background: color, border: "1.5px solid white", boxShadow: "0 0 0 1px rgba(0,0,0,0.15)" }}
    />
  );
}
