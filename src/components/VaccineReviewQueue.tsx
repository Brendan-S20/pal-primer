// Vaccine records clients uploaded from the portal and nobody has reviewed.
// Approve marks one verified; Reject keeps it on file, never current, with a
// reason the client reads in the portal. Drawn only for a business that runs
// mobile grooming, and only when something is waiting.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Syringe } from "lucide-react";
import { useServiceLines } from "@/components/CommercialOnly";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDay } from "@/lib/format";
import { VACCINE_LABELS, type Vaccine } from "@/lib/vaccines";
import {
  listPendingVaccineUploads,
  rejectVaccination,
  verifyVaccination,
} from "@/lib/vaccines.functions";

export function VaccineReviewQueue({ canReview }: { canReview: boolean }) {
  const { lines } = useServiceLines();
  return lines.includes("mobile_grooming") ? <Queue canReview={canReview} /> : null;
}

function Queue({ canReview }: { canReview: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const listFn = useServerFn(listPendingVaccineUploads);
  const approveFn = useServerFn(verifyVaccination);
  const rejectFn = useServerFn(rejectVaccination);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const q = useQuery({ queryKey: ["vaccine-review"], queryFn: () => listFn() });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["vaccine-review"] });
    qc.invalidateQueries({ queryKey: ["pet-vaccinations"] });
    qc.invalidateQueries({ queryKey: ["pet-vaccine-status"] });
  };
  const approve = useMutation({
    mutationFn: (id: string) => approveFn({ data: { id } }),
    onSuccess: () => {
      toast.success(t("vaccineReview.approved"));
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reject = useMutation({
    mutationFn: (v: { id: string; reason: string }) => rejectFn({ data: v }),
    onSuccess: () => {
      toast.success(t("vaccineReview.rejected"));
      setRejecting(null);
      setReason("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = q.data ?? [];
  if (q.isLoading || rows.length === 0) return null;
  const busy = approve.isPending || reject.isPending;

  return (
    <section
      className="space-y-3 rounded-lg border bg-card p-4"
      aria-labelledby="vaccine-review-title"
    >
      <div className="flex min-w-0 items-start gap-2">
        <Syringe className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h2 id="vaccine-review-title" className="font-semibold">
            {t("vaccineReview.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("vaccineReview.body")}</p>
        </div>
      </div>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="space-y-2 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words font-medium">
                  {VACCINE_LABELS[r.vaccine as Vaccine] ?? r.vaccine}
                  {r.vaccineNote ? `: ${r.vaccineNote}` : ""}
                  {" · "}
                  {r.clientId ? (
                    <Link
                      to="/clients/$clientId"
                      params={{ clientId: r.clientId }}
                      className="underline underline-offset-2"
                    >
                      <bdi>{r.petName ?? ""}</bdi>
                      {r.clientName ? (
                        <>
                          {" ("}
                          <bdi>{r.clientName}</bdi>
                          {")"}
                        </>
                      ) : null}
                    </Link>
                  ) : (
                    <bdi>{r.petName ?? ""}</bdi>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("vaccineReview.expires", { date: formatDay(r.expiresOn, i18n.language) })}
                  {" · "}
                  {t("vaccineReview.uploaded", {
                    date: formatDay(r.uploadedAt.slice(0, 10), i18n.language),
                  })}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {r.signedUrl && (
                  <Button asChild size="sm" variant="outline">
                    <a href={r.signedUrl} target="_blank" rel="noopener noreferrer">
                      {t("vaccineReview.open")}
                    </a>
                  </Button>
                )}
                {canReview && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setRejecting(rejecting === r.id ? null : r.id);
                        setReason("");
                      }}
                    >
                      {t("vaccineReview.reject")}
                    </Button>
                    <Button size="sm" disabled={busy} onClick={() => approve.mutate(r.id)}>
                      {t("vaccineReview.approve")}
                    </Button>
                  </>
                )}
              </div>
            </div>
            {rejecting === r.id && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reason.trim()) reject.mutate({ id: r.id, reason: reason.trim() });
                }}
              >
                <Label htmlFor={`reject-${r.id}`} className="text-xs">
                  {t("vaccineReview.reason")}
                </Label>
                <Textarea
                  id={`reject-${r.id}`}
                  rows={2}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRejecting(null)}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button type="submit" size="sm" disabled={busy || !reason.trim()}>
                    {t("vaccineReview.confirmReject")}
                  </Button>
                </div>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
