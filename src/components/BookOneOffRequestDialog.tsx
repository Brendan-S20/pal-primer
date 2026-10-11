// Book the extra cleanup a customer asked for from their portal.
//
// Not a new way to make a visit. It is createOneOffVisit -- the server
// function behind "Book a one-off visit" -- with the client, the address and
// the day already known from the request, and the price starting from the
// org's one-off price when the owner set one (Settings -> Client portal).
// Then linkOneOffBooking ties the visit to the request and resolves it, so the
// customer's portal says "Booked for ...".
//
// ── THE HALF-DONE CASE ──────────────────────────────────────────────────────
//
// Two calls with no transaction between them, exactly as ScheduleRecleanDialog
// describes. If the booking lands and the link does not, pressing the button
// again must NOT book a second visit, so a booked-but-unlinked visit id is
// kept and the retry only links it.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { createOneOffVisit, listStaff } from "@/lib/visits.functions";
import { linkOneOffBooking } from "@/lib/concerns.functions";
import { getPortalBookingSettings } from "@/lib/portal-booking.functions";
import { formatDay } from "@/lib/format";
import { oneOffVisitNote } from "@/lib/one-off-booking";
import { isZonePriced, servicePriceCents, type Service } from "@/lib/services";
import { useOrgToday } from "@/hooks/useOrgToday";

export type OneOffRequestTicket = {
  ticketId: string;
  clientId: string;
  clientName: string;
  propertyId: string;
  address: string | null;
  requestedOn: string;
  /** The service the client asked for (phase 5). Null is the extra cleanup:
   *  every request before the catalog, and the pet-waste service since. */
  service: Pick<
    Service,
    | "id"
    | "name"
    | "service_line"
    | "price_unit"
    | "base_price_cents"
    | "extra_pet_cents"
    | "default_duration_min"
  > | null;
};

/** The service a request names when it is not the extra cleanup. */
function requestedService(t: OneOffRequestTicket | null) {
  return t?.service && !isZonePriced(t.service) ? t.service : null;
}

export function BookOneOffRequestDialog({
  ticket,
  onOpenChange,
}: {
  /** The request being booked; null closes the dialog. */
  ticket: OneOffRequestTicket | null;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const today = useOrgToday();
  const createFn = useServerFn(createOneOffVisit);
  const linkFn = useServerFn(linkOneOffBooking);
  const settingsFn = useServerFn(getPortalBookingSettings);
  const staffFn = useServerFn(listStaff);
  const [day, setDay] = useState("");
  const [price, setPrice] = useState("");
  const [staffId, setStaffId] = useState("");
  // ticketId -> the visit already booked for it but not yet linked.
  const [bookedUnlinked, setBookedUnlinked] = useState<Record<string, string>>({});

  const settingsQ = useQuery({
    enabled: !!ticket,
    queryKey: ["portal-booking-settings"],
    queryFn: () => settingsFn(),
  });
  const staffQ = useQuery({
    enabled: !!ticket,
    queryKey: ["staff"],
    queryFn: () => staffFn(),
    staleTime: 5 * 60_000,
  });
  const techs = (staffQ.data?.staff ?? []).filter((s: any) => s.is_field_tech);

  // Reset per opening: the day they asked for (or today, if that has passed
  // while the request sat in the inbox), and the org's price if it has one.
  useEffect(() => {
    if (!ticket) return;
    setDay(ticket.requestedOn >= today ? ticket.requestedOn : today);
    setStaffId("");
  }, [ticket, today]);
  // The price starts from the service the client asked for (one pet, through
  // the one rule; the extra-pet charge is said beside it), else from the org's
  // one-off price: the extra cleanup, as before.
  const svc = requestedService(ticket);
  const svcCents = svc ? servicePriceCents(svc, { pets: 1 }) : null;
  useEffect(() => {
    if (!ticket) return;
    const cents = svc ? svcCents : settingsQ.data?.priceCents;
    setPrice(cents == null ? "" : (cents / 100).toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket, settingsQ.data]);

  const priceCents = Math.round(parseFloat(price || "0") * 100);
  const priceValid = price.trim() !== "" && Number.isFinite(priceCents) && priceCents >= 0;

  const mut = useMutation({
    mutationFn: async (t: OneOffRequestTicket) => {
      let visitId = bookedUnlinked[t.ticketId];
      let assignWarning: string | null = null;
      if (!visitId) {
        const r = await createFn({
          data: {
            clientId: t.clientId,
            propertyId: t.propertyId,
            scheduledOn: day,
            priceCents,
            ...(requestedService(t) ? { serviceId: requestedService(t)!.id } : {}),
            staffId: staffId || null,
            note: oneOffVisitNote(formatDay(t.requestedOn), false, requestedService(t)?.name),
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
          `Booked for ${formatDay(r.scheduledOn)}, but left unassigned: ${r.assignWarning}`,
        );
      else toast.success(`Booked for ${formatDay(r.scheduledOn)}`);
      qc.invalidateQueries({ queryKey: ["concerns"] });
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      onOpenChange(false);
    },
    // The server refuses a blackout day, a non-work day or a date inside a
    // hold on this client, and says which.
    onError: (e: Error) => toast.error(e.message),
  });

  const pendingLink = ticket ? bookedUnlinked[ticket.ticketId] : undefined;
  const ready = !!ticket && (!!pendingLink || (!!day && day >= today && priceValid));

  return (
    <Dialog open={!!ticket} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Book the extra visit</DialogTitle>
          <DialogDescription>
            {ticket?.clientName ?? "This client"} asked for{" "}
            {svc ? `${svc.name} on ` : ""}
            {ticket ? formatDay(ticket.requestedOn) : "a day"}
            {ticket?.address ? ` at ${ticket.address}` : ""}. It bills like any other visit.
          </DialogDescription>
        </DialogHeader>

        {pendingLink ? (
          <p className="text-sm text-muted-foreground">
            The visit is already booked. It just needs linking to the request, so this won&apos;t
            book a second one.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="one-off-date" className="text-xs">
                  Date
                </Label>
                <Input
                  id="one-off-date"
                  type="date"
                  // Not before the org's today: a past-dated visit is flipped
                  // to `missed` by the nightly job (see OneOffVisitDialog).
                  min={today}
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="one-off-price-book" className="text-xs">
                  Price
                </Label>
                <Input
                  id="one-off-price-book"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </div>
            </div>
            {svc ? (
              <p className="text-xs text-muted-foreground">
                {svcCents == null
                  ? `${svc.name} has no price yet, so this one is yours to price. Set one under Settings → Services.`
                  : `${svc.name}'s price for one pet${
                      svc.extra_pet_cents > 0
                        ? `; add $${(svc.extra_pet_cents / 100).toFixed(2)} for each extra pet at this address`
                        : ""
                    }.`}
              </p>
            ) : settingsQ.data && settingsQ.data.priceCents == null ? (
              <p className="text-xs text-muted-foreground">
                No one-off price is set, so this one is yours to price. Set one under Settings →
                Client portal to fill it in next time.
              </p>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="one-off-tech" className="text-xs">
                Assign to (optional)
              </Label>
              <select
                id="one-off-tech"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm touch:min-h-11"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
              >
                <option value="">Leave unassigned</option>
                {techs.map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!ready || mut.isPending} onClick={() => ticket && mut.mutate(ticket)}>
            {mut.isPending ? "Booking…" : pendingLink ? "Link the booking" : "Book it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
