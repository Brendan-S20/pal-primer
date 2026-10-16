// Book a groom from the client's page.
//
// The office picks the pets, the service, the add-ons and the day. The price
// and the length are groomQuote's, the same numbers the visit stores and the
// invoice later reads. A customer never sees this dialog.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useTranslation } from "react-i18next";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { bookGroom, groomBookingOptions, groomDayBookings } from "@/lib/groom-booking.functions";
import {
  COAT_LABEL,
  groomClashes,
  groomHoldMinutes,
  groomQuote,
  groomRepeatDates,
  GROOM_SLOT_STEP_MIN,
  openGroomStarts,
  PET_SIZE_LABEL,
  type CoatType,
  type GroomAddon,
  type GroomPet,
  type GroomRule,
  type PetSize,
} from "@/lib/groom";
import {
  groomVaccineCheck,
  VACCINE_STATUS_LABELS,
  type VaccineRule,
  type VaccineState,
} from "@/lib/vaccines";

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

type Options = Awaited<ReturnType<typeof groomBookingOptions>>;

export function BookGroomDialog({
  open,
  onOpenChange,
  clientId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: string;
  onCreated?: (visitId: string) => void;
}) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const optionsFn = useServerFn(groomBookingOptions);
  const bookFn = useServerFn(bookGroom);
  const dayFn = useServerFn(groomDayBookings);

  const [propertyId, setPropertyId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [petIds, setPetIds] = useState<string[]>([]);
  const [addonQty, setAddonQty] = useState<Record<string, string>>({});
  const [scheduledOn, setScheduledOn] = useState(todayISO());
  const [startTime, setStartTime] = useState("");
  const [everyWeeks, setEveryWeeks] = useState<"" | "4" | "6" | "8">("");
  const [staffId, setStaffId] = useState("");
  const [parkingNotes, setParkingNotes] = useState("");
  const [acknowledgeWarning, setAcknowledgeWarning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPropertyId("");
    setServiceId("");
    setPetIds([]);
    setAddonQty({});
    setScheduledOn(todayISO());
    setStartTime("");
    setEveryWeeks("");
    setStaffId("");
    setParkingNotes("");
    setAcknowledgeWarning(false);
  }, [open, clientId]);

  const { data, isLoading, error } = useQuery({
    enabled: open,
    queryKey: ["groom-booking-options", clientId],
    queryFn: () => optionsFn({ data: { clientId } }),
  });
  const options = data as Options | undefined;

  useEffect(() => {
    if (!open || !options) return;
    if (!propertyId && options.properties.length === 1) {
      setPropertyId(options.properties[0].id);
      setParkingNotes(options.properties[0].parking_notes ?? "");
    }
    if (!serviceId && options.services.length === 1) setServiceId(options.services[0].id);
  }, [open, options, propertyId, serviceId]);

  const petsHere = useMemo(
    () => (options?.pets ?? []).filter((p) => p.property_id === propertyId),
    [options, propertyId],
  );
  const service = options?.services.find((s) => s.id === serviceId) ?? null;
  const rules = useMemo(
    () => (options?.rules ?? []).filter((r) => r.service_id === serviceId),
    [options, serviceId],
  );

  const selectedPets: GroomPet[] = petsHere
    .filter((p) => petIds.includes(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      size: p.size as PetSize | null,
      coat_type: p.coat_type as CoatType | null,
    }));

  const addons: GroomAddon[] = (options?.addons ?? [])
    .map((a) => ({
      id: a.id,
      name: a.name,
      unit_price_cents: a.unit_price_cents,
      duration_min: a.duration_min ?? 0,
      quantity: Math.max(0, parseInt(addonQty[a.id] || "0", 10) || 0),
    }))
    .filter((a) => a.quantity > 0);

  const quote =
    service && selectedPets.length > 0
      ? groomQuote({
          service: {
            price_unit: service.price_unit as "visit" | "hour" | "night",
            base_price_cents: service.base_price_cents,
            extra_pet_cents: service.extra_pet_cents,
            default_duration_min: service.default_duration_min,
          },
          rules: rules as GroomRule[],
          pets: selectedPets,
          addons,
        })
      : null;

  const holdMinutes = quote ? groomHoldMinutes(quote.minutes, options?.bufferMin) : 0;
  const bufferMin = holdMinutes - (quote?.minutes ?? 0);

  const dayQuery = useQuery({
    enabled: open && /^\d{4}-\d{2}-\d{2}$/.test(scheduledOn),
    queryKey: ["groom-day-bookings", scheduledOn, staffId || null],
    queryFn: () => dayFn({ data: { date: scheduledOn, staffId: staffId || null } }),
  });
  const booked = dayQuery.data ?? [];
  const openStarts = holdMinutes > 0 ? openGroomStarts(holdMinutes, booked) : [];
  const clashes = startTime && holdMinutes > 0 ? groomClashes(startTime, holdMinutes, booked) : [];

  // The same check the server makes: every date the plan lands on in a year,
  // each on its own date. Only the first groom can block.
  const vaccineRule = (options?.vaccineRule ?? "off") as VaccineRule;
  const planDates = groomRepeatDates(
    scheduledOn,
    everyWeeks === "" ? null : Number(everyWeeks),
    365,
  );
  const checks = petsHere
    .filter((p) => petIds.includes(p.id))
    .map((p) =>
      groomVaccineCheck(p.vaccineRecords, options?.requiredVaccines ?? [], vaccineRule, planDates),
    );
  const blocked = checks.some((c) => c.decision === "block");
  const warnOn = blocked
    ? null
    : (checks
        .filter((c) => c.decision === "warn" && c.firstFlaggedOn)
        .map((c) => c.firstFlaggedOn as string)
        .sort()[0] ?? null);
  const warned = warnOn != null;

  const bookMut = useMutation({
    mutationFn: () =>
      bookFn({
        data: {
          clientId,
          propertyId,
          serviceId,
          petIds,
          addons: addons.map((a) => ({ addonServiceId: a.id, quantity: a.quantity })),
          scheduledOn,
          startTime,
          everyWeeks: everyWeeks === "" ? null : Number(everyWeeks),
          staffId: staffId || null,
          parkingNotes,
          acknowledgeWarning,
        },
      }),
    onSuccess: (r) => {
      const price = money(r.cents);
      const repeat = r.visitCount > 1 ? ` ${r.visitCount} visits were put on the schedule.` : "";
      if (r.assignWarning) {
        toast.warning(
          `Groom booked for ${r.scheduledOn} at ${r.startTime} (${r.minutes} min, ${price}).${repeat} ${r.assignWarning}`,
        );
      } else {
        toast.success(
          `Groom booked for ${r.scheduledOn} at ${r.startTime} (${r.minutes} min, ${price}).${repeat}`,
        );
      }
      qc.invalidateQueries({ queryKey: ["groom-day-bookings"] });
      qc.invalidateQueries({ queryKey: ["client-visit-history", clientId] });
      qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
      qc.invalidateQueries({ queryKey: ["subs", clientId] });
      qc.invalidateQueries({ queryKey: ["properties", clientId] });
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["my-day"] });
      onCreated?.(r.visitId);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const ready =
    !!propertyId &&
    !!serviceId &&
    petIds.length > 0 &&
    !!scheduledOn &&
    !!startTime &&
    clashes.length === 0 &&
    quote != null &&
    quote.cents != null &&
    quote.minutes >= 1 &&
    !blocked &&
    (!warned || acknowledgeWarning);

  const togglePet = (id: string, on: boolean) => {
    setAcknowledgeWarning(false);
    setPetIds((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Book a groom</DialogTitle>
          <DialogDescription>
            Pick the pets, the service and the day. The price and the length follow the size rules,
            and the invoice uses those numbers.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

        {options && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="groom-property" className="text-xs">
                Property
              </Label>
              <select
                id="groom-property"
                className="h-11 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
                value={propertyId}
                onChange={(e) => {
                  const id = e.target.value;
                  setPropertyId(id);
                  const property = options.properties.find((p) => p.id === id);
                  setParkingNotes(property?.parking_notes ?? "");
                  setPetIds([]);
                  setAcknowledgeWarning(false);
                }}
              >
                <option value="">Select a property…</option>
                {options.properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {[p.street, p.city].filter(Boolean).join(", ")}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="groom-service" className="text-xs">
                Service
              </Label>
              <select
                id="groom-service"
                className="h-11 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
              >
                <option value="">
                  {options.services.length === 0
                    ? "Add a grooming service in Settings first"
                    : "Select a service…"}
                </option>
                {options.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <fieldset className="space-y-1">
              <legend className="text-xs font-medium">Pets</legend>
              {propertyId && petsHere.length === 0 && (
                <p className="text-sm text-muted-foreground">Add a pet at this address first.</p>
              )}
              {petsHere.map((pet) => {
                const flagged = pet.vaccine === "expired" || pet.vaccine === "missing";
                return (
                  <label key={pet.id} className="flex min-h-11 min-w-0 items-center gap-2 text-sm">
                    <Checkbox
                      checked={petIds.includes(pet.id)}
                      onCheckedChange={(c) => togglePet(pet.id, c === true)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="[overflow-wrap:anywhere]">{pet.name}</span>
                      {pet.size && (
                        <span className="text-muted-foreground">
                          {" "}
                          · {PET_SIZE_LABEL[pet.size as PetSize]}
                        </span>
                      )}
                      {pet.coat_type && (
                        <span className="text-muted-foreground">
                          {" "}
                          · {COAT_LABEL[pet.coat_type as CoatType]}
                        </span>
                      )}
                      {pet.breed && <span className="text-muted-foreground"> · {pet.breed}</span>}
                      {flagged && (
                        <span className="text-amber-700 dark:text-amber-400">
                          {" "}
                          · {VACCINE_STATUS_LABELS[pet.vaccine as VaccineState]}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </fieldset>

            {options.addons.length > 0 && (
              <fieldset className="space-y-1">
                <legend className="text-xs font-medium">Add-ons</legend>
                {options.addons.map((addon) => (
                  <label
                    key={addon.id}
                    className="flex min-h-11 min-w-0 items-center gap-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                      {addon.name}
                      <span className="text-muted-foreground">
                        {" "}
                        · {money(addon.unit_price_cents)}
                        {addon.duration_min ? `, ${addon.duration_min} min` : ""}
                      </span>
                    </span>
                    <Input
                      aria-label={`Quantity for ${addon.name}`}
                      inputMode="numeric"
                      className="h-11 w-16 shrink-0"
                      value={addonQty[addon.id] ?? ""}
                      placeholder="0"
                      onChange={(e) =>
                        setAddonQty((prev) => ({ ...prev, [addon.id]: e.target.value }))
                      }
                    />
                  </label>
                ))}
              </fieldset>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="groom-date" className="text-xs">
                  Date
                </Label>
                <Input
                  id="groom-date"
                  type="date"
                  className="h-11"
                  value={scheduledOn}
                  onChange={(e) => setScheduledOn(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="groom-repeat" className="text-xs">
                  Repeat
                </Label>
                <select
                  id="groom-repeat"
                  className="h-11 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
                  value={everyWeeks}
                  onChange={(e) => setEveryWeeks(e.target.value as "" | "4" | "6" | "8")}
                >
                  <option value="">Once</option>
                  <option value="4">Every 4 weeks</option>
                  <option value="6">Every 6 weeks</option>
                  <option value="8">Every 8 weeks</option>
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="groom-start" className="text-xs">
                {t("groom.startTime")}
              </Label>
              <Input
                id="groom-start"
                type="time"
                step={GROOM_SLOT_STEP_MIN * 60}
                className="h-11 w-36"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
              {clashes.length > 0 && (
                <p role="alert" className="text-sm text-destructive">
                  {t("groom.clash")}
                </p>
              )}
            </div>

            {holdMinutes > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium">{t("groom.openTimes")}</p>
                {dayQuery.isLoading ? (
                  <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
                ) : openStarts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("groom.noOpenTimes", { minutes: holdMinutes })}
                  </p>
                ) : (
                  <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                    {openStarts.map((slot) => (
                      <Button
                        key={slot}
                        type="button"
                        size="sm"
                        variant={slot === startTime ? "default" : "outline"}
                        className="min-h-11 min-w-16 shrink-0"
                        aria-pressed={slot === startTime}
                        onClick={() => setStartTime(slot)}
                      >
                        <span dir="ltr">{slot}</span>
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1">
              <Label htmlFor="groom-staff" className="text-xs">
                Groomer
              </Label>
              <select
                id="groom-staff"
                className="h-11 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
                value={staffId}
                onChange={(e) => setStaffId(e.target.value)}
              >
                <option value="">Leave unassigned</option>
                {options.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="groom-parking" className="text-xs">
                Parking notes
              </Label>
              <Textarea
                id="groom-parking"
                rows={2}
                maxLength={1000}
                placeholder="Where the van should park"
                value={parkingNotes}
                onChange={(e) => setParkingNotes(e.target.value)}
              />
            </div>

            {quote && (
              <p className="text-sm font-medium">
                {t("groom.hold", { minutes: holdMinutes, buffer: bufferMin })}
                {quote.cents == null ? ". Set a price before booking." : ` · ${money(quote.cents)}`}
              </p>
            )}

            {blocked && (
              <p className="text-sm text-destructive">
                A required vaccine is expired or missing. This business does not book the groom
                until it is current.
              </p>
            )}
            {warned && (
              <label className="flex min-h-11 items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={acknowledgeWarning}
                  onCheckedChange={(c) => setAcknowledgeWarning(c === true)}
                />
                <span className="min-w-0">{t("groom.vaccineWarn", { date: warnOn })}</span>
              </label>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!ready || bookMut.isPending}
            onClick={() => bookMut.mutate()}
          >
            {bookMut.isPending ? "Booking…" : "Book groom"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
