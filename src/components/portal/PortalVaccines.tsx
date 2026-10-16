import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { VaccineUploadForm } from "@/components/VaccineUploadForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { portalConfirmVaccineUpload, portalListVaccines, portalReadVaccineRecord, portalRequestVaccineUpload } from "@/lib/portal-vaccines.functions";
import { VACCINE_LABELS, VACCINE_STATUS_LABELS, type Vaccine } from "@/lib/vaccines";
import { vaccineFields, vaccineFileSize, vaccineMime } from "@/lib/vaccines.schema";

export function PortalVaccines({ token }: { token: string }) {
  const qc = useQueryClient();
  const list = useServerFn(portalListVaccines);
  const request = useServerFn(portalRequestVaccineUpload);
  const confirm = useServerFn(portalConfirmVaccineUpload);
  const read = useServerFn(portalReadVaccineRecord);
  const q = useQuery({ queryKey: ["portal-vaccines", token], queryFn: () => list({ data: { token } }) });
  const upload = useMutation({ mutationFn: async (form: FormData) => {
    const fields = vaccineFields.parse({ dogId: form.get("dogId"), vaccine: form.get("vaccine"), vaccineNote: form.get("vaccineNote") || null, givenOn: form.get("givenOn") || null, expiresOn: form.get("expiresOn") });
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Choose a photo or PDF.");
    const mime = vaccineMime.parse(file.type);
    const size = vaccineFileSize.parse(file.size);
    const signed = await request({ data: { token, dogId: fields.dogId, mime, size } });
    const body = new FormData();
    body.append("cacheControl", "300");
    body.append("", file);
    const response = await fetch(signed.signedUrl, { method: "PUT", body });
    if (!response.ok) throw new Error("The file upload failed. Please try again.");
    await confirm({ data: { token, path: signed.path, fileName: file.name.slice(0, 200), fields } });
  }, onSuccess: () => { qc.invalidateQueries({ queryKey: ["portal-vaccines", token] }); toast.success("Vaccine record uploaded"); }, onError: (e: Error) => toast.error(e.message) });
  const open = useMutation({ mutationFn: (id: string) => read({ data: { token, id } }), onSuccess: (r) => { window.location.assign(r.signedUrl); }, onError: (e: Error) => toast.error(e.message) });
  if (q.data && !q.data.enabled) return null;
  return <section className="space-y-4 rounded-lg border bg-card p-4">
    <h2 className="text-lg font-semibold">Vaccines</h2>
    {q.isLoading && <p className="text-sm">Loading vaccine records…</p>}
    {q.error && <p role="alert" className="text-sm text-destructive">{q.error.message}</p>}
    {q.data?.pets.length === 0 && <p className="text-sm text-muted-foreground">No active pets on file. Contact the office to add a pet.</p>}
    {q.data?.pets.map((pet) => <div key={pet.id} className="min-w-0 space-y-3 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2"><h3 className="break-words font-medium">{pet.name}</h3><Badge variant="outline">{VACCINE_STATUS_LABELS[pet.status.overall]}</Badge></div>
      <ul className="space-y-1 text-sm">{pet.status.vaccines.map((v) => <li key={v.vaccine}>{VACCINE_LABELS[v.vaccine as Vaccine]}: {VACCINE_STATUS_LABELS[v.state]}{v.unverified ? ", awaiting office review" : ""}</li>)}</ul>
      <ul className="space-y-2">{pet.records.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
        <div className="min-w-0"><p className="break-words">{VACCINE_LABELS[r.vaccine as Vaccine]}{r.vaccine_note ? `: ${r.vaccine_note}` : ""}</p><p className="text-xs text-muted-foreground">Expires {r.expires_on}{r.verified_at ? ", verified" : ", unverified"}</p></div>
        {r.file_name && <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={open.isPending} onClick={() => open.mutate(r.id)}>Open document</Button>}
      </li>)}</ul>
      {pet.records.filter((r) => r.source === "portal").length < 20 ? <VaccineUploadForm dogId={pet.id} busy={upload.isPending} requireFile onSave={(data) => upload.mutateAsync(data)} /> : <p className="text-sm text-muted-foreground">Upload limit reached. Contact the office to update these records.</p>}
    </div>)}
  </section>;
}
