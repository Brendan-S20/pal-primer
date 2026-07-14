import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useMyRole } from "@/hooks/useMyRole";
import {
  listManifests,
  createManifest,
  deleteManifest,
  listFacilities,
  upsertFacility,
} from "@/lib/stations.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { HelpTip } from "@/components/HelpTip";

export const Route = createFileRoute("/_authenticated/waste-log")({
  head: () => ({ meta: [{ title: "Waste disposal log" }] }),
  component: WasteLogPage,
});

function WasteLogPage() {
  const qc = useQueryClient();
  const listMans = useServerFn(listManifests);
  const listFacs = useServerFn(listFacilities);
  const createFn = useServerFn(createManifest);
  const delFn = useServerFn(deleteManifest);
  const upsertFacFn = useServerFn(upsertFacility);

  const mans = useQuery({ queryKey: ["waste-manifests"], queryFn: () => listMans({ data: {} }) });
  const facs = useQuery({ queryKey: ["waste-facilities"], queryFn: () => listFacs() });

  const { orgId } = useMyRole();
  const [draft, setDraft] = useState({
    facilityId: "" as string,
    disposedOn: new Date().toISOString().slice(0, 10),
    weightLbs: "" as string,
    bagCount: "" as string,
    ticketNumber: "",
    notes: "",
  });
  const [receipt, setReceipt] = useState<File | null>(null);
  const [newFacility, setNewFacility] = useState({ name: "", address: "" });

  const createMut = useMutation({
    // Receipt photo (punch list #16): compress + upload to the org-scoped
    // waste-receipts bucket, then store the path on the manifest.
    mutationFn: async (v: any) => {
      let photoUrl: string | undefined;
      if (receipt) {
        if (!orgId) throw new Error("Still loading your organization. Try again in a second.");
        const { compressImage } = await import("@/lib/offline/compressImage");
        const { file, contentType, ext } = await compressImage(receipt);
        const path = `${orgId}/${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("waste-receipts")
          .upload(path, file, { contentType, upsert: false });
        if (upErr) throw new Error(`Receipt upload failed: ${upErr.message}`);
        photoUrl = path;
      }
      return createFn({ data: { ...v, photoUrl } });
    },
    onSuccess: () => {
      toast.success("Manifest logged");
      qc.invalidateQueries({ queryKey: ["waste-manifests"] });
      setDraft({
        facilityId: draft.facilityId,
        disposedOn: draft.disposedOn,
        weightLbs: "",
        bagCount: "",
        ticketNumber: "",
        notes: "",
      });
      setReceipt(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["waste-manifests"] });
    },
  });
  const facMut = useMutation({
    mutationFn: (v: any) => upsertFacFn({ data: v }),
    onSuccess: () => {
      toast.success("Facility added");
      qc.invalidateQueries({ queryKey: ["waste-facilities"] });
      setNewFacility({ name: "", address: "" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const manifests: any[] = mans.data?.manifests ?? [];
  const facilities: any[] = facs.data?.facilities ?? [];
  const totalLbs = manifests.reduce((s, m) => s + Number(m.weight_lbs ?? 0), 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            Waste disposal log <HelpTip article="waste-log" />
          </h1>
          <p className="text-sm text-muted-foreground">
            Track dumps at transfer stations and disposal facilities.
          </p>
        </div>
        <Badge variant="secondary">Recent total: {totalLbs.toFixed(0)} lbs</Badge>
      </div>

      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium">Log a dump</h2>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault();
            createMut.mutate({
              facilityId: draft.facilityId || null,
              disposedOn: draft.disposedOn,
              weightLbs: draft.weightLbs ? Number(draft.weightLbs) : undefined,
              bagCount: draft.bagCount ? parseInt(draft.bagCount, 10) : undefined,
              ticketNumber: draft.ticketNumber || undefined,
              notes: draft.notes || undefined,
            });
          }}
        >
          <div className="sm:col-span-2">
            <Label>Facility</Label>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={draft.facilityId}
              onChange={(e) => setDraft({ ...draft, facilityId: e.target.value })}
            >
              <option value="">(none)</option>
              {facilities
                .filter((f) => f.active)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <Label>Date</Label>
            <Input
              type="date"
              value={draft.disposedOn}
              onChange={(e) => setDraft({ ...draft, disposedOn: e.target.value })}
            />
          </div>
          <div>
            <Label>Weight (lbs)</Label>
            <Input
              type="number"
              step="0.1"
              min="0"
              value={draft.weightLbs}
              onChange={(e) => setDraft({ ...draft, weightLbs: e.target.value })}
            />
          </div>
          <div>
            <Label>Bags</Label>
            <Input
              type="number"
              min="0"
              value={draft.bagCount}
              onChange={(e) => setDraft({ ...draft, bagCount: e.target.value })}
            />
          </div>
          <div>
            <Label>Ticket #</Label>
            <Input
              value={draft.ticketNumber}
              onChange={(e) => setDraft({ ...draft, ticketNumber: e.target.value })}
            />
          </div>
          <div className="sm:col-span-6">
            <Label>Notes</Label>
            <Textarea
              rows={2}
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </div>
          <div className="sm:col-span-6">
            <Label>Receipt photo (optional)</Label>
            <Input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
            />
            {receipt && <p className="mt-1 text-xs text-muted-foreground">{receipt.name}</p>}
          </div>
          <div className="sm:col-span-6">
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending ? "Logging…" : "Log dump"}
            </Button>
          </div>
        </form>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Facilities</h2>
        </div>
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newFacility.name) return;
            facMut.mutate(newFacility);
          }}
        >
          <div className="flex-1 min-w-40">
            <Label>Name</Label>
            <Input
              value={newFacility.name}
              onChange={(e) => setNewFacility({ ...newFacility, name: e.target.value })}
              placeholder="Transfer Station"
            />
          </div>
          <div className="flex-1 min-w-40">
            <Label>Address</Label>
            <Input
              value={newFacility.address}
              onChange={(e) => setNewFacility({ ...newFacility, address: e.target.value })}
            />
          </div>
          <Button type="submit" disabled={facMut.isPending}>
            Add
          </Button>
        </form>
        {facilities.length > 0 && (
          <ul className="mt-3 divide-y text-sm">
            {facilities.map((f) => (
              <li key={f.id} className="flex items-center justify-between py-2">
                <div>
                  <div className="font-medium">
                    {f.name}
                    {!f.active && (
                      <Badge variant="outline" className="ml-2">
                        inactive
                      </Badge>
                    )}
                  </div>
                  {f.address && <div className="text-xs text-muted-foreground">{f.address}</div>}
                </div>
                {f.address && (
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(f.address)}&travelmode=driving`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary underline"
                  >
                    Directions
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium">Recent manifests</h2>
        {manifests.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No manifests yet.</p>
        ) : (
          <ul className="mt-3 divide-y text-sm">
            {manifests.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <div className="font-medium">
                    {m.disposed_on} · {m.waste_disposal_facilities?.name ?? "-"}
                    {m.ticket_number && (
                      <span className="ml-2 text-xs text-muted-foreground">#{m.ticket_number}</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {m.weight_lbs ? `${m.weight_lbs} lbs` : ""}
                    {m.bag_count ? ` · ${m.bag_count} bags` : ""}
                    {m.staff?.display_name ? ` · ${m.staff.display_name}` : ""}
                  </div>
                  {m.notes && <div className="text-xs text-muted-foreground">{m.notes}</div>}
                </div>
                <div className="flex items-center gap-1">
                  {m.photo_url && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const { data, error } = await supabase.storage
                          .from("waste-receipts")
                          .createSignedUrl(m.photo_url, 300);
                        if (error || !data?.signedUrl) {
                          toast.error("Couldn't open the receipt");
                          return;
                        }
                        window.open(data.signedUrl, "_blank", "noreferrer");
                      }}
                    >
                      Receipt
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => delMut.mutate(m.id)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        <Link to="/my-day" className="underline">
          Back to My Day
        </Link>
      </p>
    </div>
  );
}
