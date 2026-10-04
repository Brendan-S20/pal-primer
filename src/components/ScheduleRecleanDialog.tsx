// Book the free re-clean a customer asked for from their portal.
//
// Not a new way to make a visit. It is createOneOffVisit — the server function
// behind "Book a one-off visit" — with every answer but the date already known:
// the client and property of the visit being complained about, $0, the tech
// who did that visit (so the person who missed the spot is the one who goes
// back, which is also who the customer expects), and a note on the client's
// timeline saying why a free visit exists. Then linkRecleanVisit ties the new
// visit to the request, so the inbox can say "Re-clean booked for …".
//
// ── THE HALF-DONE CASE ────────────────────────────────────────────────────────
//
// Those are two calls with no transaction between them. If the booking lands
// and the link does not, pressing the button again must NOT book a second
// visit — that is exactly how createOneOffVisit's own comments describe a
// double-billed call-out. So a booked-but-unlinked visit id is kept, and the
// retry only links it.

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
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
import { createOneOffVisit } from "@/lib/visits.functions";
import { linkRecleanVisit } from "@/lib/concerns.functions";
import { formatDay } from "@/lib/format";
import { defaultRecleanDay, recleanVisitNote } from "@/lib/reclean";
import { useOrgTimezone, useOrgToday } from "@/hooks/useOrgToday";

export type RecleanTicket = {
  ticketId: string;
  clientId: string;
  clientName: string;
  visit: {
    scheduled_on: string;
    property_id: string;
    assigned_staff_id: string | null;
  };
};

export function ScheduleRecleanDialog({
  ticket,
  onOpenChange,
}: {
  /** The request being scheduled; null closes the dialog. */
  ticket: RecleanTicket | null;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const tz = useOrgTimezone();
  const today = useOrgToday();
  const createFn = useServerFn(createOneOffVisit);
  const linkFn = useServerFn(linkRecleanVisit);
  const [day, setDay] = useState("");
  // ticketId -> the visit already booked for it but not yet linked.
  const [bookedUnlinked, setBookedUnlinked] = useState<Record<string, string>>({});

  // Reset per opening, on the ORG's tomorrow.
  useEffect(() => {
    if (ticket) setDay(defaultRecleanDay(tz));
  }, [ticket, tz]);

  const mut = useMutation({
    mutationFn: async (t: RecleanTicket) => {
      let visitId = bookedUnlinked[t.ticketId];
      let assignWarning: string | null = null;
      if (!visitId) {
        const r = await createFn({
          data: {
            clientId: t.clientId,
            propertyId: t.visit.property_id,
            scheduledOn: day,
            priceCents: 0,
            staffId: t.visit.assigned_staff_id,
            note: recleanVisitNote(formatDay(t.visit.scheduled_on)),
          },
        });
        visitId = r.visitId;
        assignWarning = r.assignWarning;
        setBookedUnlinked((s) => ({ ...s, [t.ticketId]: r.visitId }));
      }
      const linked = await linkFn({ data: { ticketId: t.ticketId, visitId } });
      setBookedUnlinked((s) => {
        const next = { ...s };
        delete next[t.ticketId];
        return next;
      });
      return { scheduledOn: linked.scheduledOn, assignWarning };
    },
    onSuccess: (r) => {
      if (r.assignWarning)
        toast.warning(
          `Re-clean booked for ${formatDay(r.scheduledOn)}, but left unassigned: ${r.assignWarning}`,
        );
      else toast.success(`Re-clean booked for ${formatDay(r.scheduledOn)}`);
      qc.invalidateQueries({ queryKey: ["concerns"] });
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pendingLink = ticket ? bookedUnlinked[ticket.ticketId] : undefined;
  const ready = !!ticket && (!!pendingLink || (!!day && day >= today));

  return (
    <Dialog open={!!ticket} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule re-clean</DialogTitle>
          <DialogDescription>
            A free return visit for {ticket?.clientName ?? "this client"}, at the same property as
            the visit on {ticket ? formatDay(ticket.visit.scheduled_on) : ""}, with the same tech.
            No charge.
          </DialogDescription>
        </DialogHeader>

        {pendingLink ? (
          <p className="text-sm text-muted-foreground">
            The visit is already booked. It just needs linking to the request, so this won&apos;t
            book a second one.
          </p>
        ) : (
          <div className="space-y-1">
            <Label htmlFor="reclean-date" className="text-xs">
              Date
            </Label>
            <Input
              id="reclean-date"
              type="date"
              // Not before the org's today: a past-dated visit is flipped to
              // `missed` by the nightly job (see OneOffVisitDialog).
              min={today}
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!ready || mut.isPending} onClick={() => ticket && mut.mutate(ticket)}>
            {mut.isPending ? "Booking…" : pendingLink ? "Link the re-clean" : "Book the re-clean"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
