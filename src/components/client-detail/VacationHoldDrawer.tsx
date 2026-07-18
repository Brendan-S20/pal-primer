// Shared vacation-hold drawer (QA round 8, generalized in round 3 phase 7).
//
// One hold UI, reused everywhere (I3): the client header's ••• menu opens it
// blank, and the Concerns inbox opens it PREFILLED from a portal hold request
// (C4/G4). Creating a hold removes scheduled visits in the range (DB trigger)
// and generate_visits_core skips dates inside it. Range validation is
// server-enforced (createClientHold zod + tg_client_holds_validate) so a
// 2-year range or end-before-start is rejected regardless of caller (I11).
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateField } from "@/components/fields";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { listClientHolds, createClientHold, endClientHold } from "@/lib/clients.functions";
import { formatDay } from "@/lib/format";

// Longest hold the office can place; mirrors tg_client_holds_validate.
const MAX_HOLD_DAYS = 366;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

export function VacationHoldDrawer({
  open,
  onClose,
  clientId,
  initialStartsOn,
  initialEndsOn,
  initialReason,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  initialStartsOn?: string;
  initialEndsOn?: string;
  initialReason?: string;
  onCreated?: (info: {
    holdId: string;
    startsOn: string;
    endsOn: string;
    removedVisits: number;
  }) => void;
}) {
  const qc = useQueryClient();
  const listFn = useServerFn(listClientHolds);
  const createFn = useServerFn(createClientHold);
  const endFn = useServerFn(endClientHold);
  const today = new Date().toISOString().slice(0, 10);
  const [startsOn, setStartsOn] = useState(initialStartsOn || today);
  const [endsOn, setEndsOn] = useState(initialEndsOn || "");
  const [reason, setReason] = useState(initialReason || "");

  // The drawer self-fetches holds so every caller (header, concerns inbox) gets
  // the same list without threading it through props.
  const { data: holdsData } = useQuery({
    queryKey: ["client-holds", clientId],
    queryFn: () => listFn({ data: { clientId } }),
    enabled: open,
  });
  const holds = ((holdsData as any)?.holds ?? []) as any[];

  useEffect(() => {
    if (open) {
      setStartsOn(initialStartsOn || today);
      setEndsOn(initialEndsOn || "");
      setReason(initialReason || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialStartsOn, initialEndsOn, initialReason]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["client-holds", clientId] });
    qc.invalidateQueries({ queryKey: ["client-visit-history", clientId] });
    qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
  };

  const createMut = useMutation({
    mutationFn: () =>
      createFn({ data: { clientId, startsOn, endsOn, reason: reason.trim() || undefined } }),
    onSuccess: (r: any) => {
      toast.success(
        r?.removedVisits
          ? `Hold placed. ${r.removedVisits} scheduled visit${r.removedVisits === 1 ? "" : "s"} removed.`
          : "Hold placed",
      );
      invalidate();
      onCreated?.({
        holdId: r?.id as string,
        startsOn,
        endsOn,
        removedVisits: r?.removedVisits ?? 0,
      });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const endMut = useMutation({
    mutationFn: (holdId: string) => endFn({ data: { holdId } }),
    onSuccess: () => {
      toast.success("Hold ended");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const liveHolds = holds.filter((h) => h.ends_on >= today);
  const span = startsOn && endsOn ? daysBetween(startsOn, endsOn) : 0;
  const tooLong = !!startsOn && !!endsOn && span > MAX_HOLD_DAYS;
  const valid = !!startsOn && !!endsOn && endsOn >= startsOn && !tooLong;

  return (
    <EditDrawer
      open={open}
      onClose={onClose}
      title="Vacation hold"
      description="No visits are scheduled or generated during a hold. Scheduled visits inside the range are removed when the hold is placed."
      size="sm"
      dirty={!!reason || !!endsOn}
    >
      <div className="space-y-4 text-sm">
        {liveHolds.length > 0 && (
          <ul className="space-y-2">
            {liveHolds.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2"
              >
                <div>
                  <div className="font-medium">
                    {formatDay(h.starts_on)} to {formatDay(h.ends_on)}
                  </div>
                  {h.reason && <div className="text-xs text-muted-foreground">{h.reason}</div>}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={endMut.isPending}
                  onClick={() => endMut.mutate(h.id)}
                >
                  {h.starts_on > today ? "Remove hold" : "End hold now"}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) createMut.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <DateField label="First day on hold" value={startsOn} onChange={setStartsOn} minISO={today} />
            <DateField
              label="Last day on hold"
              value={endsOn}
              onChange={setEndsOn}
              minISO={startsOn || today}
              hint="Visits resume the day after."
            />
          </div>
          <div>
            <Label htmlFor="hold-reason">Reason (optional)</Label>
            <Input
              id="hold-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Out of town, renovation…"
              maxLength={500}
            />
          </div>
          {tooLong && (
            <p className="text-xs text-destructive">
              A hold cannot be longer than a year. Shorten the range before placing it.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Ending a hold early does not recreate removed visits; use Generate schedule on the
            Services tab if a gap needs filling.
          </p>
          <DrawerFooter>
            <Button type="submit" disabled={createMut.isPending || !valid}>
              {createMut.isPending ? "Placing hold…" : "Place hold"}
            </Button>
          </DrawerFooter>
        </form>
      </div>
    </EditDrawer>
  );
}
