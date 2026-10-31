// Book a single visit that is not part of a recurring plan.
//
// ── WHAT THIS IS AND IS NOT ────────────────────────────────────────────────
//
// It is a fast path onto an existing flow, not a new way to make a visit. The
// product already models "one visit" as a `one_time` service, and the service
// drawer can create one — but it asks for account type, dog counts, preferred
// weekdays, arrival windows and end dates, none of which mean anything for a
// single call-out, and then does not put the visit on the schedule until the
// nightly run. See createOneOffVisit for why that last part mattered most.
//
// So this asks the four questions a one-off actually has — who, where, when,
// how much — and derives the rest from the client and property records.
//
// "How much" is typed only by someone who sets prices (manage_pricing). A
// dispatcher books (#616) at the set price, which is shown and not editable;
// the server refuses any other price from them.

import { useEffect, useMemo, useState } from "react";
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
import { ClientSearchPicker, type PickedClient } from "@/components/ClientSearchPicker";
import { listPropertiesForClient } from "@/lib/properties.functions";
import { createOneOffVisit, listStaff, oneOffSetPrice } from "@/lib/visits.functions";
import { useOrgToday } from "@/hooks/useOrgToday";
import { usePermissions } from "@/hooks/useMyRole";

export function OneOffVisitDialog({
  open,
  onOpenChange,
  /** Pre-select a client when opened from that client's page. */
  clientId: fixedClientId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId?: string;
  onCreated?: (visitId: string) => void;
}) {
  const qc = useQueryClient();
  const listPropsFn = useServerFn(listPropertiesForClient);
  const listStaffFn = useServerFn(listStaff);
  const createFn = useServerFn(createOneOffVisit);
  const setPriceFn = useServerFn(oneOffSetPrice);
  const { can } = usePermissions();
  const setsPrices = can("manage_pricing");
  // The business's today, not the device's: the server refuses a date before
  // it (20261031120000), so the picker has to agree about what day it is.
  const today = useOrgToday();

  const [clientId, setClientId] = useState(fixedClientId ?? "");
  // Picked in the search picker, which asks the server (#617); the whole
  // roster in a <select> was empty past ~1,000 clients.
  const [pickedClient, setPickedClient] = useState<PickedClient | null>(null);
  const [propertyId, setPropertyId] = useState("");
  const [scheduledOn, setScheduledOn] = useState(today);
  const [price, setPrice] = useState("");
  const [staffId, setStaffId] = useState("");
  const [note, setNote] = useState("");

  // Reset per opening. A dialog that remembers the last client is a dialog that
  // books the wrong client the second time.
  useEffect(() => {
    if (!open) return;
    setClientId(fixedClientId ?? "");
    setPickedClient(null);
    setPropertyId("");
    setScheduledOn(today);
    setPrice("");
    setStaffId("");
    setNote("");
  }, [open, fixedClientId, today]);

  const { data: propsData } = useQuery({
    enabled: open && !!clientId,
    queryKey: ["properties-for-client", clientId],
    queryFn: () => listPropsFn({ data: { clientId } }),
  });
  const properties = useMemo(
    () => (propsData?.properties ?? []).filter((p: any) => !p.archived_at),
    [propsData],
  );

  // One property is the common case — pick it rather than making someone
  // choose from a list of one.
  //
  // `open` is in the deps on purpose. The reset effect above clears propertyId
  // every time the dialog opens, but on the SECOND open the property query is
  // already cached, so `propsData` is the same reference, the memo does not
  // re-run, and this effect would never fire again — leaving a one-property
  // client having to pick their only option by hand from the second booking on.
  useEffect(() => {
    if (open && properties.length === 1) setPropertyId(properties[0].id);
  }, [open, properties]);

  const { data: staffData } = useQuery({
    enabled: open,
    queryKey: ["staff"],
    queryFn: () => listStaffFn(),
    staleTime: 5 * 60_000,
  });
  const techs = (staffData?.staff ?? []).filter((s: any) => s.is_field_tech);

  // The set price, for someone who books but does not set prices.
  const {
    data: listPrice,
    isLoading: listPriceLoading,
    error: listPriceError,
  } = useQuery({
    enabled: open && !setsPrices && !!propertyId,
    queryKey: ["one-off-set-price", propertyId],
    queryFn: () => setPriceFn({ data: { propertyId } }),
  });

  const typedCents = Math.round(parseFloat(price || "0") * 100);
  const priceCents = setsPrices ? typedCents : (listPrice?.cents ?? null);
  const priceValid = setsPrices
    ? price.trim() !== "" && Number.isFinite(typedCents) && typedCents >= 0
    : priceCents != null;

  const createMut = useMutation({
    mutationFn: () =>
      createFn({
        data: {
          clientId,
          propertyId,
          scheduledOn,
          priceCents: priceCents ?? undefined,
          staffId: staffId || null,
          note: note.trim() || undefined,
        },
      }),
    onSuccess: (r: any) => {
      // Assignment is best-effort on the server: the visit exists either way,
      // and failing the whole booking over it used to invite a second booking
      // (and a second bill). Say what actually happened.
      if (r.assignWarning) {
        toast.warning(`Visit booked for ${r.scheduledOn}, but left unassigned: ${r.assignWarning}`);
      } else {
        toast.success(`Visit booked for ${r.scheduledOn}`);
      }
      // The board, the mobile day list and the client's own tabs all read these.
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["client-detail"] });
      onCreated?.(r.visitId);
      onOpenChange(false);
    },
    // The server refuses a blackout day, a non-work day, or a date inside a
    // hold on this client, and says which. Surfacing the message verbatim is
    // the point — a generic "couldn't book" would send someone hunting.
    onError: (e: Error) => toast.error(e.message),
  });

  const ready = !!clientId && !!propertyId && !!scheduledOn && priceValid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Book a one-off visit</DialogTitle>
          <DialogDescription>
            A single visit on one date: an emergency call-out, a make-up after a skip, or a
            one-time clean. It bills like any other visit.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!fixedClientId && (
            <div className="space-y-1">
              <Label htmlFor="oo-client" className="text-xs">Client</Label>
              <ClientSearchPicker
                id="oo-client"
                value={pickedClient}
                enabled={open}
                onChange={(c) => {
                  setPickedClient(c);
                  setClientId(c?.id ?? "");
                  setPropertyId("");
                }}
              />
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="oo-property" className="text-xs">Property</Label>
            <select
              id="oo-property"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={propertyId}
              disabled={!clientId}
              onChange={(e) => setPropertyId(e.target.value)}
            >
              <option value="">{clientId ? "Select a property…" : "Pick a client first"}</option>
              {properties.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.label ? `${p.label} — ${p.street}` : p.street}
                </option>
              ))}
            </select>
            {clientId && properties.length === 0 && (
              <p className="text-2xs text-muted-foreground">
                This client has no active property to visit.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="oo-date" className="text-xs">Date</Label>
              <Input
                id="oo-date"
                type="date"
                // A past-dated visit is created as `scheduled`, and
                // admin_transition_missed_visits flips every past-dated
                // scheduled visit to `missed` that night. Both invoicing paths
                // bill only completed or billable-skipped, so "log the make-up
                // we did yesterday" produced work that is never invoiced and
                // shows on the client's history as a service failure. Book it
                // for today and close it out instead.
                min={today}
                value={scheduledOn}
                onChange={(e) => setScheduledOn(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="oo-price" className="text-xs">Price</Label>
              {setsPrices ? (
                <Input
                  id="oo-price"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              ) : (
                <Input
                  id="oo-price"
                  readOnly
                  aria-readonly
                  className="bg-muted"
                  value={priceCents != null ? (priceCents / 100).toFixed(2) : ""}
                  placeholder={propertyId && listPriceLoading ? "Loading…" : "—"}
                />
              )}
            </div>
          </div>
          {!setsPrices && propertyId && listPriceError && (
            <p className="text-2xs text-destructive">
              The set price could not be loaded: {(listPriceError as Error).message}
            </p>
          )}
          {!setsPrices && propertyId && listPrice && (
            <p className="text-2xs text-muted-foreground">
              {listPrice.cents != null
                ? "The business's set price. Only someone who sets prices can change it."
                : listPrice.reason}
            </p>
          )}

          <div className="space-y-1">
            <Label htmlFor="oo-tech" className="text-xs">Assign to (optional)</Label>
            <select
              id="oo-tech"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
            >
              <option value="">Leave unassigned</option>
              {techs.map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                  {s.routing_available ? "" : " (off routes)"}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="oo-note" className="text-xs">Why (optional)</Label>
            <Input
              id="oo-note"
              maxLength={300}
              placeholder="Called about a party this weekend"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="text-2xs text-muted-foreground">
              Shows on the client's activity timeline.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!ready || createMut.isPending} onClick={() => createMut.mutate()}>
            {createMut.isPending ? "Booking…" : "Book the visit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
