import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
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

/** datetime-local wants "YYYY-MM-DDTHH:MM" in LOCAL time, with no zone. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CloseOutOpenVisits() {
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
      if (r.outcome === "completed") toast.success("Visit closed out");
      else if (r.outcome === "missed") toast.success("Marked as not completed");
      else toast.info("That visit was already resolved");
      qc.invalidateQueries({ queryKey: ["visits-awaiting-close-out"] });
      qc.invalidateQueries({ queryKey: ["my-day"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!visit) return null;

  const startedLabel = visit.started_at
    ? new Date(visit.started_at).toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "an unrecorded time";
  const where =
    visit.clients?.display_name ||
    [visit.properties?.street, visit.properties?.city].filter(Boolean).join(", ") ||
    "this visit";

  const submitCompleted = () => {
    setError(null);
    if (!finishedAt) {
      setError("Enter the time you finished.");
      return;
    }
    const asDate = new Date(finishedAt);
    if (Number.isNaN(asDate.getTime())) {
      setError("That time isn't valid.");
      return;
    }
    // The server validates this against the recorded start regardless; checking
    // here just avoids a round-trip to be told the obvious.
    if (visit.started_at && asDate.getTime() <= new Date(visit.started_at).getTime()) {
      setError("The finish time has to be after you started.");
      return;
    }
    if (asDate.getTime() > Date.now()) {
      setError("The finish time can't be in the future.");
      return;
    }
    m.mutate({ completed: true, completedAt: asDate.toISOString() });
  };

  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent className="sm:max-w-md" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Did you finish this visit?
          </DialogTitle>
          <DialogDescription>
            You started <strong className="text-foreground">{where}</strong> at {startedLabel} on{" "}
            {visit.scheduled_on} and it was never closed. We won't guess — tell us what happened.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="finished-at" className="text-xs">
              If you completed it, what time did you finish?
            </Label>
            <Input
              id="finished-at"
              type="datetime-local"
              value={finishedAt}
              onChange={(e) => setFinishedAt(e.target.value)}
              className="mt-1"
            />
            <p className="mt-1 text-2xs text-muted-foreground">
              Recorded as a time you entered afterwards, not a measured one, so it won't be reported
              as service duration.
            </p>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-col">
          <Button onClick={submitCompleted} disabled={m.isPending} className="w-full">
            {m.isPending ? "Saving…" : "Yes — I completed it"}
          </Button>
          <Button
            variant="outline"
            disabled={m.isPending}
            onClick={() => m.mutate({ completed: false })}
            className="w-full"
          >
            No — it wasn't completed
          </Button>
          <Button
            variant="ghost"
            disabled={m.isPending}
            onClick={() => setDeferred((d) => [...d, visit.id])}
            className="w-full"
          >
            I'm still working on it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
