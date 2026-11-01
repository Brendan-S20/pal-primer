import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useIntlLocale } from "@/lib/i18n";
import { orgLocalDayTime } from "@/lib/org-day";
import { formatDay } from "@/lib/format";
import { useOrgTimezone } from "@/hooks/useOrgToday";
import { deferredAfterOpenChange } from "@/lib/close-out-defer";
import {
  listVisitsAwaitingCloseOut,
  confirmOpenVisit,
  type OpenVisitRow,
} from "@/lib/my-day.functions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// BUILD-11: close out a visit the tech started and never finished.
//
// The system does NOT decide the outcome. It noticed an open job and asks;
// everything recorded here is the tech's own answer. That distinction is the
// whole point — auto-completing with now() is exactly how the BUG-9 records
// (start == completion, one of them stamped a fortnight late) were created.
//
// "Still working" is a real answer, not a nag-dismissal: it changes nothing and
// the prompt returns next time, which is correct for a genuinely open job.
//
// The dialog's X and Escape give the same answer (#638). They used to be wired
// to a no-op, so the overlay sat over My Day with no way past it: the tech
// could not read the day or reach the account menu to sign out. Closing now
// defers the visit for this session exactly like "Still working". It records
// nothing on the visit; it only stops asking until the next load.

/** datetime-local wants "YYYY-MM-DDTHH:MM" in LOCAL time, with no zone. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CloseOutOpenVisits() {
  const tz = useOrgTimezone();
  const { t } = useTranslation();
  const locale = useIntlLocale();
  const qc = useQueryClient();
  const listFn = useServerFn(listVisitsAwaitingCloseOut);
  const confirmFn = useServerFn(confirmOpenVisit);

  const { data } = useQuery({
    queryKey: ["visits-awaiting-close-out"],
    queryFn: () => listFn(),
    staleTime: 5 * 60_000,
  });

  // Dismissed for this session only — deliberately not persisted. An open visit
  // is unresolved work; it should come back.
  const [deferred, setDeferred] = useState<string[]>([]);
  const pending = useMemo(
    () => (data?.visits ?? []).filter((v: OpenVisitRow) => !deferred.includes(v.id)),
    [data?.visits, deferred],
  );
  const visit = pending[0];

  const [finishedAt, setFinishedAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Default the finish time to now — the only moment we can actually vouch for
  // — while leaving it editable, because the tech is the one who knows. Reset
  // per visit so answering one never pre-fills the next.
  useEffect(() => {
    if (!visit) return;
    setFinishedAt(toLocalInputValue(new Date()));
    setError(null);
  }, [visit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = useMutation({
    mutationFn: (args: { completed: boolean; completedAt?: string }) =>
      confirmFn({
        data: {
          visitId: visit!.id,
          completed: args.completed,
          completedAt: args.completedAt,
        },
      }),
    onSuccess: (r) => {
      if (r.outcome === "completed") toast.success(t("closeOut.closedOut"));
      else if (r.outcome === "missed") toast.success(t("closeOut.markedNotCompleted"));
      else toast.info(t("closeOut.alreadyResolved"));
      qc.invalidateQueries({ queryKey: ["visits-awaiting-close-out"] });
      qc.invalidateQueries({ queryKey: ["my-day"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!visit) return null;

  const startedLabel = visit.started_at
    ? orgLocalDayTime(visit.started_at, tz, locale)
    : t("closeOut.unrecordedTime");
  const where =
    visit.clients?.display_name ||
    [visit.properties?.street, visit.properties?.city].filter(Boolean).join(", ") ||
    t("closeOut.thisVisit");

  const submitCompleted = () => {
    setError(null);
    if (!finishedAt) {
      setError(t("closeOut.enterTime"));
      return;
    }
    const asDate = new Date(finishedAt);
    if (Number.isNaN(asDate.getTime())) {
      setError(t("closeOut.invalidTime"));
      return;
    }
    // The server validates this against the recorded start regardless; checking
    // here just avoids a round-trip to be told the obvious.
    if (visit.started_at && asDate.getTime() <= new Date(visit.started_at).getTime()) {
      setError(t("closeOut.afterStart"));
      return;
    }
    if (asDate.getTime() > Date.now()) {
      setError(t("closeOut.notInFuture"));
      return;
    }
    m.mutate({ completed: true, completedAt: asDate.toISOString() });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) =>
        setDeferred((d) => deferredAfterOpenChange(open, m.isPending, visit.id, d))
      }
    >
      <DialogContent className="sm:max-w-md" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
            {t("closeOut.title")}
          </DialogTitle>
          <DialogDescription>
            {/* formatDay, not the raw column: this sentence already speaks the
                org's clock ("Sat 5:59 PM"), and the one ISO date beside it
                ("2026-09-26") was the walk-mode screenshot's sore thumb. */}
            {/* `<where/>` is self-closing in the string and the name goes in
                as the element's own child, never through interpolation: it is
                a client's name somebody typed, and Trans parses its string
                for tags. */}
            <Trans
              i18nKey="closeOut.description"
              values={{ time: startedLabel, day: formatDay(visit.scheduled_on, locale) }}
              components={{ where: <strong className="text-foreground">{where}</strong> }}
            />
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="finished-at" className="text-xs">
              {t("closeOut.finishedLabel")}
            </Label>
            <Input
              id="finished-at"
              type="datetime-local"
              value={finishedAt}
              onChange={(e) => setFinishedAt(e.target.value)}
              className="mt-1"
            />
            <p className="mt-1 text-2xs text-muted-foreground">{t("closeOut.enteredNote")}</p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button onClick={submitCompleted} disabled={m.isPending} className="w-full">
            {m.isPending ? t("common.saving") : t("closeOut.yesCompleted")}
          </Button>
          <Button
            variant="outline"
            disabled={m.isPending}
            onClick={() => m.mutate({ completed: false })}
            className="w-full"
          >
            {t("closeOut.notCompleted")}
          </Button>
          <Button
            variant="ghost"
            disabled={m.isPending}
            onClick={() => setDeferred((d) => deferredAfterOpenChange(false, false, visit.id, d))}
            className="w-full"
          >
            {t("closeOut.stillWorking")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
