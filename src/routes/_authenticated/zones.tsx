import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { listZones, createZone } from "@/lib/zones.functions";
import { updateZoneCoords } from "@/lib/weather.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/zones")({
  component: ZonesPage,
});

function ZonesPage() {
  const list = useServerFn(listZones);
  const create = useServerFn(createZone);
  const setCoords = useServerFn(updateZoneCoords);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["zones"], queryFn: () => list() });
  const [name, setName] = useState("");
  const [postalPrefix, setPostalPrefix] = useState("");
  const [priceNote, setPriceNote] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");

  const mut = useMutation({
    mutationFn: () =>
      create({
        data: {
          name,
          postalPrefix: postalPrefix || undefined,
          priceNote: priceNote || undefined,
          latitude: latitude ? Number(latitude) : undefined,
          longitude: longitude ? Number(longitude) : undefined,
        },
      }),
    onSuccess: () => {
      setName("");
      setPostalPrefix("");
      setPriceNote("");
      setLatitude("");
      setLongitude("");
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
  });

  const coordMut = useMutation({
    mutationFn: (v: { id: string; latitude: number; longitude: number }) =>
      setCoords({ data: v }),
    onSuccess: () => {
      toast.success("Coordinates saved");
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Zones</h1>
        <p className="text-sm text-muted-foreground">
          Territories used to order visits into a route. Add latitude/longitude to enable weather forecasts.
        </p>
      </div>

      <form
        className="grid gap-3 rounded-lg border bg-card p-5 sm:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (name) mut.mutate();
        }}
      >
        <div className="sm:col-span-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="pp">Postal prefix</Label>
          <Input id="pp" placeholder="787" value={postalPrefix} onChange={(e) => setPostalPrefix(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="lat">Latitude</Label>
          <Input id="lat" placeholder="30.27" value={latitude} onChange={(e) => setLatitude(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="lon">Longitude</Label>
          <Input id="lon" placeholder="-97.74" value={longitude} onChange={(e) => setLongitude(e.target.value)} />
        </div>
        <div className="flex items-end">
          <Button type="submit" disabled={mut.isPending || !name}>
            {mut.isPending ? "Adding…" : "Add"}
          </Button>
        </div>
        <div className="sm:col-span-6">
          <Label htmlFor="pn">Price note</Label>
          <Input id="pn" value={priceNote} onChange={(e) => setPriceNote(e.target.value)} />
        </div>
        {mut.error && <p className="col-span-full text-sm text-destructive">{(mut.error as Error).message}</p>}
      </form>

      <div className="rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Prefix</th>
              <th className="px-4 py-2">Coords</th>
              <th className="px-4 py-2">Notes</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {(data?.zones ?? []).map((z: any) => (
              <ZoneRow key={z.id} zone={z} onSave={(lat, lon) => coordMut.mutate({ id: z.id, latitude: lat, longitude: lon })} />
            ))}
            {data && data.zones.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  No zones yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ZoneRow({ zone, onSave }: { zone: any; onSave: (lat: number, lon: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [lat, setLat] = useState<string>(zone.latitude != null ? String(zone.latitude) : "");
  const [lon, setLon] = useState<string>(zone.longitude != null ? String(zone.longitude) : "");
  return (
    <tr className="border-b last:border-0">
      <td className="px-4 py-2 font-medium">{zone.name}</td>
      <td className="px-4 py-2">{zone.postal_prefix ?? "—"}</td>
      <td className="px-4 py-2">
        {editing ? (
          <div className="flex gap-1">
            <Input className="h-8 w-24" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="lat" />
            <Input className="h-8 w-24" value={lon} onChange={(e) => setLon(e.target.value)} placeholder="lon" />
          </div>
        ) : zone.latitude != null ? (
          `${zone.latitude.toFixed(3)}, ${zone.longitude.toFixed(3)}`
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-2 text-muted-foreground">{zone.price_note ?? "—"}</td>
      <td className="px-4 py-2 text-right">
        {editing ? (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              onClick={() => {
                const la = Number(lat);
                const lo = Number(lon);
                if (Number.isFinite(la) && Number.isFinite(lo)) {
                  onSave(la, lo);
                  setEditing(false);
                }
              }}
            >
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            {zone.latitude != null ? "Edit coords" : "Add coords"}
          </Button>
        )}
      </td>
    </tr>
  );
}
