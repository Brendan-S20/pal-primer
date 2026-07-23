// DNA compliance workspace (IA rework): the landing view lists the
// commercial/HOA clients enrolled in DNA compliance; drilling into a client
// (?client=<id>) shows that client's samples & matches and registered dogs.
// The underlying records are the SAME ones the client-detail Units tab reads
// (I3) — only the entry point changed. Techs never reach this page; every
// server fn keeps its own permission gate (H1/I7).
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  listDnaMatches,
  createDnaMatch,
  updateDnaMatch,
  deleteDnaMatch,
  listRegisteredDogs,
  listAllDogsForDna,
  listDnaFormOptions,
  billDnaViolation,
  getViolationNotice,
  listDnaComplianceClients,
  setClientDnaCompliance,
  type DnaMatch,
  type DnaComplianceClient,
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
import {
  FlaskConical,
  Trash2,
  Dna,
  Receipt,
  FileText,
  Printer,
  Camera,
  Building2,
  ChevronRight,
  ArrowLeft,
} from "lucide-react";
import { usePermissions, useMyRole } from "@/hooks/useMyRole";
import { useSignedUrl } from "@/hooks/useSignedUrl";
import { supabase } from "@/integrations/supabase/client";
import { HelpTip } from "@/components/HelpTip";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/_authenticated/dna")({
  // ?client=<uuid> scopes the workspace to one enrolled client; anything else
  // falls back to the landing list.
  validateSearch: (search: Record<string, unknown>): { client?: string } => {
    const c = search.client;
    return typeof c === "string" && UUID_RE.test(c) ? { client: c } : {};
  },
  head: () => ({
    meta: [
      { title: "DNA compliance · HoundStack" },
      {
        name: "description",
        content:
          "Register dogs, log DNA samples, match pile evidence, and issue violation notices with fines.",
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
const STATUS_TONE: Record<DnaMatch["status"], "default" | "secondary" | "outline" | "destructive"> =
  {
    new: "secondary",
    sent_to_lab: "outline",
    matched: "default",
    unmatched: "destructive",
    billed: "default",
    closed: "outline",
  };

/** Signed-URL link to a sample's collection photo (private dna-samples
 * bucket). Quietly renders nothing if the URL can't be signed. */
function SamplePhotoLink({ path }: { path: string }) {
  const { url } = useSignedUrl("dna-samples", path);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary underline"
    >
      <Camera className="h-3 w-3" /> Collection photo
    </a>
  );
}

function DnaPage() {
  const { client } = Route.useSearch();
  return client ? <ClientDnaWorkspace clientId={client} /> : <DnaLanding />;
}

// ── Landing: enrolled commercial/HOA clients ─────────────────────────────────

function DnaLanding() {
  const { role } = usePermissions();
  const canWrite = role != null && role !== "tech";
  const qc = useQueryClient();
  const listFn = useServerFn(listDnaMatches);
  const complianceFn = useServerFn(listDnaComplianceClients);
  const enableFn = useServerFn(setClientDnaCompliance);

  // Org-wide stats row (kept from the old IA — one existing query).
  const statsQ = useQuery({ queryKey: ["dna-matches"], queryFn: () => listFn({}) });
  const complianceQ = useQuery({
    queryKey: ["dna-compliance-clients"],
    queryFn: () => complianceFn(),
  });

  const [enableClientId, setEnableClientId] = useState("");
  const enable = useMutation({
    mutationFn: (clientId: string) => enableFn({ data: { clientId, enabled: true } }),
    onSuccess: () => {
      toast.success("DNA compliance enabled");
      setEnableClientId("");
      qc.invalidateQueries({ queryKey: ["dna-compliance-clients"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const s = statsQ.data?.summary ?? { total: 0, fine_cents: 0 };
  const rows: DnaComplianceClient[] = complianceQ.data?.rows ?? [];
  const notEnabled = complianceQ.data?.notEnabled ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Dna className="h-6 w-6" /> DNA compliance <HelpTip article="dna" />
        </h1>
        <p className="text-sm text-muted-foreground">
          The commercial and HOA communities enrolled in DNA compliance. Open a client to manage
          its samples, matches, and registered dogs.
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
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4" /> Enrolled clients
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Client</th>
                  <th className="px-3 py-2">Properties</th>
                  <th className="px-3 py-2">Registered dogs</th>
                  <th className="px-3 py-2">Samples</th>
                  <th className="px-3 py-2">Open matches</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {complianceQ.isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                      No clients enrolled in DNA compliance yet. Enable it for a commercial client
                      below.
                    </td>
                  </tr>
                ) : (
                  rows.map((c) => (
                    <tr key={c.id} className="border-t hover:bg-accent/50">
                      <td className="px-3 py-2">
                        <Link
                          to="/dna"
                          search={{ client: c.id }}
                          className="font-medium text-primary hover:underline"
                        >
                          {c.display_name}
                        </Link>
                      </td>
                      <td className="px-3 py-2">{c.property_count}</td>
                      <td className="px-3 py-2">
                        {c.registered_dogs} / {c.total_dogs}
                      </td>
                      <td className="px-3 py-2">{c.sample_count}</td>
                      <td className="px-3 py-2">
                        {c.open_violations > 0 ? (
                          <Badge variant="destructive">{c.open_violations}</Badge>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          to="/dna"
                          search={{ client: c.id }}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          Open <ChevronRight className="h-3.5 w-3.5" />
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Enable DNA compliance</CardTitle>
            <p className="text-xs text-muted-foreground">
              {notEnabled.length === 0
                ? "Every commercial client is already enrolled."
                : `${notEnabled.length} commercial client${notEnabled.length === 1 ? " is" : "s are"} not enrolled yet.`}
            </p>
          </CardHeader>
          {notEnabled.length > 0 && (
            <CardContent className="flex flex-wrap items-end gap-3">
              <div>
                <Label>Commercial client</Label>
                <select
                  value={enableClientId}
                  onChange={(e) => setEnableClientId(e.target.value)}
                  className="mt-1 block w-64 rounded border bg-background px-3 py-2 text-sm"
                >
                  <option value="">Select client…</option>
                  {notEnabled.map((c: { id: string; display_name: string }) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                disabled={!enableClientId || enable.isPending}
                onClick={() => enable.mutate(enableClientId)}
              >
                {enable.isPending ? "Enabling…" : "Enable"}
              </Button>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}

// ── Client-scoped workspace: samples & matches / registered dogs ─────────────

function ClientDnaWorkspace({ clientId }: { clientId: string }) {
  const { can } = usePermissions();
  const { orgId } = useMyRole();
  const canBillDna = can("manage_dna_billing");
  const listFn = useServerFn(listDnaMatches);
  const dogsFn = useServerFn(listRegisteredDogs);
  const allDogsFn = useServerFn(listAllDogsForDna);
  const optionsFn = useServerFn(listDnaFormOptions);
  const createFn = useServerFn(createDnaMatch);
  const updateFn = useServerFn(updateDnaMatch);
  const deleteFn = useServerFn(deleteDnaMatch);
  const billFn = useServerFn(billDnaViolation);
  const noticeFn = useServerFn(getViolationNotice);
  const dnaFn = useServerFn(setDogDna);
  const complianceFn = useServerFn(listDnaComplianceClients);

  const { data, refetch, isLoading } = useQuery({
    queryKey: ["dna-matches", clientId],
    queryFn: () => listFn({ data: { clientId } }),
  });
  const dogsQ = useQuery({
    queryKey: ["dna-dogs", clientId],
    queryFn: () => dogsFn({ data: { clientId } }),
  });
  const allDogsQ = useQuery({
    queryKey: ["dna-all-dogs", clientId],
    queryFn: () => allDogsFn({ data: { clientId } }),
  });
  const optionsQ = useQuery({ queryKey: ["dna-form-options"], queryFn: () => optionsFn() });
  const complianceQ = useQuery({
    queryKey: ["dna-compliance-clients"],
    queryFn: () => complianceFn(),
  });

  const clientName =
    complianceQ.data?.rows.find((r: DnaComplianceClient) => r.id === clientId)?.display_name ??
    complianceQ.data?.notEnabled.find((r: { id: string }) => r.id === clientId)?.display_name ??
    null;

  const [sampleKind, setSampleKind] = useState<"cheek_swab" | "pile_sample">("pile_sample");
  const [locationNote, setLocationNote] = useState("");
  const [labReference, setLabReference] = useState("");
  const [notes, setNotes] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [collectedByStaffId, setCollectedByStaffId] = useState("");
  const [kitReference, setKitReference] = useState("");
  const [dnaProvider, setDnaProvider] = useState("");
  const [samplePhoto, setSamplePhoto] = useState<File | null>(null);
  const [noticeMatchId, setNoticeMatchId] = useState<string | null>(null);

  const opts = optionsQ.data;
  // Prefilter the sample form's property dropdown to this client's properties.
  const clientProperties = (opts?.properties ?? []).filter(
    (p: any) => p.client_id === clientId,
  );
  const selectedProp = clientProperties.find((p: any) => p.id === propertyId);
  const propUnits = (opts?.units ?? []).filter((u: any) => u.property_id === propertyId);

  const create = useMutation({
    mutationFn: async () => {
      // Collection-evidence photo (deferred B8): upload to the private
      // org-scoped dna-samples bucket, then record the path on the sample.
      let samplePhotoPath: string | undefined;
      if (samplePhoto) {
        if (!orgId) throw new Error("Still loading your organization. Try again in a second.");
        const { compressImage } = await import("@/lib/offline/compressImage");
        const { file, contentType, ext } = await compressImage(samplePhoto);
        const path = `${orgId}/${Date.now()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from("dna-samples")
          .upload(path, file, { contentType, upsert: false });
        if (upErr) throw new Error(upErr.message);
        samplePhotoPath = path;
      }
      return createFn({
        data: {
          sampleKind,
          locationNote: locationNote || undefined,
          labReference: labReference || undefined,
          notes: notes || undefined,
          propertyId: propertyId || undefined,
          clientId: selectedProp?.client_id || clientId,
          unitId: unitId || undefined,
          collectedByStaffId: collectedByStaffId || undefined,
          kitReference: kitReference || undefined,
          dnaProvider: dnaProvider || undefined,
          samplePhotoPath,
        },
      });
    },
    onSuccess: () => {
      toast.success("Sample logged");
      setLocationNote("");
      setLabReference("");
      setNotes("");
      setUnitId("");
      setKitReference("");
      setSamplePhoto(null);
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
      toast.success(`Invoice created (${r.invoiceId.slice(0, 8)}…). Status set to Billed`);
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = data?.rows ?? [];
  const s = data?.summary ?? { total: 0, fine_cents: 0 };

  return (
    <div className="space-y-6">
      <div>
        <nav className="mb-1 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link to="/dna" search={{}} className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> All clients
          </Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-foreground">{clientName ?? "Client"}</span>
        </nav>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Dna className="h-6 w-6" /> {clientName ?? "DNA compliance"}{" "}
          <HelpTip article="dna" />
        </h1>
        <p className="text-sm text-muted-foreground">
          Register dogs, log evidence, match pile samples, and issue violation notices for this
          client.
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
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FlaskConical className="h-4 w-4" /> Log a new sample
              </CardTitle>
            </CardHeader>
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
                <Label>Property</Label>
                <select
                  value={propertyId}
                  onChange={(e) => {
                    setPropertyId(e.target.value);
                    setUnitId("");
                  }}
                  className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm"
                >
                  <option value="">
                    {clientProperties.length === 0
                      ? "No properties for this client"
                      : "Select property…"}
                  </option>
                  {clientProperties.map((p: any) => (
                    <option key={p.id} value={p.id}>
                      {p.street}
                    </option>
                  ))}
                </select>
                {selectedProp?.client_name && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Client: {selectedProp.client_name}
                  </p>
                )}
              </div>
              <div>
                <Label>Unit</Label>
                <select
                  value={unitId}
                  onChange={(e) => setUnitId(e.target.value)}
                  disabled={!propertyId || propUnits.length === 0}
                  className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm disabled:opacity-60"
                >
                  <option value="">
                    {propUnits.length === 0 ? "No units on this property" : "Select unit…"}
                  </option>
                  {propUnits.map((u: any) => (
                    <option key={u.id} value={u.id}>
                      Unit {u.unit_label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Collected by (tech)</Label>
                <select
                  value={collectedByStaffId}
                  onChange={(e) => setCollectedByStaffId(e.target.value)}
                  className="mt-1 block w-full rounded border bg-background px-3 py-2 text-sm"
                >
                  <option value="">Unassigned…</option>
                  {(opts?.staff ?? []).map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.display_name}
                      {s.is_field_tech ? "" : " (office)"}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Kit reference</Label>
                <Input
                  value={kitReference}
                  onChange={(e) => setKitReference(e.target.value)}
                  placeholder="KIT-00123 (chain of custody)"
                />
              </div>
              <div>
                <Label>DNA provider</Label>
                <Input
                  value={dnaProvider}
                  onChange={(e) => setDnaProvider(e.target.value)}
                  placeholder="e.g. PooPrints"
                />
              </div>
              <div>
                <Label>Location note</Label>
                <Input
                  value={locationNote}
                  onChange={(e) => setLocationNote(e.target.value)}
                  placeholder="Bldg C, grass strip near unit 214"
                />
              </div>
              <div>
                <Label>Lab reference</Label>
                <Input
                  value={labReference}
                  onChange={(e) => setLabReference(e.target.value)}
                  placeholder="PW-2026-0001"
                />
              </div>
              <div>
                <Label>Collection photo (optional)</Label>
                <div className="mt-1 flex items-center gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground transition hover:border-primary hover:bg-accent">
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={(e) => setSamplePhoto(e.target.files?.[0] ?? null)}
                    />
                    <Camera className="h-4 w-4" />
                    {samplePhoto ? "Change photo" : "Add photo"}
                  </label>
                  {samplePhoto && (
                    <span className="max-w-[10rem] truncate text-xs text-muted-foreground">
                      {samplePhoto.name}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Evidence of the collection (bagged sample / kit at the site).
                </p>
              </div>
              <div className="md:col-span-4">
                <Label>Notes</Label>
                <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Provider references, statuses, and reports only — no raw genetic markers are stored.
                </p>
              </div>
              <div className="md:col-span-4">
                <Button disabled={create.isPending} onClick={() => create.mutate()}>
                  {create.isPending ? "Logging…" : "Log sample"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Chain of custody</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Collected</th>
                      <th className="px-3 py-2">Kind</th>
                      <th className="px-3 py-2">Unit</th>
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
                      <tr>
                        <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                          Loading…
                        </td>
                      </tr>
                    ) : rows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                          No samples logged for this client. Add your first pile sample above.
                        </td>
                      </tr>
                    ) : (
                      rows.map((r) => (
                        <tr key={r.id} className="border-t align-top">
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {new Date(r.collected_at).toLocaleString()}
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant="outline">
                              {r.sample_kind === "cheek_swab" ? "Cheek swab" : "Pile"}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {r.unit_label ? (
                              <span>Unit {r.unit_label}</span>
                            ) : r.property_street ? (
                              <span className="text-muted-foreground">{r.property_street}</span>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                            {r.collected_by_name && (
                              <div className="text-[11px] text-muted-foreground">
                                by {r.collected_by_name}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {r.location_note ?? "-"}
                            {r.kit_reference && (
                              <div className="text-[11px] text-muted-foreground font-mono">
                                kit {r.kit_reference}
                              </div>
                            )}
                            {r.sample_photo_path && <SamplePhotoLink path={r.sample_photo_path} />}
                          </td>
                          <td className="px-3 py-2 text-xs font-mono">{r.lab_reference ?? "-"}</td>
                          <td className="px-3 py-2">
                            <select
                              value={r.status}
                              onChange={(e) =>
                                update.mutate({ id: r.id, status: e.target.value as any })
                              }
                              className="rounded border bg-background px-2 py-1 text-xs"
                            >
                              {Object.entries(STATUS_LABEL)
                                // Marking a sample billed is a billing action — office only.
                                .filter(
                                  ([k]) => canBillDna || k !== "billed" || r.status === "billed",
                                )
                                .map(([k, v]) => (
                                  <option key={k} value={k}>
                                    {v}
                                  </option>
                                ))}
                            </select>
                            <Badge variant={STATUS_TONE[r.status]} className="ml-2">
                              {STATUS_LABEL[r.status]}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {r.sample_kind === "pile_sample" ? (
                              <select
                                value={r.matched_dog_id ?? ""}
                                onChange={(e) =>
                                  update.mutate({
                                    id: r.id,
                                    matchedDogId: e.target.value || null,
                                    status: e.target.value ? "matched" : r.status,
                                  })
                                }
                                className="rounded border bg-background px-2 py-1 text-xs"
                              >
                                <option value="">Unmatched…</option>
                                {(dogsQ.data ?? []).map((d: any) => (
                                  <option key={d.id} value={d.id}>
                                    {d.name}, {d.client_name ?? "?"} ({d.registry_id ?? "no ID"})
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
                                onChange={(e) =>
                                  update.mutate({
                                    id: r.id,
                                    fineCents: Math.round(Number(e.target.value) * 100),
                                  })
                                }
                                className="h-8 w-20 text-xs"
                              />
                            ) : (
                              <span className="text-xs">
                                {r.fine_cents > 0 ? `$${(r.fine_cents / 100).toFixed(2)}` : "-"}
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
                      ))
                    )}
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
                Toggle DNA registration and record the lab's registry ID. Only registered dogs can
                be matched to pile samples.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Dog</th>
                      <th className="px-3 py-2">Owner</th>
                      <th className="px-3 py-2">Unit</th>
                      <th className="px-3 py-2">Address</th>
                      <th className="px-3 py-2">Registered</th>
                      <th className="px-3 py-2">Registry ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allDogsQ.isLoading ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                          Loading…
                        </td>
                      </tr>
                    ) : (allDogsQ.data ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                          No dogs on file for this client yet.
                        </td>
                      </tr>
                    ) : (
                      (allDogsQ.data ?? []).map((d: any) => (
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
                      ))
                    )}
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
  dog: {
    id: string;
    name: string;
    breed: string | null;
    dna_registered: boolean;
    registry_id: string | null;
    client_name: string | null;
    street: string | null;
    unit_label?: string | null;
    review_needed?: boolean;
  };
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
      <td className="px-3 py-2 text-xs">{dog.client_name ?? "-"}</td>
      <td className="px-3 py-2 text-xs">
        {dog.unit_label ? (
          <span>Unit {dog.unit_label}</span>
        ) : dog.review_needed ? (
          <Badge variant="destructive">Needs unit</Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">{dog.street ?? "-"}</td>
      <td className="px-3 py-2">
        <label className="inline-flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={registered}
            onChange={(e) => setRegistered(e.target.checked)}
          />
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
            <div
              id="dna-notice-print"
              className="rounded border bg-card p-4 text-sm leading-relaxed whitespace-pre-wrap font-serif"
            >
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
          <Button variant="outline" onClick={() => window.print()} disabled={!notice}>
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
  const matched = n.matchedAt ? new Date(n.matchedAt).toLocaleDateString() : "-";
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
        <div className={`text-2xl font-semibold ${tone === "good" ? "text-emerald-600" : ""}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
