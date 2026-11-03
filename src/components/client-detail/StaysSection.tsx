import { ConfirmStayButton } from "@/components/client-detail/ConfirmStayButton";
// Client > Services > Stays (#411): a sitter's bookings for this client, and
// "Book a stay". Drawn only for a business that runs pet sitting; a pet-waste
// or walking business sees the Services tab exactly as before. Office screen,
// English.
//
// A stay's visits are ordinary visits generated from one plan per drop-in
// window (or one for the overnight arrival window); the form says how many
// before it saves. The rules live in src/lib/stays.ts and the database.

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { BedDouble, CalendarRange, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { DateField, TimeField } from "@/components/fields";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { EmptyState, MetaChip, SectionLabel } from "@/components/client-detail/primitives";
import { useOrgServices } from "@/components/client-detail/ServicePicker";
import { useServiceLines } from "@/components/CommercialOnly";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { useOrgToday } from "@/hooks/useOrgToday";
import { listStaff } from "@/lib/visits.functions";
import {
  cancelStay,
  changeStay,
  createStay,
  listStaysForClient,
  setStaySitter,
  type StayRow,
} from "@/lib/stays.functions";
import {
  arrivalWindowProblem,
  changedVisitPriceCents,
  DEFAULT_DEPOSIT_REFUND_DAYS,
  DEFAULT_DROP_IN_WINDOW,
  depositCancelSentence,
  depositRefundable,
  earliestStayEnd,
  DEFAULT_OVERNIGHT_ARRIVAL,
  MAX_DROP_IN_WINDOWS,
  priceDifferenceSentence,
  splitStayVisits,
  STAY_KIND_LABEL,
  STAY_STATUS_LABEL,
  stayChangeDifferenceCents,
  stayContactGapsFor,
  stayContactGapsSentence,
  stayDatesLabel,
  stayDatesProblem,
  stayKindFor,
  stayVisitCount,
  stayVisitPriceCents,
  stayWindowsProblem,
  visitCountSentence,
} from "@/lib/stays";
import { sitterChangeSentence, sitterOptions } from "@/lib/stay-sitter-change";
import { runsPetSitting, speciesLabel } from "@/lib/pets";
import { centsToDollarInput, formatServiceMoney, parseDollarsToCents } from "@/lib/services";
import { windowLabel } from "@/lib/walk-windows";
import type { WalkWindow } from "@/lib/subscription-form";

export const STAYS_QUERY_KEY = (clientId: string) => ["stays", clientId] as const;

/** A booked, canceled or reassigned stay changes the client's plans and
 *  visits too (the client page's own query keys). */
function invalidateStay(qc: ReturnType<typeof useQueryClient>, clientId: string) {
  qc.invalidateQueries({ queryKey: STAYS_QUERY_KEY(clientId) });
  qc.invalidateQueries({ queryKey: ["subs", clientId] });
  qc.invalidateQueries({ queryKey: ["client-visit-history", clientId] });
}

export function StaysSection({
  clientId,
  client,
  properties,
  pets,
  canManagePricing,
}: {
  clientId: string;
  client: any;
  properties: any[];
  pets: any[];
  canManagePricing: boolean;
}) {
  const { lines, known } = useServiceLines();
  const sitting = known && runsPetSitting(lines);
  const listFn = useServerFn(listStaysForClient);
  const { data, isLoading } = useQuery({
    queryKey: STAYS_QUERY_KEY(clientId),
    queryFn: () => listFn({ data: { clientId } }),
    enabled: sitting,
  });
  const [booking, setBooking] = useState(false);
  if (!sitting) return null;

  const stays = data?.stays ?? [];
  const commercial = client?.account_type === "commercial";
  const canBook = canManagePricing && !commercial && properties.length > 0;

  return (
    <section className="space-y-3" aria-labelledby="stays-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionLabel>
          <span id="stays-heading">Stays</span>
        </SectionLabel>
        {canBook && (
          <Button size="sm" onClick={() => setBooking(true)}>
            <Plus className="h-4 w-4 shrink-0" /> Book a stay
          </Button>
        )}
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading stays…</p>
      ) : stays.length === 0 ? (
        <EmptyState
          compact
          icon={CalendarRange}
          title="No stays yet"
          description={
            commercial
              ? "Stays are booked for residential clients."
              : "Book drop-ins or overnights for the days this client is away."
          }
          {...(canBook ? { actionLabel: "Book a stay", onAction: () => setBooking(true) } : {})}
        />
      ) : (
        <ul className="space-y-2">
          {stays.map((s) => (
            <StayRowView
              key={s.id}
              stay={s}
              clientId={clientId}
              pets={pets}
              canConfirm={canManagePricing}
              depositRefundDays={data?.depositRefundDays ?? DEFAULT_DEPOSIT_REFUND_DAYS}
            />
          ))}
        </ul>
      )}
      {booking && (
        <BookStayDrawer
          clientId={clientId}
          client={client}
          properties={properties}
          pets={pets}
          onClose={() => setBooking(false)}
        />
      )}
    </section>
  );
}

function StayRowView({
  stay,
  clientId,
  pets,
  canConfirm,
  depositRefundDays,
}: {
  stay: StayRow;
  clientId: string;
  pets: any[];
  canConfirm: boolean;
  depositRefundDays: number;
}) {
  const qc = useQueryClient();
  const today = useOrgToday();
  const { confirm, dialog } = useConfirmDialog();
  const cancelFn = useServerFn(cancelStay);
  const sitterFn = useServerFn(setStaySitter);
  const staffFn = useServerFn(listStaff);
  const [changingSitter, setChangingSitter] = useState(false);
  const [changing, setChanging] = useState(false);
  const staffQ = useQuery({
    queryKey: ["staff"],
    queryFn: () => staffFn(),
    enabled: changingSitter,
  });
  // Staff who run routes, and the current sitter whatever their role, so the
  // select can show who has the stay before the list has loaded.
  const sitterChoices = sitterOptions(staffQ.data?.staff ?? [], {
    id: stay.assigned_staff_id,
    name: stay.sitter_name,
  });
  const invalidate = () => invalidateStay(qc, clientId);
  // The dialog's checkbox writes here; the dialog's description is drawn once.
  const refundAnyway = useRef(false);
  const cancel = useMutation({
    mutationFn: () =>
      cancelFn({ data: { stayId: stay.id, refundDeposit: refundAnyway.current } }),
    onSuccess: (r) => {
      toast.success(
        r.deposit === "kept"
          ? "Stay canceled. The deposit is kept as a cancellation fee on a new invoice."
          : "Stay canceled. Its upcoming visits are canceled too. Visits already done stay billed.",
      );
      invalidate();
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["client-invoices", clientId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const sitter = useMutation({
    mutationFn: (sitterId: string | null) => sitterFn({ data: { stayId: stay.id, sitterId } }),
    onSuccess: (r) => {
      toast.success("Sitter changed. Upcoming visits moved to them.");
      if (r.clash) toast.warning(r.clash);
      setChangingSitter(false);
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const names = stay.pet_ids
    .map((id) => pets.find((p) => p.id === id))
    .filter(Boolean)
    .map((p: any) => (speciesLabel(p) ? `${p.name} (${speciesLabel(p)})` : p.name));
  const windows =
    stay.kind === "overnight"
      ? [windowLabel(stay.overnight_arrival_earliest, stay.overnight_arrival_latest)]
      : (stay.drop_in_windows ?? []).map((w) => windowLabel(w.earliest, w.latest));
  const live = stay.status !== "canceled" && stay.status !== "completed" && stay.ends_on >= today;

  return (
    <li className="rounded-lg border bg-card p-3 shadow-sm">
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {stay.kind === "overnight" ? (
              <BedDouble className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <CalendarRange className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span className="font-medium">
              {stayDatesLabel(stay.kind, stay.starts_on, stay.ends_on)}
            </span>
            <MetaChip>{STAY_KIND_LABEL[stay.kind]}</MetaChip>
            <MetaChip>{STAY_STATUS_LABEL[stay.status]}</MetaChip>
          </div>
          <p className="text-xs text-muted-foreground">
            {[
              stay.service_name ? <bdi key="s">{stay.service_name}</bdi> : null,
              `${stay.visit_count} visit${stay.visit_count === 1 ? "" : "s"}`,
              windows.filter(Boolean).join(", "),
            ]
              .filter(Boolean)
              .map((part, i) => (
                <span key={i}>
                  {i > 0 ? " · " : null}
                  {part}
                </span>
              ))}
          </p>
          <p className="text-xs text-muted-foreground">
            Sitter: {stay.sitter_name ? <bdi>{stay.sitter_name}</bdi> : "Not assigned"}
            {names.length > 0 && (
              <>
                {" · "}Pets: <bdi>{names.join(", ")}</bdi>
              </>
            )}
            {stay.deposit_cents != null && <> · Deposit {formatServiceMoney(stay.deposit_cents)}</>}
          </p>
          {stay.notes && (
            <p className="break-words text-xs text-muted-foreground">
              <bdi>{stay.notes}</bdi>
            </p>
          )}
        </div>
        {live && (
          <div className="flex flex-wrap gap-1">
            {stay.status === "confirmed" && stay.invoice_id && (
              <Button size="sm" variant="outline" onClick={() => setChanging(true)}>
                Change dates or pets
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              aria-expanded={changingSitter}
              onClick={() => setChangingSitter((v) => !v)}
            >
              Change sitter
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={cancel.isPending}
              onClick={async () => {
                refundAnyway.current = false;
                const deposit = depositCancelSentence({
                  depositCents: stay.deposit_invoice_id ? stay.deposit_cents : null,
                  startsOn: stay.starts_on,
                  today,
                  refundDays: depositRefundDays,
                });
                const keeps =
                  !!deposit && !depositRefundable(stay.starts_on, today, depositRefundDays);
                const ok = await confirm({
                  title: "Cancel this stay?",
                  description: (
                    <>
                      <p>
                        Its upcoming visits are canceled and its plans end. Visits already done
                        stay on record and stay billed. Upcoming nights come off the invoice, or
                        are credited to the client's account if it is paid.
                      </p>
                      {deposit && <p>{deposit}</p>}
                      {keeps && (
                        <RefundAnywayCheckbox
                          id={`refund-${stay.id}`}
                          onChange={(v) => (refundAnyway.current = v)}
                        />
                      )}
                    </>
                  ),
                  confirmLabel: "Cancel stay",
                  destructive: true,
                });
                if (ok) cancel.mutate();
              }}
            >
              Cancel stay
            </Button>
          </div>
        )}
      </div>
      {stay.status === "requested" && canConfirm && (
        <ConfirmStayButton stayId={stay.id} clientId={clientId} />
      )}

      {changingSitter && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <Label htmlFor={`stay-sitter-${stay.id}`} className="text-xs">
              Sitter
            </Label>
            {/* Controlled, and opened on the stay's sitter (gaps-r2-06). A
                defaultValue was applied before the staff list loaded, so the
                select showed "Not assigned" over a stay that had a sitter,
                and picking a name moved the nights with no confirm. */}
            <select
              id={`stay-sitter-${stay.id}`}
              value={stay.assigned_staff_id ?? ""}
              disabled={staffQ.isLoading || sitter.isPending}
              onChange={async (e) => {
                const next = e.target.value || null;
                if (next === (stay.assigned_staff_id ?? null)) return;
                const name = next
                  ? (sitterChoices.find((s) => s.id === next)?.display_name ?? null)
                  : null;
                const ok = await confirm({
                  title: next ? "Change the sitter?" : "Take the sitter off this stay?",
                  description: sitterChangeSentence({
                    kind: stay.kind,
                    startsOn: stay.starts_on,
                    visits: stay.visits,
                    today,
                    toName: name,
                  }),
                  confirmLabel: next ? "Change sitter" : "Remove sitter",
                });
                if (ok) sitter.mutate(next);
              }}
              className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm touch:h-11"
            >
              <option value="">Not assigned</option>
              {sitterChoices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      {changing && (
        <ChangeStayDrawer
          stay={stay}
          clientId={clientId}
          pets={pets}
          onClose={() => setChanging(false)}
        />
      )}
    </li>
  );
}

// ── Change dates or pets ─────────────────────────────────────────────────

function ChangeStayDrawer({
  stay,
  clientId,
  pets,
  onClose,
}: {
  stay: StayRow;
  clientId: string;
  pets: any[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const today = useOrgToday();
  const changeFn = useServerFn(changeStay);
  const { services } = useOrgServices();
  const service = services.find((s) => s.id === stay.service_id) ?? null;
  const kind = stay.kind;
  const started = stay.starts_on < today || splitStayVisits(stay.visits, today).worked.length > 0;
  const [startsOn, setStartsOn] = useState(stay.starts_on);
  const [endsOn, setEndsOn] = useState(stay.ends_on);
  const [petIds, setPetIds] = useState<string[]>(stay.pet_ids);
  const propertyPets = pets.filter(
    (p) => p.property_id === stay.property_id && (p.active !== false || stay.pet_ids.includes(p.id)),
  );
  const minEnd = earliestStayEnd(kind, stay.visits, today);

  const datesProblem =
    stayDatesProblem(kind, startsOn, endsOn) ||
    (!started && startsOn < today ? "Choose a first day from today on." : null) ||
    (endsOn < minEnd ? "The stay already has visits up to then. Choose a later end date." : null);
  const current = stay.visit_price_cents ?? 0;
  const nextPrice = service
    ? changedVisitPriceCents(current, service, stay.pet_ids.length, petIds.length)
    : current;
  const problem =
    datesProblem ||
    (petIds.length === 0 ? "Choose at least one pet." : null) ||
    (nextPrice == null ? "Set a price for this service before changing the pets." : null);
  const difference =
    datesProblem || nextPrice == null
      ? null
      : stayChangeDifferenceCents({
          kind,
          windowCount: kind === "overnight" ? 1 : (stay.drop_in_windows ?? []).length,
          today,
          visits: stay.visits,
          currentVisitCents: current,
          newVisitCents: nextPrice,
          startsOn,
          endsOn,
        });
  const unchanged =
    startsOn === stay.starts_on &&
    endsOn === stay.ends_on &&
    petIds.length === stay.pet_ids.length &&
    petIds.every((id) => stay.pet_ids.includes(id));

  const save = useMutation({
    mutationFn: () => changeFn({ data: { stayId: stay.id, startsOn, endsOn, petIds } }),
    onSuccess: (r) => {
      toast.success(
        r.invoiceId
          ? "Stay changed. The added nights are on a new invoice."
          : "Stay changed. Its visits and invoice are updated.",
      );
      if (r.clash) toast.warning(r.clash);
      invalidateStay(qc, clientId);
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["client-invoices", clientId] });
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <EditDrawer
      open
      onClose={onClose}
      title="Change dates or pets"
      description="Visits already done stay as they are and stay billed."
      dirty={!unchanged}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem && !unchanged) save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {started ? (
            <div className="min-w-0">
              <Label>{kind === "overnight" ? "Check-in day" : "First day"}</Label>
              <p className="mt-2 text-sm">{stayDatesLabel("drop_in", stay.starts_on, stay.starts_on)}</p>
              <p className="mt-1 text-xs text-muted-foreground">The stay has started.</p>
            </div>
          ) : (
            <DateField
              label={kind === "overnight" ? "Check-in day" : "First day"}
              value={startsOn}
              onChange={setStartsOn}
              minISO={today}
            />
          )}
          <DateField
            label={kind === "overnight" ? "Check-out day" : "Last day"}
            value={endsOn}
            onChange={setEndsOn}
            minISO={minEnd > startsOn ? minEnd : startsOn}
            hint={kind === "overnight" ? "The morning the sitter leaves." : undefined}
          />
        </div>
        {datesProblem && <p className="text-xs text-destructive">{datesProblem}</p>}

        <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm font-medium">Pets on the stay</legend>
          <ul className="grid gap-1 sm:grid-cols-2">
            {propertyPets.map((p) => {
              const checked = petIds.includes(p.id);
              return (
                <li key={p.id} className="min-w-0">
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) =>
                        setPetIds(v ? [...petIds, p.id] : petIds.filter((id) => id !== p.id))
                      }
                    />
                    <span className="min-w-0 truncate">
                      <bdi>{p.name}</bdi>
                      {speciesLabel(p) ? ` (${speciesLabel(p)})` : ""}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>

        <div className="rounded-md border bg-muted/30 p-3 text-sm" aria-live="polite">
          {unchanged ? (
            <p className="text-muted-foreground">Change the dates or pets to see the price difference.</p>
          ) : difference == null ? (
            <p className="text-muted-foreground">Fix the dates to see the price difference.</p>
          ) : (
            <>
              <p className="font-medium">{priceDifferenceSentence(difference, formatServiceMoney)}</p>
              {nextPrice != null && nextPrice !== current && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {kind === "overnight" ? "Each night to come" : "Each visit to come"}:{" "}
                  {formatServiceMoney(current)} to {formatServiceMoney(nextPrice)}.
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                An unpaid stay invoice is updated. If it is paid, added nights go on a new invoice and
                removed ones are credited to the client's account. Holiday rates apply on save.
              </p>
            </>
          )}
        </div>
        {problem && !datesProblem && <p className="text-xs text-destructive">{problem}</p>}

        <DrawerFooter>
          <Button type="submit" disabled={save.isPending || !!problem || unchanged}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}

// ── Book a stay ──────────────────────────────────────────────────────────

function BookStayDrawer({
  clientId,
  client,
  properties,
  pets,
  onClose,
}: {
  clientId: string;
  client: any;
  properties: any[];
  pets: any[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const today = useOrgToday();
  const createFn = useServerFn(createStay);
  const staffFn = useServerFn(listStaff);
  const { services, isLoading: servicesLoading } = useOrgServices();
  const sittingServices = useMemo(
    () => services.filter((s) => s.active && s.service_line === "pet_sitting"),
    [services],
  );
  const staffQ = useQuery({ queryKey: ["staff"], queryFn: () => staffFn() });

  const [propertyId, setPropertyId] = useState<string>(properties[0]?.id ?? "");
  const [serviceId, setServiceId] = useState<string>("");
  const service = sittingServices.find((s) => s.id === serviceId) ?? sittingServices[0] ?? null;
  const kind = stayKindFor(service?.price_unit);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [windows, setWindows] = useState<WalkWindow[]>([DEFAULT_DROP_IN_WINDOW]);
  const [arrival, setArrival] = useState<WalkWindow>(DEFAULT_OVERNIGHT_ARRIVAL);
  const propertyPets = pets.filter((p) => p.property_id === propertyId && p.active !== false);
  // Default: every active pet at the property. null = not touched yet.
  const [chosenPets, setChosenPets] = useState<string[] | null>(null);
  const petIds = chosenPets ?? propertyPets.map((p) => p.id as string);
  const [sitterId, setSitterId] = useState("");
  const [notes, setNotes] = useState("");
  const [deposit, setDeposit] = useState("");
  const [price, setPrice] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const servicePrice = service ? stayVisitPriceCents(service, petIds.length) : null;
  const priceText = price ?? (servicePrice != null ? centsToDollarInput(servicePrice) : "");
  const priceCents = priceText.trim() ? parseDollarsToCents(priceText) : null;
  const depositCents = deposit.trim() ? parseDollarsToCents(deposit) : null;

  const datesProblem = stayDatesProblem(kind, startsOn, endsOn);
  const windowsProblem =
    kind === "overnight" ? arrivalWindowProblem(arrival) : stayWindowsProblem(windows);
  const problem = !service
    ? "Add a pet sitting service in Settings > Services first."
    : !propertyId
      ? "Choose a property."
      : datesProblem ||
        windowsProblem ||
        (petIds.length === 0 ? "Choose at least one pet." : null) ||
        (priceCents == null || Number.isNaN(priceCents) ? "Set a price per visit." : null) ||
        (depositCents != null && Number.isNaN(depositCents)
          ? "The deposit is not an amount."
          : null);
  const count = datesProblem ? 0 : stayVisitCount(kind, startsOn, endsOn, windows.length);
  const missing = stayContactGapsSentence(
    stayContactGapsFor(
      client,
      propertyPets.filter((p) => petIds.includes(p.id)),
    ),
  );

  const save = useMutation({
    mutationFn: () =>
      createFn({
        data: {
          clientId,
          propertyId,
          serviceId: service!.id,
          startsOn,
          endsOn,
          windows: kind === "drop_in" ? windows : [],
          arrival: kind === "overnight" ? arrival : null,
          petIds,
          sitterId: sitterId || null,
          notes: notes.trim() || null,
          depositCents,
          priceCents,
        },
      }),
    onSuccess: (r) => {
      toast.success(`Stay booked. ${r.visits} visit${r.visits === 1 ? "" : "s"} on the schedule.`);
      const missing = stayContactGapsSentence(r.gaps);
      if (missing) toast.warning(missing);
      if (r.clash) toast.warning(r.clash);
      invalidateStay(qc, clientId);
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const dirty = !!(startsOn || endsOn || notes || deposit || sitterId);

  return (
    <EditDrawer
      open
      onClose={onClose}
      title="Book a stay"
      description="Drop-ins or overnights while the client is away."
      dirty={dirty}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
          if (!problem) save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <Label htmlFor="stay-service">Sitting service</Label>
            <select
              id="stay-service"
              value={service?.id ?? ""}
              disabled={servicesLoading || sittingServices.length === 0}
              onChange={(e) => {
                setServiceId(e.target.value);
                setPrice(null);
              }}
              className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm touch:h-11"
            >
              {sittingServices.length === 0 && <option value="">No sitting services yet</option>}
              {sittingServices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {service && (
              <p className="mt-1 text-xs text-muted-foreground">
                {kind === "overnight"
                  ? "Priced per night: one visit a night, from check-in until the morning the sitter leaves."
                  : "Drop-ins: one visit per time, every day of the stay."}
              </p>
            )}
          </div>
          {properties.length > 1 && (
            <div className="min-w-0">
              <Label htmlFor="stay-property">Property</Label>
              <select
                id="stay-property"
                value={propertyId}
                onChange={(e) => {
                  setPropertyId(e.target.value);
                  setChosenPets(null);
                }}
                className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm touch:h-11"
              >
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.street}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <DateField
            label={kind === "overnight" ? "Check-in day" : "First day"}
            value={startsOn}
            onChange={setStartsOn}
            minISO={today}
          />
          <DateField
            label={kind === "overnight" ? "Check-out day" : "Last day"}
            value={endsOn}
            onChange={setEndsOn}
            minISO={startsOn || today}
            hint={kind === "overnight" ? "The morning the sitter leaves." : undefined}
          />
        </div>
        {submitted && datesProblem && (startsOn || endsOn) && (
          <p className="text-xs text-destructive">{datesProblem}</p>
        )}

        {kind === "overnight" ? (
          <fieldset className="min-w-0 space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">Evening arrival</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <TimeField
                label="Earliest arrival"
                value={arrival.earliestTime}
                clearable={false}
                onChange={(v) => setArrival((a) => ({ ...a, earliestTime: v }))}
              />
              <TimeField
                label="Latest arrival"
                value={arrival.latestTime}
                clearable={false}
                onChange={(v) => setArrival((a) => ({ ...a, latestTime: v }))}
              />
            </div>
          </fieldset>
        ) : (
          <div className="space-y-3">
            {windows.map((w, index) => (
              <fieldset key={index} className="min-w-0 space-y-2 rounded-md border p-3">
                <legend className="px-1 text-sm font-medium">Drop-in {index + 1}</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TimeField
                    label="Earliest arrival"
                    value={w.earliestTime}
                    clearable={false}
                    onChange={(v) =>
                      setWindows((rows) =>
                        rows.map((row, i) => (i === index ? { ...row, earliestTime: v } : row)),
                      )
                    }
                  />
                  <TimeField
                    label="Latest arrival"
                    value={w.latestTime}
                    clearable={false}
                    onChange={(v) =>
                      setWindows((rows) =>
                        rows.map((row, i) => (i === index ? { ...row, latestTime: v } : row)),
                      )
                    }
                  />
                </div>
                {windows.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11"
                    aria-label={`Remove drop-in ${index + 1}`}
                    onClick={() => setWindows((rows) => rows.filter((_, i) => i !== index))}
                  >
                    Remove drop-in
                  </Button>
                )}
              </fieldset>
            ))}
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={windows.length >= MAX_DROP_IN_WINDOWS}
              onClick={() => setWindows((rows) => [...rows, { earliestTime: "", latestTime: "" }])}
            >
              <Plus className="h-4 w-4 shrink-0" /> Add another drop-in
            </Button>
          </div>
        )}
        {submitted && windowsProblem && (
          <p className="text-xs text-destructive">{windowsProblem}</p>
        )}

        <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm font-medium">Pets on the stay</legend>
          {propertyPets.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No pets at this property. Add them on the Properties tab.
            </p>
          ) : (
            <ul className="grid gap-1 sm:grid-cols-2">
              {propertyPets.map((p) => {
                const checked = petIds.includes(p.id);
                return (
                  <li key={p.id} className="min-w-0">
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) =>
                          setChosenPets(v ? [...petIds, p.id] : petIds.filter((id) => id !== p.id))
                        }
                      />
                      <span className="min-w-0 truncate">
                        <bdi>{p.name}</bdi>
                        {speciesLabel(p) ? ` (${speciesLabel(p)})` : ""}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <Label htmlFor="stay-sitter">Sitter</Label>
            <select
              id="stay-sitter"
              value={sitterId}
              onChange={(e) => setSitterId(e.target.value)}
              className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm touch:h-11"
            >
              <option value="">Assign later</option>
              {(staffQ.data?.staff ?? []).map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <Label htmlFor="stay-price">
              {kind === "overnight" ? "Price per night" : "Price per visit"}
            </Label>
            <Input
              id="stay-price"
              inputMode="decimal"
              value={priceText}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="min-w-0">
            <Label htmlFor="stay-deposit">Deposit (optional)</Label>
            <Input
              id="stay-deposit"
              inputMode="decimal"
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
              placeholder="0.00"
            />
          </div>
        </div>

        <div>
          <Label htmlFor="stay-notes">Notes</Label>
          <Textarea
            id="stay-notes"
            value={notes}
            maxLength={1000}
            rows={3}
            placeholder="Anything the sitter should know about this trip."
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <p className="text-sm font-medium" aria-live="polite">
          {count > 0
            ? visitCountSentence(count)
            : "Choose the dates to see how many visits this creates."}
        </p>
        {submitted && problem && !datesProblem && !windowsProblem && (
          <p className="text-xs text-destructive">{problem}</p>
        )}
        {missing && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
            {missing} You can book now and add them on the client and pet forms.
          </p>
        )}

        <DrawerFooter>
          <Button type="submit" disabled={save.isPending || (submitted && !!problem)}>
            {save.isPending ? "Booking…" : "Book stay"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}

/** "Refund the deposit anyway", inside the cancel dialog. It keeps its own
 *  state because the dialog draws its description once. */
function RefundAnywayCheckbox({ id, onChange }: { id: string; onChange: (v: boolean) => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm text-foreground"
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => {
          setChecked(v === true);
          onChange(v === true);
        }}
      />
      <span className="min-w-0">Refund the deposit anyway</span>
    </label>
  );
}
