// Waste-station management for commercial/HOA properties. Moved verbatim
// from the route file during the client-detail refactor (Stage 2).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, StatusChip } from "@/components/client-detail/primitives";
import { listStations, upsertStation, deleteStation } from "@/lib/stations.functions";

export function StationsPanel({ clientId, properties }: { clientId: string; properties: any[] }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listStations);
  const upsertFn = useServerFn(upsertStation);
  const delFn = useServerFn(deleteStation);

  const { data } = useQuery({
    queryKey: ["stations", clientId],
    queryFn: () => listFn({ data: { clientId } }),
  });

  const upsertMut = useMutation({
    mutationFn: (v: any) => upsertFn({ data: v }),
    onSuccess: () => {
      toast.success("Station saved");
      qc.invalidateQueries({ queryKey: ["stations", clientId] });
      setDraft({
        label: "",
        locationDescription: "",
        linerSize: "",
        capacityLiners: "",
        propertyId: properties[0]?.id ?? "",
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stations", clientId] }),
  });

  const [draft, setDraft] = useState({
    label: "",
    locationDescription: "",
    linerSize: "",
    capacityLiners: "",
    propertyId: properties[0]?.id ?? "",
  });

  const stations: any[] = data?.stations ?? [];

  if (properties.length === 0) return null;

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Waste stations</h2>
        <span className="text-xs text-muted-foreground">
          Common for commercial / HOA properties
        </span>
      </div>

      {stations.length > 0 ? (
        <ul className="mt-3 divide-y text-sm">
          {stations.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium">
                  {s.label}
                  {!s.active && <StatusChip status="inactive" className="ml-2" />}
                </div>
                <div className="text-xs text-muted-foreground">
                  {s.location_description ?? ""}
                  {s.liner_size ? ` · liner: ${s.liner_size}` : ""}
                  {s.capacity_liners ? ` · cap: ${s.capacity_liners}` : ""}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => delMut.mutate(s.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-3">
          <EmptyState
            compact
            icon={MapPin}
            title="No stations added yet"
            description="Add waste stations so techs know what to service and refill."
          />
        </div>
      )}

      <form
        className="mt-4 grid gap-3 sm:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.label || !draft.propertyId) return;
          const prop = properties.find((p) => p.id === draft.propertyId);
          upsertMut.mutate({
            clientId,
            propertyId: draft.propertyId,
            label: draft.label,
            locationDescription: draft.locationDescription || null,
            linerSize: draft.linerSize || null,
            capacityLiners: draft.capacityLiners ? parseInt(draft.capacityLiners, 10) : null,
          });
        }}
      >
        <div className="sm:col-span-2">
          <Label>Property</Label>
          <select
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={draft.propertyId}
            onChange={(e) => setDraft({ ...draft, propertyId: e.target.value })}
          >
            {properties.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.street}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <Label>Label</Label>
          <Input
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            placeholder="Building A, north lot"
          />
        </div>
        <div>
          <Label>Liner size</Label>
          <Input
            value={draft.linerSize}
            onChange={(e) => setDraft({ ...draft, linerSize: e.target.value })}
            placeholder="10 gal"
          />
        </div>
        <div>
          <Label>Capacity</Label>
          <Input
            type="number"
            min="0"
            value={draft.capacityLiners}
            onChange={(e) => setDraft({ ...draft, capacityLiners: e.target.value })}
          />
        </div>
        <div className="sm:col-span-6">
          <Label>Location</Label>
          <Input
            value={draft.locationDescription}
            onChange={(e) => setDraft({ ...draft, locationDescription: e.target.value })}
            placeholder="Near mail kiosk"
          />
        </div>
        <div className="sm:col-span-6">
          <Button type="submit" disabled={upsertMut.isPending}>
            Add station
          </Button>
        </div>
      </form>
    </section>
  );
}
