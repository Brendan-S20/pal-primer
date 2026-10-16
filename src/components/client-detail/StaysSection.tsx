// Client > Services > Stays (#411): a sitter's bookings for this client, and
// "Book a stay". Drawn only for a business that runs pet sitting; a pet-waste
// or walking business sees the Services tab exactly as before. Office screen,
// English.
//
// A stay's visits are ordinary visits generated from one plan per drop-in
// window (or one for the overnight arrival window); the form says how many
// before it saves. The rules live in src/lib/stays.ts and the database.

import { useMemo, useState } from "react";
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
  createStay,
  listStaysForClient,
  setStaySitter,
  type StayRow,
} from "@/lib/stays.functions";
import {
  arrivalWindowProblem,
  DEFAULT_DROP_IN_WINDOW,
  DEFAULT_OVERNIGHT_ARRIVAL,
  MAX_DROP_IN_WINDOWS,
  STAY_KIND_LABEL,
  STAY_STATUS_LABEL,
  stayDatesLabel,
  stayDatesProblem,
  stayKindFor,
  stayVisitCount,
  stayVisitPriceCents,
  stayWindowsProblem,
  visitCountSentence,
} from "@/lib/stays";
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
            <StayRowView key={s.id} stay={s} clientId={clientId} pets={pets} />
          ))}
        </ul>
      )}
      {booking && (
        <BookStayDrawer
          clientId={clientId}
          properties={properties}
          pets={pets}
          onClose={() => setBooking(false)}
        />
      )}
    </section>
  );
}

function StayRowView({ stay, clientId, pets }: { stay: StayRow; clientId: string; pets: any[] }) {
  const qc = useQueryClient();
  const today = useOrgToday();
  const { confirm, dialog } = useConfirmDialog();
  const cancelFn = useServerFn(cancelStay);
  const sitterFn = useServerFn(setStaySitter);
  const staffFn = useServerFn(listStaff);
  const [changingSitter, setChangingSitter] = useState(false);
  const staffQ = useQuery({
    queryKey: ["staff"],
    queryFn: () => staffFn(),
    enabled: changingSitter,
  });
  const invalidate = () => invalidateStay(qc, clientId);
  const cancel = useMutation({
    mutationFn: () => cancelFn({ data: { stayId: stay.id } }),
    onSuccess: () => {
      toast.success("Stay canceled. Its upcoming visits are canceled too.");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const sitter = useMutation({
    mutationFn: (sitterId: string | null) => sitterFn({ data: { stayId: stay.id, sitterId } }),
    onSuccess: () => {
      toast.success("Sitter changed. Upcoming visits moved to them.");
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
                const ok = await confirm({
                  title: "Cancel this stay?",
                  description:
                    "Its upcoming visits are canceled and its plans end. Visits already done stay on record.",
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
      {changingSitter && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <Label htmlFor={`stay-sitter-${stay.id}`} className="text-xs">
              Sitter
            </Label>
            <select
              id={`stay-sitter-${stay.id}`}
              defaultValue={stay.assigned_staff_id ?? ""}
              disabled={staffQ.isLoading || sitter.isPending}
              onChange={(e) => sitter.mutate(e.target.value || null)}
              className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm touch:h-11"
            >
              <option value="">Not assigned</option>
              {(staffQ.data?.staff ?? []).map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </li>
  );
}

// ── Book a stay ──────────────────────────────────────────────────────────

function BookStayDrawer({
  clientId,
  properties,
  pets,
  onClose,
}: {
  clientId: string;
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
                  ? "Priced per night: one overnight visit a night."
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

        <DrawerFooter>
          <Button type="submit" disabled={save.isPending || (submitted && !!problem)}>
            {save.isPending ? "Booking…" : "Book stay"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}
