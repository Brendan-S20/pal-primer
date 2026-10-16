import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { VaccineUploadForm } from "@/components/VaccineUploadForm";
import { useServiceLines } from "@/components/CommercialOnly";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { addVaccination, deleteVaccination, getDogVaccineStatus, listDogVaccinations, rejectVaccination, verifyVaccination } from "@/lib/vaccines.functions";
import { VACCINE_LABELS, VACCINE_STATUS_LABELS, type Vaccine } from "@/lib/vaccines";

export function PetVaccines({ dogId, name }: { dogId: string; name: string }) {
  const { lines } = useServiceLines();
  return lines.includes("mobile_grooming") ? <OfficePetVaccines dogId={dogId} name={name} /> : null;
}

function OfficePetVaccines({ dogId, name }: { dogId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const statusFn = useServerFn(getDogVaccineStatus);
  const list = useServerFn(listDogVaccinations);
  const add = useServerFn(addVaccination);
  const verify = useServerFn(verifyVaccination);
  const remove = useServerFn(deleteVaccination);
  const status = useQuery({ queryKey: ["pet-vaccine-status", dogId], queryFn: () => statusFn({ data: { dogId } }) });
  const records = useQuery({ queryKey: ["pet-vaccinations", dogId], queryFn: () => list({ data: { dogId } }), enabled: open, refetchInterval: open ? 240_000 : false });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pet-vaccinations", dogId] });
    qc.invalidateQueries({ queryKey: ["pet-vaccine-status", dogId] });
    qc.invalidateQueries({ queryKey: ["field-client-info"] });
  };
  const save = useMutation({ mutationFn: (data: FormData) => add({ data }), onSuccess: () => { refresh(); toast.success("Vaccine record added"); }, onError: (e: Error) => toast.error(e.message) });
  const mark = useMutation({ mutationFn: (id: string) => verify({ data: { id } }), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const del = useMutation({ mutationFn: (id: string) => remove({ data: { id } }), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const { t } = useTranslation();
  const rejectFn = useServerFn(rejectVaccination);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const rejectMut = useMutation({ mutationFn: (v: { id: string; reason: string }) => rejectFn({ data: v }), onSuccess: () => { setRejecting(null); setReason(""); refresh(); qc.invalidateQueries({ queryKey: ["vaccine-review"] }); toast.success(t("vaccineReview.rejected")); }, onError: (e: Error) => toast.error(e.message) });
  return (
    <div className="w-full min-w-0 space-y-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="min-h-11" onClick={() => setOpen(true)}>Vaccines</Button>
        {status.data && <Badge variant="outline">{VACCINE_STATUS_LABELS[status.data.overall]}</Badge>}
        {status.isError && <span role="alert" className="text-xs text-destructive">Vaccine status unavailable</span>}
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader><DialogTitle>Vaccines: {name}</DialogTitle><DialogDescription>Records and private documents for this pet.</DialogDescription></DialogHeader>
          {status.data && <ul className="space-y-1 text-sm">{status.data.vaccines.map((v) => <li key={v.vaccine}>{VACCINE_LABELS[v.vaccine as Vaccine]}: {VACCINE_STATUS_LABELS[v.state]}{v.expiresOn ? ` (${v.expiresOn})` : ""}{v.unverified ? ", Unverified" : ""}</li>)}</ul>}
          {records.isLoading && <p className="text-sm">Loading records…</p>}
          {records.error && <p role="alert" className="text-sm text-destructive">{records.error.message}</p>}
          <ul className="space-y-2">
            {(records.data ?? []).map((r) => <li key={r.id} className="space-y-2 rounded-md border p-3 text-sm">
              <p className="break-words font-medium">{VACCINE_LABELS[r.vaccine as Vaccine]}{r.vaccine_note ? `: ${r.vaccine_note}` : ""}</p>
              <p>Expires {r.expires_on}{r.given_on ? `, given ${r.given_on}` : ""}</p>
              <p className="text-xs text-muted-foreground">{r.verified_at ? "Verified" : "Unverified"}{r.source === "portal" ? ", uploaded by client" : ""}</p>
              {r.rejected_at && <p className="break-words text-xs text-destructive">{t("vaccineReview.rejectedLabel", { reason: r.rejection_reason ?? "" })}</p>}
              <div className="flex flex-wrap gap-2">
                {r.signedUrl && <Button asChild size="sm" variant="outline" className="min-h-11"><a href={r.signedUrl} target="_blank" rel="noopener noreferrer">Open document</a></Button>}
                {!r.verified_at && <Button size="sm" variant="outline" className="min-h-11" disabled={mark.isPending} onClick={() => mark.mutate(r.id)}>Mark verified</Button>}
                {r.source === "portal" && !r.verified_at && !r.rejected_at && <Button size="sm" variant="outline" className="min-h-11" disabled={rejectMut.isPending} onClick={() => { setRejecting(rejecting === r.id ? null : r.id); setReason(""); }}>{t("vaccineReview.reject")}</Button>}
                <Button size="sm" variant="ghost" className="min-h-11" disabled={del.isPending} onClick={() => { if (window.confirm("Delete this vaccine record and its document?")) del.mutate(r.id); }}>Delete</Button>
              </div>
              {rejecting === r.id && <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) rejectMut.mutate({ id: r.id, reason: reason.trim() }); }}>
                <Label htmlFor={`pet-reject-${r.id}`} className="text-xs">{t("vaccineReview.reason")}</Label>
                <Textarea id={`pet-reject-${r.id}`} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" size="sm" variant="ghost" className="min-h-11" onClick={() => setRejecting(null)}>{t("common.cancel")}</Button>
                  <Button type="submit" size="sm" className="min-h-11" disabled={rejectMut.isPending || !reason.trim()}>{t("vaccineReview.confirmReject")}</Button>
                </div>
              </form>}
            </li>)}
          </ul>
          {records.data?.length === 0 && <p className="text-sm text-muted-foreground">No vaccine records yet.</p>}
          <VaccineUploadForm dogId={dogId} busy={save.isPending} onSave={(data) => save.mutateAsync(data).then(() => {})} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
