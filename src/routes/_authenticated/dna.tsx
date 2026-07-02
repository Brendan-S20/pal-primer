import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  listDnaMatches,
  createDnaMatch,
  updateDnaMatch,
  deleteDnaMatch,
  listRegisteredDogs,
  type DnaMatch,
} from "@/lib/dna.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { FlaskConical, Trash2, Dna } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dna")({
  head: () => ({
    meta: [
      { title: "DNA compliance · ScoopCRM" },
      {
        name: "description",
        content: "Log DNA cheek swabs and pile samples, match them to registered dogs, and bill offending owners.",
      },
    ],
  }),
  component: DnaPage,
});

const STATUS_LABEL: Record<DnaMatch["status"], string> = {
  new: "Collected",
  sent_to_lab: "At lab",
  matched: "Matched",
  unmatched: "No match",
  billed: "Billed",
  closed: "Closed",
};
const STATUS_TONE: Record<DnaMatch["status"], "default" | "secondary" | "outline" | "destructive"> = {
  new: "secondary",
  sent_to_lab: "outline",
  matched: "default",
  unmatched: "destructive",
  billed: "default",
  closed: "outline",
};

function DnaPage() {
  const listFn = useServerFn(listDnaMatches);
  const dogsFn = useServerFn(listRegisteredDogs);
  const createFn = useServerFn(createDnaMatch);
  const updateFn = useServerFn(updateDnaMatch);
  const deleteFn = useServerFn(deleteDnaMatch);

  const { data, refetch, isLoading } = useQuery({
    queryKey: ["dna-matches"],
    queryFn: () => listFn(),
  });
  const dogsQ = useQuery({ queryKey: ["dna-dogs"], queryFn: () => dogsFn() });

  const [sampleKind, setSampleKind] = useState<"cheek_swab" | "pile_sample">("pile_sample");
  const [locationNote, setLocationNote] = useState("");
  const [labReference, setLabReference] = useState("");
  const [notes, setNotes] = useState("");

  const create = useMutation({
    mutationFn: () =>
      createFn({
        data: {
          sampleKind,
          locationNote: locationNote || undefined,
          labReference: labReference || undefined,
          notes: notes || undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Sample logged");
      setLocationNote("");
      setLabReference("");
      setNotes("");
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: (v: {
      id: string;
      status?: DnaMatch["status"];
      matchedDogId?: string | null;
      fineCents?: number;
      labReference?: string | null;
    }) => updateFn({ data: v }),
    onSuccess: () => refetch(),
    onError: (e: Error) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => refetch(),
  });

  const rows = data?.rows ?? [];
  const s = data?.summary ?? { total: 0, fine_cents: 0 };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Dna className="h-6 w-6" /> DNA compliance
        </h1>
        <p className="text-sm text-muted-foreground">
          Chain-of-custody log for cheek swabs and pile samples. Match pile samples to registered dogs, bill the offending owner, close the case.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        <Stat label="Total samples" value={s.total} />
        <Stat label="At lab" value={s.sent_to_lab ?? 0} />
        <Stat label="Matched" value={s.matched ?? 0} tone="good" />
        <Stat label="No match" value={s.unmatched ?? 0} />
        <Stat label="Fines billed" value={`$${((s.fine_cents ?? 0) / 100).toFixed(0)}`} />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><FlaskConical className="h-4 w-4" /> Log a new sample</CardTitle></CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <div>
            <Label>Sample kind</Label>
            <select
              value={sampleKind}
              onChange={(e) => setSampleKind(e.target.value as any)}
              className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm"
            >
              <option value="pile_sample">Pile sample (evidence)</option>
              <option value="cheek_swab">Cheek swab (registration)</option>
            </select>
          </div>
          <div>
            <Label>Location note</Label>
            <Input value={locationNote} onChange={(e) => setLocationNote(e.target.value)} placeholder="Bldg C, grass strip near unit 214" />
          </div>
          <div>
            <Label>Lab reference</Label>
            <Input value={labReference} onChange={(e) => setLabReference(e.target.value)} placeholder="PW-2026-0001" />
          </div>
          <div className="md:col-span-4">
            <Label>Notes</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="md:col-span-4">
            <Button disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? "Logging…" : "Log sample"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Chain of custody</CardTitle></CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Collected</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Location</th>
                  <th className="px-3 py-2">Lab #</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Match</th>
                  <th className="px-3 py-2">Fine</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">
                    No samples logged. Add your first pile sample above.
                  </td></tr>
                ) : rows.map((r) => (
                  <tr key={r.id} className="border-t align-top">
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {new Date(r.collected_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="outline">{r.sample_kind === "cheek_swab" ? "Cheek swab" : "Pile"}</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs">{r.location_note ?? "—"}</td>
                    <td className="px-3 py-2 text-xs font-mono">{r.lab_reference ?? "—"}</td>
                    <td className="px-3 py-2">
                      <select
                        value={r.status}
                        onChange={(e) => update.mutate({ id: r.id, status: e.target.value as any })}
                        className="rounded border bg-background px-2 py-1 text-xs"
                      >
                        {Object.entries(STATUS_LABEL).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                      <Badge variant={STATUS_TONE[r.status]} className="ml-2">{STATUS_LABEL[r.status]}</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.sample_kind === "pile_sample" ? (
                        <select
                          value={r.matched_dog_id ?? ""}
                          onChange={(e) =>
                            update.mutate({ id: r.id, matchedDogId: e.target.value || null, status: e.target.value ? "matched" : r.status })
                          }
                          className="rounded border bg-background px-2 py-1 text-xs"
                        >
                          <option value="">Unmatched…</option>
                          {(dogsQ.data ?? []).map((d: any) => (
                            <option key={d.id} value={d.id}>
                              {d.name} — {d.client_name ?? "?"} ({d.registry_id ?? "no ID"})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-muted-foreground">n/a</span>
                      )}
                      {r.matched_dog_name && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          Owner: {r.matched_client_name ?? "?"}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        min={0}
                        step={5}
                        value={r.fine_cents / 100}
                        onChange={(e) => update.mutate({ id: r.id, fineCents: Math.round(Number(e.target.value) * 100) })}
                        className="h-8 w-20 text-xs"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="ghost" onClick={() => del.mutate(r.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "good" }) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold ${tone === "good" ? "text-emerald-600" : ""}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
