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
  listAllDogsForDna,
  billDnaViolation,
  getViolationNotice,
  type DnaMatch,
} from "@/lib/dna.functions";
import { setDogDna } from "@/lib/dogs.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { FlaskConical, Trash2, Dna, Receipt, FileText, Printer } from "lucide-react";
import { usePermissions } from "@/hooks/useMyRole";

export const Route = createFileRoute("/_authenticated/dna")({
  head: () => ({
    meta: [
      { title: "DNA compliance · HoundStack" },
      {
        name: "description",
        content: "Register dogs, log DNA samples, match pile evidence, and issue violation notices with fines.",
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
  const { can } = usePermissions();
  const canBillDna = can("manage_dna_billing");
  const listFn = useServerFn(listDnaMatches);
  const dogsFn = useServerFn(listRegisteredDogs);
  const allDogsFn = useServerFn(listAllDogsForDna);
  const createFn = useServerFn(createDnaMatch);
  const updateFn = useServerFn(updateDnaMatch);
  const deleteFn = useServerFn(deleteDnaMatch);
  const billFn = useServerFn(billDnaViolation);
  const noticeFn = useServerFn(getViolationNotice);
  const dnaFn = useServerFn(setDogDna);

  const { data, refetch, isLoading } = useQuery({
    queryKey: ["dna-matches"],
    queryFn: () => listFn(),
  });
  const dogsQ = useQuery({ queryKey: ["dna-dogs"], queryFn: () => dogsFn() });
  const allDogsQ = useQuery({ queryKey: ["dna-all-dogs"], queryFn: () => allDogsFn() });

  const [sampleKind, setSampleKind] = useState<"cheek_swab" | "pile_sample">("pile_sample");
  const [locationNote, setLocationNote] = useState("");
  const [labReference, setLabReference] = useState("");
  const [notes, setNotes] = useState("");
  const [noticeMatchId, setNoticeMatchId] = useState<string | null>(null);

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

  const bill = useMutation({
    mutationFn: (matchId: string) => billFn({ data: { matchId } }),
    onSuccess: (r) => {
      toast.success(`Invoice created (${r.invoiceId.slice(0, 8)}…) — status set to Billed`);
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
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
          Register dogs, log evidence, match pile samples, and issue violation notices.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        <Stat label="Total samples" value={s.total} />
        <Stat label="At lab" value={s.sent_to_lab ?? 0} />
        <Stat label="Matched" value={s.matched ?? 0} tone="good" />
        <Stat label="No match" value={s.unmatched ?? 0} />
        <Stat label="Fines billed" value={`$${((s.fine_cents ?? 0) / 100).toFixed(0)}`} />
      </div>

      <Tabs defaultValue="samples">
        <TabsList>
          <TabsTrigger value="samples">Samples & matches</TabsTrigger>
          <TabsTrigger value="registry">Registered dogs</TabsTrigger>
        </TabsList>

        <TabsContent value="samples" className="space-y-4">
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
                      <th className="px-3 py-2">Actions</th>
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
                            {Object.entries(STATUS_LABEL)
                              // Marking a sample billed is a billing action — office only.
                              .filter(([k]) => canBillDna || k !== "billed" || r.status === "billed")
                              .map(([k, v]) => (
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
                          {canBillDna ? (
                            <Input
                              type="number"
                              min={0}
                              step={5}
                              value={r.fine_cents / 100}
                              onChange={(e) => update.mutate({ id: r.id, fineCents: Math.round(Number(e.target.value) * 100) })}
                              className="h-8 w-20 text-xs"
                            />
                          ) : (
                            <span className="text-xs">
                              {r.fine_cents > 0 ? `$${(r.fine_cents / 100).toFixed(2)}` : "—"}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            {canBillDna && r.status === "matched" && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs"
                                  onClick={() => setNoticeMatchId(r.id)}
                                >
                                  <FileText className="h-3.5 w-3.5 mr-1" /> Notice
                                </Button>
                                <Button
                                  size="sm"
                                  className="h-7 text-xs"
                                  disabled={bill.isPending || !r.fine_cents}
                                  onClick={() => bill.mutate(r.id)}
                                >
                                  <Receipt className="h-3.5 w-3.5 mr-1" /> Bill fine
                                </Button>
                              </>
                            )}
                            {canBillDna && r.status === "billed" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => setNoticeMatchId(r.id)}
                              >
                                <FileText className="h-3.5 w-3.5 mr-1" /> Notice
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => del.mutate(r.id)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="registry" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Registered dogs</CardTitle>
              <p className="text-xs text-muted-foreground">
                Toggle DNA registration and record the lab's registry ID. Only registered dogs can be matched to pile samples.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Dog</th>
                      <th className="px-3 py-2">Owner</th>
                      <th className="px-3 py-2">Address</th>
                      <th className="px-3 py-2">Registered</th>
                      <th className="px-3 py-2">Registry ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allDogsQ.isLoading ? (
                      <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
                    ) : (allDogsQ.data ?? []).length === 0 ? (
                      <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No dogs on file yet.</td></tr>
                    ) : (allDogsQ.data ?? []).map((d: any) => (
                      <RegistryRow
                        key={d.id}
                        dog={d}
                        onSave={async (registered, registryId) => {
                          try {
                            await dnaFn({ data: { id: d.id, registered, registryId } });
                            toast.success(registered ? "Registered" : "Registration removed");
                            allDogsQ.refetch();
                            dogsQ.refetch();
                          } catch (e: any) {
                            toast.error(e.message);
                          }
                        }}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <NoticeDialog
        matchId={noticeMatchId}
        onClose={() => setNoticeMatchId(null)}
        fetchNotice={(id) => noticeFn({ data: { matchId: id } })}
      />
    </div>
  );
}

function RegistryRow({
  dog,
  onSave,
}: {
  dog: { id: string; name: string; breed: string | null; dna_registered: boolean; registry_id: string | null; client_name: string | null; street: string | null };
  onSave: (registered: boolean, registryId: string | null) => void | Promise<void>;
}) {
  const [registered, setRegistered] = useState(dog.dna_registered);
  const [regId, setRegId] = useState(dog.registry_id ?? "");
  const dirty = registered !== dog.dna_registered || (regId || null) !== (dog.registry_id || null);
  return (
    <tr className="border-t">
      <td className="px-3 py-2">
        <div className="font-medium">{dog.name}</div>
        {dog.breed && <div className="text-[11px] text-muted-foreground">{dog.breed}</div>}
      </td>
      <td className="px-3 py-2 text-xs">{dog.client_name ?? "—"}</td>
      <td className="px-3 py-2 text-xs">{dog.street ?? "—"}</td>
      <td className="px-3 py-2">
        <label className="inline-flex items-center gap-2 text-xs">
          <input type="checkbox" checked={registered} onChange={(e) => setRegistered(e.target.checked)} />
          {registered ? "Yes" : "No"}
        </label>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <Input
            value={regId}
            onChange={(e) => setRegId(e.target.value)}
            placeholder="PW-2026-0001"
            className="h-8 w-40 text-xs"
            disabled={!registered}
          />
          <Button
            size="sm"
            variant={dirty ? "default" : "outline"}
            disabled={!dirty}
            className="h-8"
            onClick={() => onSave(registered, regId || null)}
          >
            Save
          </Button>
        </div>
      </td>
    </tr>
  );
}

function NoticeDialog({
  matchId,
  onClose,
  fetchNotice,
}: {
  matchId: string | null;
  onClose: () => void;
  fetchNotice: (id: string) => Promise<any>;
}) {
  const q = useQuery({
    queryKey: ["dna-notice", matchId],
    queryFn: () => fetchNotice(matchId!),
    enabled: !!matchId,
  });

  const notice = q.data as any | undefined;
  const bodyText = notice ? renderNoticeText(notice) : "";

  return (
    <Dialog open={!!matchId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Violation notice</DialogTitle>
        </DialogHeader>
        {q.isLoading || !notice ? (
          <div className="py-6 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-3">
            <div id="dna-notice-print" className="rounded border bg-card p-4 text-sm leading-relaxed whitespace-pre-wrap font-serif">
              {bodyText}
            </div>
            <div className="text-xs text-muted-foreground">
              Recipient: {notice.clientEmail ?? "(no email on file)"}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(bodyText);
              toast.success("Copied");
            }}
            disabled={!notice}
          >
            Copy text
          </Button>
          <Button
            variant="outline"
            onClick={() => window.print()}
            disabled={!notice}
          >
            <Printer className="h-4 w-4 mr-1" /> Print
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function renderNoticeText(n: {
  orgName: string;
  clientName: string;
  dogName: string | null;
  breed: string | null;
  registryId: string | null;
  street: string | null;
  collectedAt: string;
  matchedAt: string | null;
  labReference: string | null;
  locationNote: string | null;
  fineCents: number;
  notes: string | null;
}) {
  const today = new Date().toLocaleDateString();
  const collected = new Date(n.collectedAt).toLocaleDateString();
  const matched = n.matchedAt ? new Date(n.matchedAt).toLocaleDateString() : "—";
  const fine = `$${(n.fineCents / 100).toFixed(2)}`;
  return `${today}

Dear ${n.clientName},

This is a formal notice from ${n.orgName} regarding a confirmed pet-waste violation on the property${n.street ? ` at ${n.street}` : ""}.

A pile sample was collected on ${collected}${n.locationNote ? ` (${n.locationNote})` : ""} and submitted for DNA analysis${n.labReference ? ` under lab reference ${n.labReference}` : ""}. Results returned on ${matched} matched the registered DNA profile of your dog${n.dogName ? ` "${n.dogName}"` : ""}${n.breed ? ` (${n.breed})` : ""}${n.registryId ? `, registry ID ${n.registryId}` : ""}.

Per the community pet-waste policy, a fine of ${fine} has been assessed and will appear on your next invoice.

Please pick up after your dog on every walk. Continued violations may result in escalating fines or termination of pet privileges.
${n.notes ? `\nAdditional notes: ${n.notes}\n` : ""}
Sincerely,
${n.orgName}`;
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
