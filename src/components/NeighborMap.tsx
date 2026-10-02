import { useEffect, useRef } from "react";
import { useMapRenderer } from "@/lib/maps/use-map-renderer";
import { OverlayGroup, US_VIEW } from "@/lib/maps/types";

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

function pinHtml(color: string, seed: boolean) {
  return `
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
  // One map per mount; pins are redrawn on it, never a new map per change.
  const map = useMapRenderer(containerRef, {
    initialView: US_VIEW,
    style: "street",
    gestures: "map",
  });

  useEffect(() => {
    if (!map) return;
    const layer = new OverlayGroup();
    const geo = pins.filter((p) => p.latitude != null && p.longitude != null);
    if (geo.length === 0) return;

    for (const p of geo) {
      const color = STATUS_COLOR[p.status];
      const size = p.isSeed ? 22 : 16;
      // Escaped: an address is typed by whoever filled in the lead form.
      const label =
        `<div style="font-weight:600">${escapeHtml(p.address)}</div>` +
        (p.seedClientName
          ? `<div style="color:#64748b;font-size:11px">Seed: ${escapeHtml(p.seedClientName)}</div>`
          : "") +
        `<div style="margin-top:4px;text-transform:capitalize;color:${color};font-weight:600">${p.status.replace("_", " ")}</div>`;
      layer.add(
        map.addMarker({
          position: { lat: p.latitude!, lng: p.longitude! },
          className: "neighbor-pin",
          html: pinHtml(color, !!p.isSeed),
          size: [size, size],
          anchor: [size / 2, size / 2],
          title: p.address,
          popupHtml: label,
          onClick: onSelect ? () => onSelect(p.id) : undefined,
        }),
      );
    }

    map.fitBounds(
      geo.map((p) => ({ lat: p.latitude!, lng: p.longitude! })),
      { padding: 30, maxZoom: 17 },
    );
    return () => layer.clear();
  }, [map, pins, onSelect]);

  return (
    <div className="isolate z-0 overflow-hidden rounded-lg border">
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

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
