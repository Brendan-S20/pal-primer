import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  listNeighborLeads,
  addNeighborLead,
  updateNeighborLead,
  deleteNeighborLead,
  seedNeighborsForClient,
  type NeighborLead,
} from "@/lib/neighbors.functions";
import { listClients } from "@/lib/clients.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import {
  MapPin,
  UserPlus,
  Trash2,
  Footprints,
  ArrowRight,
  ArrowLeft,
  Navigation2,
  Map as MapIcon,
  List,
  X,
} from "lucide-react";
import { NeighborMap, type NeighborPin } from "@/components/NeighborMap";
import { usePermissions } from "@/hooks/useMyRole";

export const Route = createFileRoute("/_authenticated/neighbors")({
  head: () => ({
    meta: [
      { title: "Neighbor canvassing · HoundStack" },
      {
        name: "description",
        content: "Turn happy clients into whole-street routes with door-to-door canvassing.",
      },
    ],
  }),
  component: NeighborsPage,
});

const STATUS_LABEL: Record<NeighborLead["status"], string> = {
  new: "To visit",
  contacted: "Contacted",
  interested: "Interested",
  converted: "Signed up",
  not_interested: "Passed",
};

function NeighborsPage() {
  const listFn = useServerFn(listNeighborLeads);
  const addFn = useServerFn(addNeighborLead);
  const updateFn = useServerFn(updateNeighborLead);
  const deleteFn = useServerFn(deleteNeighborLead);
  const seedFn = useServerFn(seedNeighborsForClient);
  const clientsFn = useServerFn(listClients);

  const { data, refetch, isLoading } = useQuery({
    queryKey: ["neighbor-leads"],
    queryFn: () => listFn(),
  });
  const { can } = usePermissions();
  const canSeeDirectory = can("view_client_directory");
  const clientsQ = useQuery({
    queryKey: ["clients", "for-canvass"],
    queryFn: () => clientsFn(),
    // The seed picker needs the client roster — techs don't get it.
    enabled: canSeeDirectory,
  });

  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [seedClient, setSeedClient] = useState<string>("");
  const [seedCount, setSeedCount] = useState(6);
  // Phone-only collapse; see the note above the two cards.
  const [showAddForms, setShowAddForms] = useState(false);

  const add = useMutation({
    mutationFn: () => addFn({ data: { addressLine: address, notes: notes || undefined } }),
    onSuccess: () => {
      toast.success("Lead added");
      setAddress("");
      setNotes("");
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const seed = useMutation({
    mutationFn: () => seedFn({ data: { clientId: seedClient, count: seedCount } }),
    onSuccess: (r) => {
      toast.success(`Seeded ${r.added} neighbor door${r.added === 1 ? "" : "s"}`);
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: (v: { id: string; status?: NeighborLead["status"]; notes?: string | null }) =>
      updateFn({ data: v }),
    onSuccess: () => refetch(),
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => refetch(),
  });

  const rows = data?.rows ?? [];
  const s = data?.summary ?? { total: 0 };
  const [walkMode, setWalkMode] = useState(false);
  const [view, setView] = useState<"list" | "map">("list");

  const [walkIdx, setWalkIdx] = useState(0);
  const walkQueue = rows.filter((r) => r.status === "new" || r.status === "contacted");
  const current = walkQueue[walkIdx];

  if (walkMode) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Footprints className="h-6 w-6" /> Walk mode
          </h1>
          <Button variant="outline" size="sm" onClick={() => setWalkMode(false)}>
            Exit
          </Button>
        </div>
        {!current ? (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground">
              No more doors in the queue. Great work!
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="space-y-4 p-6">
              <div className="text-xs text-muted-foreground">
                Door {walkIdx + 1} of {walkQueue.length}
              </div>
              <div className="text-xl font-semibold">{current.address_line}</div>
              {current.seed_client_name && (
                <div className="text-sm text-muted-foreground">
                  Seeded from: {current.seed_client_name}
                </div>
              )}
              {current.notes && <p className="rounded bg-muted p-2 text-sm">{current.notes}</p>}
              <a
                className="inline-flex items-center gap-1 text-sm text-primary underline"
                href={`https://maps.google.com/?q=${encodeURIComponent(current.address_line)}`}
                target="_blank"
                rel="noreferrer"
              >
                <Navigation2 className="h-4 w-4" /> Navigate
              </a>
              <div className="grid grid-cols-2 gap-2 pt-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    update.mutate({ id: current.id, status: "contacted" });
                    setWalkIdx((i) => i + 1);
                  }}
                >
                  Left flyer
                </Button>
                <Button
                  onClick={() => {
                    update.mutate({ id: current.id, status: "interested" });
                    setWalkIdx((i) => i + 1);
                  }}
                >
                  Interested
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    update.mutate({ id: current.id, status: "not_interested" });
                    setWalkIdx((i) => i + 1);
                  }}
                >
                  Passed
                </Button>
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700"
                  onClick={() => {
                    update.mutate({ id: current.id, status: "converted" });
                    setWalkIdx((i) => i + 1);
                  }}
                >
                  Signed up
                </Button>
              </div>
              <div className="flex items-center justify-between pt-2 text-xs">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={walkIdx === 0}
                  onClick={() => setWalkIdx((i) => Math.max(0, i - 1))}
                >
                  <ArrowLeft className="mr-1 h-4 w-4" /> Prev
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setWalkIdx((i) => i + 1)}>
                  Skip <ArrowRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <MapPin className="h-6 w-6" /> Neighbor canvassing
          </h1>
          <p className="text-sm text-muted-foreground">
            Every new client is a beachhead. Seed 5-10 doors on their street, canvass them, and turn
            one house into a whole route.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setWalkIdx(0);
            setWalkMode(true);
          }}
          disabled={walkQueue.length === 0}
        >
          <Footprints className="mr-1.5 h-4 w-4" />
          Walk mode ({walkQueue.length})
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        <Stat label="Total" value={s.total} />
        <Stat label="To visit" value={s.new ?? 0} />
        <Stat label="Contacted" value={s.contacted ?? 0} />
        <Stat label="Interested" value={s.interested ?? 0} />
        <Stat label="Signed up" value={s.converted ?? 0} tone="good" />
      </div>

      {/* Two data-entry cards used to sit permanently between the stats and the
          canvassing list. Side by side on a laptop that costs nothing, but they
          are `md:grid-cols-2`, so on a phone they stack into roughly a screen
          and a half of form that a tech standing on a street has to scroll past
          to reach the door list — which is the only reason they opened this
          page. Seeding and adding doors are office actions; walking the list is
          the field one.

          Collapsed on phones only, rather than everywhere: on a laptop there is
          room for all three and hiding them would cost the office a click for
          no gain. So the toggle is `md:hidden` and the container drops
          `max-md:hidden` — CSS rather than a media-query hook, which keeps the
          server and client renders identical. `waste-log.tsx` collapses its own
          form the same way (D polish). */}
      <div className="flex items-center justify-between md:hidden">
        <h2 className="text-sm font-medium">Add doors</h2>
        <Button
          size="sm"
          variant={showAddForms ? "ghost" : "outline"}
          onClick={() => setShowAddForms((v) => !v)}
        >
          {showAddForms ? (
            <>
              <X className="mr-1.5 h-4 w-4" /> Close
            </>
          ) : (
            <>
              <UserPlus className="mr-1.5 h-4 w-4" /> Add doors
            </>
          )}
        </Button>
      </div>

      <div className={`grid gap-4 md:grid-cols-2 ${showAddForms ? "" : "max-md:hidden"}`}>
        {canSeeDirectory && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Seed from an existing client</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label>Client</Label>
                <select
                  value={seedClient}
                  onChange={(e) => setSeedClient(e.target.value)}
                  className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm"
                >
                  <option value="">Pick a client…</option>
                  {(clientsQ.data?.clients ?? []).map((c: any) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>How many doors</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={seedCount}
                  onChange={(e) => setSeedCount(Number(e.target.value))}
                />
              </div>
              <Button disabled={!seedClient || seed.isPending} onClick={() => seed.mutate()}>
                <UserPlus className="mr-1.5 h-4 w-4" />
                {seed.isPending ? "Seeding…" : `Seed ${seedCount} neighbors`}
              </Button>
              <p className="text-xs text-muted-foreground">
                Generates addresses at even offsets from the client's house number on the same
                street.
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a door manually</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>Address</Label>
              {/* The single best-biased field in the app: a canvassing door is
                  by definition on a street the workspace already services, and
                  the proxy biases suggestions to the average of the org's
                  geocoded properties. Stored as one line (`address_line`), so
                  a match writes the formatted address. */}
              <AddressAutocomplete
                value={address}
                onChangeText={setAddress}
                onResolved={(r) => setAddress(r.address.formatted)}
                placeholder="123 Elm St, Springfield"
              />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Saw a golden retriever in the yard"
              />
            </div>
            <Button
              disabled={address.trim().length < 3 || add.isPending}
              onClick={() => add.mutate()}
            >
              {add.isPending ? "Adding…" : "Add lead"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Canvassing list</CardTitle>
          <div className="flex gap-1 rounded-md border p-0.5">
            <Button
              size="sm"
              variant={view === "list" ? "secondary" : "ghost"}
              className="h-7 px-2"
              onClick={() => setView("list")}
            >
              <List className="mr-1 h-3.5 w-3.5" /> List
            </Button>
            <Button
              size="sm"
              variant={view === "map" ? "secondary" : "ghost"}
              className="h-7 px-2"
              onClick={() => setView("map")}
            >
              <MapIcon className="mr-1 h-3.5 w-3.5" /> Map
            </Button>
          </div>
        </CardHeader>
        {/* Five columns of canvassing results, previously sizing the page
            rather than themselves. */}
        <CardContent className="overflow-x-auto p-0">
          {view === "map" ? (
            <div className="p-3">
              {rows.every((r) => r.latitude == null || r.longitude == null) ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No mapped leads yet. Seed from a client with a geocoded property to place pins.
                </div>
              ) : (
                <NeighborMap
                  pins={rows.map<NeighborPin>((r) => ({
                    id: r.id,
                    address: r.address_line,
                    status: r.status,
                    latitude: r.latitude,
                    longitude: r.longitude,
                    seedClientName: r.seed_client_name,
                    isSeed: false,
                  }))}
                />
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Address</th>
                  <th className="px-3 py-2">Seed client</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Notes</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                      No leads yet. Seed from a happy client to get going.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id} className="border-t align-top">
                      <td className="px-3 py-2 font-medium">{r.address_line}</td>
                      <td className="px-3 py-2 text-muted-foreground text-xs">
                        {r.seed_client_name ?? "-"}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={r.status}
                          onChange={(e) =>
                            update.mutate({ id: r.id, status: e.target.value as any })
                          }
                          className="rounded border bg-background px-2 py-1 text-xs"
                        >
                          {Object.entries(STATUS_LABEL).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 max-w-[300px] text-xs text-muted-foreground">
                        {r.notes ?? "-"}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <ConfirmButton
                          trigger={
                            <Button size="sm" variant="ghost">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          }
                          title="Delete this entry?"
                          description="This removes the canvassing entry permanently and can't be undone."
                          confirmLabel="Delete"
                          onConfirm={() => del.mutate(r.id)}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "good" }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold ${tone === "good" ? "text-emerald-600" : ""}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
