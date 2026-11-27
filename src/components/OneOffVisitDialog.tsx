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
//
// With no set price, the dialog names where it is set (#641): Settings ->
// Client portal -> Price of an extra visit, the one field that writes
// organizations.one_off_price_cents. Business defaults and the Services
// pet-waste price look like it and are not. Someone who can change settings
// gets a link to the field.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { toastServerError, toastServerOutcome } from "@/lib/server-outcome";
import { oneOffBookedCopy } from "@/lib/one-off-booked";
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
import {
  ONE_OFF_PRICE_SETTING,
  ONE_OFF_PRICE_SETTING_HASH,
  ONE_OFF_PRICE_SETTING_PATH,
} from "@/lib/services";
import { servicePickerOptions } from "@/lib/visit-service";
import { oneOffWindowProblem } from "@/lib/one-off-booked";
import {
  ServicePicker,
  effectiveServiceId,
  useOrgServices,
} from "@/components/client-detail/ServicePicker";
import { usePickerLines } from "@/components/CommercialOnly";

const BOOK_FAILED = "The visit could not be booked. Try again.";

/** Why Book the visit is greyed, in the order the form is filled in (#1011). */
export function oneOffNotReadyReason(a: {
  clientId: string;
  propertyId: string;
  scheduledOn: string;
  needsService: boolean;
  priceValid: boolean;
  /** The set price is being looked up again; the price on screen is not yet trusted. */
  priceChecking?: boolean;
  hasWindowProblem: boolean;
}): string {
  if (!a.clientId) return "Choose a client to book the visit.";
  if (!a.propertyId) return "Choose a property to book the visit.";
  if (a.needsService) return "Choose a service to book the visit.";
  if (!a.scheduledOn) return "Choose a date to book the visit.";
  if (a.priceChecking) return "Checking the set price…";
  if (!a.priceValid) return "Enter a price to book the visit.";
  if (a.hasWindowProblem) return "Fix the arrival window to book the visit.";
  return "Fill in the missing details to book the visit.";
}

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
  const changesSettings = can("manage_settings");
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
  // Once they have typed (or cleared) the price, the set price stops filling it.
  const [priceTouched, setPriceTouched] = useState(false);
  const [staffId, setStaffId] = useState("");
  const [note, setNote] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [earliestTime, setEarliestTime] = useState("");
  const [latestTime, setLatestTime] = useState("");

  // Which service, and when in the day (F-05). It used to ask neither, so a
  // trainer's or a groomer's one-off was booked as the business's default
  // service -- the seeded "Pet waste removal", often inactive -- with no time.
  // A business that sells one pet-waste service sees no picker and books as
  // it always did; any other business picks from its own services, and the
  // seeded pet-waste one is not offered to a business that does not scoop.
  const { services: orgServices, isLoading: servicesLoading } = useOrgServices(open);
  const pickerLines = usePickerLines();
  const serviceOptions = servicePickerOptions(orgServices, null, pickerLines);
  const nonWaste = !!pickerLines && !pickerLines.includes("pet_waste");
  const asksService = serviceOptions.length > 1 || (nonWaste && serviceOptions.length > 0);
  const bookedServiceId = asksService
    ? effectiveServiceId(serviceId, orgServices, pickerLines)
    : null;
  const bookedService = orgServices.find((s) => s.id === bookedServiceId) ?? null;
  // The extra-visit price on Client portal is a pet-waste one-off's (#641);
  // any other service is priced from Settings, Services.
  const pricedAsExtraVisit = !bookedService || bookedService.service_line === "pet_waste";
  const windowProblem = oneOffWindowProblem(earliestTime, latestTime);

  // True once the reset below has run for this opening. The render that
  // follows `open` turning true still holds the LAST opening's client and
  // property, and the query cache still has their properties and price. Without
  // this, the auto-pick and the price fill below read that cache in that render
  // and put the previous client's property, and its price, on the new one.
  const [freshlyReset, setFreshlyReset] = useState(false);

  // Reset per opening. A dialog that remembers the last client is a dialog that
  // books the wrong client the second time.
  useEffect(() => {
    if (!open) {
      setFreshlyReset(false);
      return;
    }
    setClientId(fixedClientId ?? "");
    setPickedClient(null);
    setPropertyId("");
    setScheduledOn(today);
    setPrice("");
    setPriceTouched(false);
    setFilledFrom(null);
    setStaffId("");
    setNote("");
    setServiceId("");
    setEarliestTime("");
    setLatestTime("");
    setFreshlyReset(true);
  }, [open, fixedClientId, today]);

  const { data: propsData } = useQuery({
    enabled: open && !!clientId,
    queryKey: ["properties-for-client", clientId],
    queryFn: () => listPropsFn({ data: { clientId } }),
  });
  const properties = useMemo(
    () => (freshlyReset ? (propsData?.properties ?? []) : []).filter((p: any) => !p.archived_at),
    [propsData, freshlyReset],
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

  // The set price, for someone who books but does not set prices; and for
  // someone who sets prices and can change settings, only to say where the
  // missing one is set (they still type the price here).
  const {
    data: fetchedListPrice,
    isLoading: listPriceLoading,
    error: listPriceError,
    isError: listPriceIsError,
    fetchStatus: listPriceFetchStatus,
    dataUpdatedAt: listPriceUpdatedAt,
  } = useQuery({
    enabled: open && (!setsPrices || changesSettings) && !!propertyId && !servicesLoading,
    queryKey: ["one-off-set-price", propertyId, bookedServiceId],
    queryFn: () =>
      setPriceFn({
        data: { propertyId, ...(bookedServiceId ? { serviceId: bookedServiceId } : {}) },
      }),
  });

  // Nothing from the cache until this opening's reset has applied.
  const listPrice = freshlyReset ? fetchedListPrice : undefined;

  // #1011 item 1: the business's set price fills the box for someone who types
  // prices, so Book the visit is not greyed over a blank field. They can still
  // change it; the server checks the price as before.
  //
  // `open` is in the deps on purpose, like the property effect above. The reset
  // effect clears `price` on every opening, but on the SECOND open the price
  // query is cached, so `setPriceCents` and `priceTouched` are unchanged, and
  // without `open` this effect never re-ran: a blank price, "Enter a price to
  // book the visit", and Book greyed. It is declared after the reset effect, so
  // on an opening it runs after it and the set price wins over the cleared box.
  const setPriceCents = listPrice?.cents ?? null;

  // The price this box was last filled from: which property and service, and
  // which answer (dataUpdatedAt changes on every successful fetch, including one
  // that returns the same price). Until the box has been filled from the CURRENT
  // answer, an untouched price is the previous opening's or the cache's, not the
  // business's, and Book the visit stays off (#1053).
  const lookupKey = `${propertyId}|${bookedServiceId ?? ""}`;
  const [filledFrom, setFilledFrom] = useState<{ key: string; at: number } | null>(null);
  // Cached data with a fetch in flight, a paused fetch (offline) or a failed one
  // is not an answer. A retry in flight is `fetching`, so it is covered too.
  const answerIsCurrent =
    freshlyReset &&
    !!propertyId &&
    !servicesLoading &&
    listPrice !== undefined &&
    listPriceFetchStatus === "idle" &&
    !listPriceIsError;

  useEffect(() => {
    if (!open || !freshlyReset || !setsPrices || priceTouched) return;
    if (!changesSettings) {
      // No set-price lookup for this person (known gap): they type the price.
      setPrice("");
      return;
    }
    if (answerIsCurrent) {
      setPrice(setPriceCents == null ? "" : (setPriceCents / 100).toFixed(2));
      setFilledFrom((f) =>
        f && f.key === lookupKey && f.at === listPriceUpdatedAt
          ? f
          : { key: lookupKey, at: listPriceUpdatedAt },
      );
      return;
    }
    // Loading another property or service, offline, or failed: the box must not
    // keep a price that belongs to something else or to an answer we lost.
    if (filledFrom?.key !== lookupKey || listPriceIsError || listPriceFetchStatus === "paused") {
      setPrice("");
      if (filledFrom) setFilledFrom(null);
    }
    // A background refetch of the same property and service leaves the box as it
    // is; Book stays off until the answer lands and fills it again.
  }, [
    open,
    freshlyReset,
    setsPrices,
    changesSettings,
    priceTouched,
    answerIsCurrent,
    setPriceCents,
    lookupKey,
    listPriceUpdatedAt,
    listPriceIsError,
    listPriceFetchStatus,
    filledFrom,
  ]);

  // For someone who sets prices and has the lookup, an untouched price counts
  // only once the box was filled from the current answer. Typing ends the wait.
  const priceChecking =
    open &&
    setsPrices &&
    changesSettings &&
    !priceTouched &&
    !(answerIsCurrent && filledFrom?.key === lookupKey && filledFrom.at === listPriceUpdatedAt);
  const typedCents = Math.round(parseFloat(price || "0") * 100);
  const priceCents = setsPrices ? typedCents : (listPrice?.cents ?? null);
  const priceValid = setsPrices
    ? price.trim() !== "" && Number.isFinite(typedCents) && typedCents >= 0 && !priceChecking
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
          ...(bookedServiceId ? { serviceId: bookedServiceId } : {}),
          earliestTime: earliestTime || null,
          latestTime: latestTime || null,
        },
      }),
    onSuccess: (r: any) => {
      // Assignment is best-effort on the server: the visit exists either way,
      // and failing the whole booking over it used to invite a second booking
      // (and a second bill). Say what actually happened (#662): the day it
      // landed on, whose route it is on, and why not when it is on nobody's.
      const assignee = techs.find((s: { id: string }) => s.id === staffId)?.display_name ?? null;
      const copy = oneOffBookedCopy({
        requestedOn: scheduledOn,
        result: r,
        assigneeName: assignee,
      });
      if (toastServerOutcome(r, { ...copy, fallback: BOOK_FAILED }) === "error") return;
      // The board, the mobile day list and the client's own tabs all read these.
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["client-detail"] });
      onCreated?.(r.visitId);
      onOpenChange(false);
    },
    // The server refuses a blackout day, a non-work day, or a date inside a
    // hold on this client, and says which. Surfacing the message verbatim is
    // the point — a generic "couldn't book" would send someone hunting.
    onError: (e: unknown) => toastServerError(e, { fallback: BOOK_FAILED }),
  });

  const ready =
    !!clientId &&
    !!propertyId &&
    !!scheduledOn &&
    priceValid &&
    !windowProblem &&
    (!asksService || !!bookedServiceId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Book a one-off visit</DialogTitle>
          <DialogDescription>
            A single visit on one date, billed like any other visit.
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

          {asksService && (
            <ServicePicker
              id="oo-service"
              value={serviceId}
              currentId={null}
              services={orgServices}
              isLoading={servicesLoading}
              onChange={setServiceId}
              lines={pickerLines}
            />
          )}

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
                  onChange={(e) => {
                    setPriceTouched(true);
                    setPrice(e.target.value);
                  }}
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
          {setsPrices && propertyId && listPrice && listPrice.cents == null && (
            <p className="text-2xs text-muted-foreground">
              {pricedAsExtraVisit
                ? `No extra-visit price is set, so type one. To set it once for every extra visit, use ${ONE_OFF_PRICE_SETTING}.`
                : "This service has no price yet, so type one. Its price is set in Settings, Services."}
            </p>
          )}
          {changesSettings &&
            pricedAsExtraVisit &&
            propertyId &&
            listPrice &&
            listPrice.cents == null && (
              <Link
                to={ONE_OFF_PRICE_SETTING_PATH}
                hash={ONE_OFF_PRICE_SETTING_HASH}
                onClick={() => onOpenChange(false)}
                className="inline-flex min-h-9 items-center text-xs font-medium text-primary underline touch:min-h-11"
              >
                Set the extra-visit price
              </Link>
            )}

          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="oo-after" className="text-xs">
                Arrive after (optional)
              </Label>
              <Input
                id="oo-after"
                type="time"
                value={earliestTime}
                onChange={(e) => setEarliestTime(e.target.value)}
              />
            </div>
            <div className="min-w-0 space-y-1">
              <Label htmlFor="oo-by" className="text-xs">
                Arrive by (optional)
              </Label>
              <Input
                id="oo-by"
                type="time"
                value={latestTime}
                onChange={(e) => setLatestTime(e.target.value)}
              />
            </div>
          </div>
          <p className={`text-2xs ${windowProblem ? "text-destructive" : "text-muted-foreground"}`}>
            {windowProblem ??
              "The route plans the visit inside this window. Leave both empty for any time."}
          </p>

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

        {!ready && !createMut.isPending && (
          <p className="text-2xs text-muted-foreground" data-one-off-why-disabled>
            {oneOffNotReadyReason({
              clientId,
              propertyId,
              scheduledOn,
              needsService: asksService && !bookedServiceId,
              priceValid,
              priceChecking: priceChecking && listPriceFetchStatus === "fetching",
              hasWindowProblem: !!windowProblem,
            })}
          </p>
        )}

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
