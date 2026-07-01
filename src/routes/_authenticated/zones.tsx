import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { listZones, createZone } from "@/lib/zones.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/zones")({
  component: ZonesPage,
});

function ZonesPage() {
  const list = useServerFn(listZones);
  const create = useServerFn(createZone);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["zones"], queryFn: () => list() });
  const [name, setName] = useState("");
  const [postalPrefix, setPostalPrefix] = useState("");
  const [priceNote, setPriceNote] = useState("");

  const mut = useMutation({
    mutationFn: () => create({ data: { name, postalPrefix: postalPrefix || undefined, priceNote: priceNote || undefined } }),
    onSuccess: () => {
      setName("");
      setPostalPrefix("");
      setPriceNote("");
      qc.invalidateQueries({ queryKey: ["zones"] });
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Zones</h1>
        <p className="text-sm text-muted-foreground">
          Territories used to order visits into a route. Postal prefix drives the naive routing order.
        </p>
      </div>

      <form
        className="grid gap-3 rounded-lg border bg-card p-5 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name) mut.mutate();
        }}
      >
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="pp">Postal prefix</Label>
          <Input id="pp" placeholder="e.g. 787" value={postalPrefix} onChange={(e) => setPostalPrefix(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="pn">Price note</Label>
          <Input id="pn" value={priceNote} onChange={(e) => setPriceNote(e.target.value)} />
        </div>
        <div className="flex items-end">
          <Button type="submit" disabled={mut.isPending || !name}>
            {mut.isPending ? "Adding…" : "Add zone"}
          </Button>
        </div>
        {mut.error && <p className="col-span-full text-sm text-destructive">{(mut.error as Error).message}</p>}
      </form>

      <div className="rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Postal prefix</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Notes</th>
            </tr>
          </thead>
          <tbody>
            {(data?.zones ?? []).map((z: any) => (
              <tr key={z.id} className="border-b last:border-0">
                <td className="px-4 py-2 font-medium">{z.name}</td>
                <td className="px-4 py-2">{z.postal_prefix ?? "—"}</td>
                <td className="px-4 py-2">{z.account_type ?? "—"}</td>
                <td className="px-4 py-2 text-muted-foreground">{z.price_note ?? "—"}</td>
              </tr>
            ))}
            {data && data.zones.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
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
