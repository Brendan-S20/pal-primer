// Settings → Services: what this business sells.
//
// The catalog for service lines (docs/other-trades-service-catalog.md).
// Pet waste removal, dog walking, pet sitting, training and mobile grooming
// are bookable; a line the platform switch turns off reads Coming soon. Office only: the route
// is limited to owner and office manager in ROUTE_ROLES, the same people who hold
// manage_pricing, which is what every write here asks for on the server and
// in RLS.
//
// Pricing is "both, business chooses": flat per visit or per hour on every
// line, and per night as well for pet sitting. The rules live in
// src/lib/services.ts so this form and the server say the same sentences.
//
// Pet waste is the exception (#788): its plans are priced by zone and its
// one-time cleanup by the owner's extra-visit price. The list shows both
// amounts, and the form edits the one-time price in place through the same
// setting the Client portal card writes, so there is still one number.
//
// Nothing is deleted here. A service is deactivated, because from phase 2
// plans and visits point at it.

import { ServiceSizeRulesEditor } from "@/components/settings/ServiceSizeRulesEditor";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import {
  createService,
  listServices,
  setServiceActive,
  updateService,
} from "@/lib/services.functions";
import { PetWastePriceFields } from "@/components/settings/PetWastePriceFields";
import { getPortalBookingSettings, setPortalBookingSettings } from "@/lib/portal-booking.functions";
import { listZones } from "@/lib/zones.functions";
import {
  PRICE_UNIT_LABEL,
  centsToDollarInput,
  defaultServiceLine,
  durationRequired,
  formatServiceMoney,
  isBookableServiceLine,
  lowestZoneVisitCents,
  petWasteOneTimeSave,
  parseDollarsToCents,
  petWastePriceLabel,
  priceUnitsFor,
  serviceDurationLabel,
  serviceLineChoices,
  serviceLineLabel,
  serviceNamePlaceholder,
  servicePriceLabel,
  serviceProblem,
  withArticle,
  type OneTimeCleanupSetting,
  type PriceUnit,
  type Service,
  type ServiceDraft,
} from "@/lib/services";
import type { ServiceLine } from "@/lib/service-lines";
import { useServiceLines } from "@/components/CommercialOnly";
import { useServiceLineAvailability } from "@/hooks/useServiceLineAvailability";
import { ComingSoonBadge } from "@/components/ComingSoonBadge";
import { HolidayDatesCard } from "@/components/settings/HolidayDatesCard";
import { StayDepositCard } from "@/components/settings/StayDepositCard";
import { usePermissions } from "@/hooks/useMyRole";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VaccineSettings } from "@/components/settings/VaccineSettings";
import { titleHead } from "@/lib/page-title";
import { TrainingOnly } from "@/components/training/TrainingOnly";
import { TrainingPackagesCard } from "@/components/settings/TrainingPackagesCard";
import { TrainingSkillsCard } from "@/components/settings/TrainingSkillsCard";
import { TrainingSessionRulesCard } from "@/components/settings/TrainingSessionRulesCard";
import { ensureTrainingCatalog, listServicePackages } from "@/lib/training-packages.functions";
import {
  PACKAGE_NEEDED,
  PUBLIC_BOOKING_MODES,
  PUBLIC_BOOKING_MODE_COPY,
  PUBLIC_BOOKING_MODE_LEGEND,
  defaultPublicBookingMode,
  isPublicBookingMode,
  type PublicBookingMode,
} from "@/lib/public-booking-mode";

export const Route = createFileRoute("/_authenticated/settings/services")({
  head: () => titleHead("Services", "Settings"),
  component: ServicesPage,
});

const QUERY_KEY = ["services", "all"] as const;

/** The form's own state: money and minutes kept as the strings being typed,
 *  converted once on save (the add-ons form once turned "10.00" into $1.00 by
 *  reformatting on every keystroke). */
type FormState = {
  id: string | null;
  name: string;
  service_line: ServiceLine;
  price_unit: PriceUnit;
  price: string;
  extraPet: string;
  minutes: string;
  maxDogs: string;
  groupWalk: boolean;
  holidayPct: string;
  /** How the booking link starts it (#574). */
  bookingMode: PublicBookingMode;
  packageId: string;
  /** Pet waste only (#788): the one-time cleanup price as typed, which is
   *  organizations.one_off_price_cents. Null when it cannot be edited from
   *  here (the setting has not loaded, or the caller may not change it). */
  oneTimePrice: string | null;
};

/** What the form knows about the one-time cleanup setting when it opens. */
type OneTimeSetting = OneTimeCleanupSetting | null;

function oneTimeInput(setting: OneTimeSetting): string | null {
  if (!setting?.canEdit) return null;
  return centsToDollarInput(setting.priceCents);
}

function formFor(s: Service | null, line: ServiceLine, oneTime: OneTimeSetting = null): FormState {
  const oneTimePrice = oneTimeInput(oneTime);
  if (!s) {
    return {
      id: null,
      name: "",
      service_line: line,
      price_unit: "visit",
      price: "",
      extraPet: "",
      minutes: "",
      maxDogs: "",
      groupWalk: false,
      holidayPct: "0",
      bookingMode: defaultPublicBookingMode(line, "visit"),
      packageId: "",
      oneTimePrice,
    };
  }
  return {
    id: s.id,
    name: s.name,
    service_line: s.service_line,
    price_unit: s.price_unit,
    price: centsToDollarInput(s.base_price_cents),
    extraPet: s.extra_pet_cents > 0 ? centsToDollarInput(s.extra_pet_cents) : "",
    minutes: s.default_duration_min === null ? "" : String(s.default_duration_min),
    maxDogs: s.max_dogs == null ? "" : String(s.max_dogs),
    groupWalk: s.max_dogs != null,
    holidayPct: String(s.holiday_surcharge_pct ?? 0),
    // Unset is request only, and the form says so rather than guessing.
    bookingMode: isPublicBookingMode(s.public_booking_mode)
      ? s.public_booking_mode
      : "request_only",
    packageId: s.public_package_id ?? "",
    oneTimePrice,
  };
}

/** The form as a draft, or the sentence that says why it is not one yet. */
function draftOf(f: FormState): { draft: ServiceDraft } | { problem: string } {
  const base = parseDollarsToCents(f.price);
  if (Number.isNaN(base)) return { problem: "Enter the price as dollars and cents, like 25.00." };
  const extra = parseDollarsToCents(f.extraPet);
  if (Number.isNaN(extra))
    return { problem: "Enter the extra-pet charge as dollars and cents, like 5.00." };
  const m = f.minutes.trim();
  const minutes = m === "" ? null : Number(m);
  if (minutes !== null && !Number.isInteger(minutes))
    return { problem: "Enter the length in whole minutes." };
  const draft: ServiceDraft = {
    ...(f.service_line === "pet_sitting" ? { holiday_surcharge_pct: Number(f.holidayPct) } : {}),
    name: f.name.trim(),
    service_line: f.service_line,
    price_unit: f.price_unit,
    base_price_cents: base,
    extra_pet_cents: extra ?? 0,
    default_duration_min: minutes,
    max_dogs: f.service_line === "dog_walking" && f.groupWalk ? Number(f.maxDogs) : null,
    public_booking_mode: f.bookingMode,
    public_package_id: f.bookingMode === "package" ? f.packageId || null : null,
  };
  if (f.bookingMode === "package" && !f.packageId) return { problem: PACKAGE_NEEDED };
  const problem = serviceProblem(draft);
  return problem ? { problem } : { draft };
}

/** Everything one press of Save writes (#788): the service row, and for a
 *  pet-waste service the one-time cleanup price when it changed. Both are
 *  checked before either is written, so a bad price leaves nothing half
 *  saved. */
function savePlanOf(f: FormState, oneTime: OneTimeSetting) {
  const out = draftOf(f);
  if ("problem" in out) return out;
  const price = petWasteOneTimeSave(f.service_line, f.oneTimePrice, oneTime);
  if (price && "problem" in price) return price;
  return { draft: out.draft, oneTime: price ? price.data : null };
}

function ServicesPage() {
  const qc = useQueryClient();
  const list = useServerFn(listServices);
  const create = useServerFn(createService);
  const update = useServerFn(updateService);
  const setActive = useServerFn(setServiceActive);
  const getPortalBooking = useServerFn(getPortalBookingSettings);
  const setPortalBooking = useServerFn(setPortalBookingSettings);
  const listZonesFn = useServerFn(listZones);
  const { can } = usePermissions();
  const canEdit = can("manage_pricing");
  const { lines, known } = useServiceLines();
  const availability = useServiceLineAvailability();
  const ensure = useServerFn(ensureTrainingCatalog);
  const seeded = useRef(false);
  const trainingOn = known && lines.includes("training");
  useEffect(() => {
    if (seeded.current || !trainingOn || !canEdit) return;
    seeded.current = true;
    void ensure()
      .then(() => {
        qc.invalidateQueries({ queryKey: ["services"] });
        qc.invalidateQueries({ queryKey: ["service-packages"] });
        qc.invalidateQueries({ queryKey: ["training-skills"] });
      })
      .catch(() => {});
  }, [trainingOn, canEdit, ensure, qc]);

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => list({ data: { includeInactive: true } }),
  });
  const services: Service[] = data?.services ?? [];

  const [sizeService, setSizeService] = useState<Service | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Pet waste's two real prices (#788), read from where they live: the
  // zones, and the one-time cleanup price the Client portal card also edits.
  // Same query keys as those screens, so a save on either shows on both.
  const petWasteShown =
    services.some((s) => s.service_line === "pet_waste") || form?.service_line === "pet_waste";
  const portalQ = useQuery({
    queryKey: ["portal-booking-settings"],
    queryFn: () => getPortalBooking(),
    enabled: petWasteShown,
    retry: false,
  });
  const zonesQ = useQuery({
    queryKey: ["zones"],
    queryFn: () => listZonesFn(),
    enabled: petWasteShown,
    retry: false,
  });
  const portal = portalQ.data;
  const oneTime: OneTimeSetting = useMemo(
    () =>
      portal
        ? { priceCents: portal.priceCents, autoAccept: portal.autoAccept, canEdit: portal.canEdit }
        : null,
    [portal],
  );
  const zoneFromCents = lowestZoneVisitCents(zonesQ.data?.zones);
  // A form opened before the setting arrived (a business with no pet-waste
  // service yet, choosing Pet waste removal) gets the field once it does.
  useEffect(() => {
    if (form && form.oneTimePrice === null && oneTime?.canEdit)
      setForm({ ...form, oneTimePrice: oneTimeInput(oneTime) });
  }, [form, oneTime]);
  const priceLabelOf = (s: Service) =>
    s.service_line === "pet_waste" && portalQ.data && zonesQ.data
      ? petWastePriceLabel({ zoneFromCents, oneTimeCents: portalQ.data.priceCents })
      : servicePriceLabel(s);

  // The setup checklist's price step is done from this page (R2-47): a walk
  // priced here left "Next: Price your walks" up until its cache ran out.
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["services"] });
    qc.invalidateQueries({ queryKey: ["onboarding-status"] });
  };

  const save = useMutation({
    mutationFn: async (f: FormState) => {
      const plan = savePlanOf(f, oneTime);
      if ("problem" in plan) throw new Error(plan.problem);
      const r = f.id
        ? await update({ data: { id: f.id, ...plan.draft } })
        : await create({ data: plan.draft });
      if (plan.oneTime) await setPortalBooking({ data: plan.oneTime });
      return r;
    },
    onSuccess: (_r, f) => {
      toast.success(f.id ? "Service saved" : "Service added");
      setForm(null);
      refresh();
      qc.invalidateQueries({ queryKey: ["portal-booking-settings"] });
    },
    onError: (e: Error) => setFormError(e.message),
  });

  const toggle = useMutation({
    mutationFn: (s: Service) => setActive({ data: { id: s.id, active: !s.active } }),
    onSuccess: (r) => {
      toast.success(r.active ? "Service reactivated" : "Service deactivated");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const open = (s: Service | null) => {
    setFormError(null);
    setForm(formFor(s, defaultServiceLine(lines), oneTime));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Services</h2>
          <p className="text-sm text-muted-foreground">
            Set prices per visit or by the hour, or per night for pet sitting. Pet waste removal,
            dog walking, pet sitting, training and mobile grooming are bookable today.
          </p>
        </div>
        {canEdit && (
          <Button className="shrink-0" onClick={() => open(null)}>
            <Plus className="h-4 w-4 shrink-0" />
            Add service
          </Button>
        )}
      </div>

      <section className="rounded-lg border bg-card">
        {isLoading ? (
          <p className="p-5 text-sm text-muted-foreground">Loading services…</p>
        ) : error ? (
          <p className="p-5 text-sm text-destructive">{(error as Error).message}</p>
        ) : services.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            No services yet. Add the first thing you sell, like{" "}
            {withArticle(serviceNamePlaceholder(defaultServiceLine(lines)))}.
          </p>
        ) : (
          <ul className="divide-y" data-testid="services-list">
            {services.map((s) => {
              const duration = serviceDurationLabel(s.default_duration_min);
              return (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{s.name}</span>
                      <Badge variant="secondary" className="shrink-0">
                        {serviceLineLabel(s.service_line)}
                      </Badge>
                      {availability && !isBookableServiceLine(s.service_line, availability) && (
                        <ComingSoonBadge />
                      )}
                      {!s.active && (
                        <Badge variant="outline" className="shrink-0">
                          Inactive
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {priceLabelOf(s)}
                      {duration ? ` · usually ${duration}` : ""}
                      {s.public_booking_mode !== undefined &&
                        ` · Booking link: ${
                          PUBLIC_BOOKING_MODE_COPY[
                            isPublicBookingMode(s.public_booking_mode)
                              ? s.public_booking_mode
                              : "request_only"
                          ].label
                        }`}
                      {s.service_line === "dog_walking" && s.max_dogs != null && (
                        <p>Group walk, up to {s.max_dogs} dogs</p>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {s.service_line === "mobile_grooming" && (
                        <Button
                          className="min-h-11"
                          size="sm"
                          variant="outline"
                          onClick={() => setSizeService(s)}
                        >
                          Prices by size
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => open(s)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate(s)}
                      >
                        {s.active ? "Deactivate" : "Reactivate"}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {lines.includes("mobile_grooming") && <VaccineSettings />}
      {(lines.includes("pet_sitting") || lines.includes("training")) && (
        <HolidayDatesCard
          canEdit={canEdit}
          sitting={lines.includes("pet_sitting")}
          training={lines.includes("training")}
        />
      )}
      {lines.includes("pet_sitting") && <StayDepositCard canEdit={canEdit} />}

      <Dialog open={sizeService !== null} onOpenChange={(open) => !open && setSizeService(null)}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Prices by size</DialogTitle>
            <DialogDescription>{sizeService?.name}</DialogDescription>
          </DialogHeader>
          {sizeService && (
            <ServiceSizeRulesEditor
              serviceId={sizeService.id}
              serviceLine={sizeService.service_line}
            />
          )}
        </DialogContent>
      </Dialog>

      <TrainingOnly>
        <TrainingPackagesCard services={services} canEdit={canEdit} />
        <TrainingSkillsCard canEdit={canEdit} />
        <TrainingSessionRulesCard canEdit={can("manage_settings")} />
      </TrainingOnly>

      <Dialog open={form !== null} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          {form && (
            <ServiceForm
              form={form}
              setForm={(f) => {
                setFormError(null);
                setForm(f);
              }}
              lines={lines}
              oneTime={oneTime}
              zoneFromCents={zoneFromCents}
              error={formError}
              saving={save.isPending}
              onSubmit={() => save.mutate(form)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ServiceForm({
  form,
  setForm,
  lines,
  oneTime,
  zoneFromCents,
  error,
  saving,
  onSubmit,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  lines: readonly ServiceLine[];
  oneTime: OneTimeSetting;
  zoneFromCents: number | null;
  error: string | null;
  saving: boolean;
  onSubmit: () => void;
}) {
  const availability = useServiceLineAvailability();
  const units = priceUnitsFor(form.service_line);
  const minutesRequired = durationRequired(form.service_line) && form.price_unit !== "night";
  const per = form.price_unit;
  const petWaste = form.service_line === "pet_waste";

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{form.id ? "Edit service" : "Add a service"}</DialogTitle>
        <DialogDescription>
          Clients see the name on quotes and invoices once services are on plans.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <Label htmlFor="service-name">Name</Label>
        <Input
          id="service-name"
          value={form.name}
          maxLength={80}
          placeholder={serviceNamePlaceholder(form.service_line)}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="service-line">Kind of service</Label>
        <Select
          value={form.service_line}
          onValueChange={(v) => {
            const line = v as ServiceLine;
            // Night is for sitting only; moving off sitting moves off night.
            const unit = priceUnitsFor(line).includes(form.price_unit) ? form.price_unit : "visit";
            setForm({
              ...form,
              service_line: line,
              price_unit: unit,
              groupWalk: line === "dog_walking" && form.groupWalk,
              // A new service starts on its line's default; a saved one keeps
              // what the owner chose.
              ...(form.id ? {} : { bookingMode: defaultPublicBookingMode(line, unit) }),
            });
          }}
        >
          <SelectTrigger id="service-line">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {serviceLineChoices(lines, availability, form.service_line).map((l) => (
              <SelectItem key={l} value={l}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate">{serviceLineLabel(l)}</span>
                  {availability && !isBookableServiceLine(l, availability) && <ComingSoonBadge />}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {availability && !isBookableServiceLine(form.service_line, availability) && (
          <p className="text-xs text-muted-foreground">
            Coming soon: you can set this up now, but clients can't book it yet.
          </p>
        )}
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium">Priced</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How it is priced">
          {units.map((u) => {
            const on = form.price_unit === u;
            return (
              <button
                key={u}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() =>
                  setForm({
                    ...form,
                    price_unit: u,
                    ...(form.id
                      ? {}
                      : { bookingMode: defaultPublicBookingMode(form.service_line, u) }),
                  })
                }
                className={`inline-flex min-h-9 items-center rounded-md border px-3 text-sm touch:min-h-11 ${
                  on
                    ? "border-primary bg-primary/10 font-medium text-primary"
                    : "bg-background text-foreground"
                }`}
              >
                {PRICE_UNIT_LABEL[u]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        {petWaste ? (
          // A pet-waste service's own price is not read (#641): a plan is
          // priced by its zone, a one-time cleanup by the owner's extra-visit
          // price. Both amounts are shown, and the one-time one is edited
          // here (#788). Whatever base price an older form saved is left as
          // it was and sent back unchanged.
          <PetWastePriceFields
            oneTimePrice={form.oneTimePrice}
            savedOneTimeCents={oneTime?.priceCents ?? null}
            zoneFromCents={zoneFromCents}
            onOneTimePriceChange={(v) => setForm({ ...form, oneTimePrice: v })}
          />
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="service-price">Price per {per} ($)</Label>
              <Input
                id="service-price"
                inputMode="decimal"
                placeholder="0.00"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="service-extra">Each extra pet, per {per} ($)</Label>
              <Input
                id="service-extra"
                inputMode="decimal"
                placeholder="0.00"
                value={form.extraPet}
                onChange={(e) => setForm({ ...form, extraPet: e.target.value })}
              />
            </div>
          </>
        )}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="service-minutes">
            Usually takes (minutes){minutesRequired ? "" : ", optional"}
          </Label>
          <Input
            id="service-minutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={720}
            placeholder={
              form.price_unit === "night" ? "Optional" : minutesRequired ? "30" : "Set by each yard"
            }
            value={form.minutes}
            onChange={(e) => setForm({ ...form, minutes: e.target.value })}
            required={minutesRequired}
          />
        </div>
      </div>

      {form.service_line === "pet_sitting" && (
        <div className="space-y-1.5">
          <Label htmlFor="service-holiday">Holiday surcharge (%)</Label>
          <Input
            id="service-holiday"
            type="number"
            min={0}
            max={500}
            step={1}
            value={form.holidayPct}
            onChange={(e) => setForm({ ...form, holidayPct: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Applied to sitting visits on the holiday dates set on this page. Zero means the usual
            rate.
          </p>
        </div>
      )}

      {form.service_line === "dog_walking" && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Group walk</legend>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.groupWalk}
              onChange={(e) =>
                setForm({ ...form, groupWalk: e.target.checked, maxDogs: form.maxDogs || "4" })
              }
            />
            Offer a group walk
          </label>
          {form.groupWalk && (
            <div className="space-y-1.5">
              <Label htmlFor="service-max-dogs">Up to this many dogs</Label>
              <Input
                id="service-max-dogs"
                className="min-h-11"
                type="number"
                min={1}
                max={50}
                required
                value={form.maxDogs}
                onChange={(e) => setForm({ ...form, maxDogs: e.target.value })}
              />
            </div>
          )}
        </fieldset>
      )}

      <BookingModeField form={form} setForm={setForm} />

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter className="gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : form.id ? "Save service" : "Add service"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** How the booking link starts this service (#574): one visit, a repeating
 *  plan, a package, or request only. Shown for every line. A package is
 *  offered once the service has one to sell (they are made under Training
 *  packages), and for a service that is already set to one. */
function BookingModeField({ form, setForm }: { form: FormState; setForm: (f: FormState) => void }) {
  const list = useServerFn(listServicePackages);
  const packagesQ = useQuery({
    queryKey: ["service-packages"],
    queryFn: () => list(),
    enabled: !!form.id,
    retry: false,
  });
  const packages = (packagesQ.data?.packages ?? []).filter(
    (p) => p.service_id === form.id && (p.active || p.id === form.packageId),
  );
  const modes = PUBLIC_BOOKING_MODES.filter(
    (m) => m !== "package" || packages.length > 0 || form.bookingMode === "package",
  );
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{PUBLIC_BOOKING_MODE_LEGEND}</legend>
      <div
        className="grid gap-2 sm:grid-cols-2"
        role="radiogroup"
        aria-label={PUBLIC_BOOKING_MODE_LEGEND}
        data-testid="booking-mode"
      >
        {modes.map((m) => {
          const on = form.bookingMode === m;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() =>
                setForm({
                  ...form,
                  bookingMode: m,
                  packageId:
                    m === "package" && !form.packageId && packages.length === 1
                      ? packages[0].id
                      : form.packageId,
                })
              }
              className={`flex min-h-11 min-w-0 flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-start text-sm ${
                on ? "border-primary bg-primary/10" : "bg-background"
              }`}
            >
              <span className={on ? "font-medium text-primary" : "font-medium text-foreground"}>
                {PUBLIC_BOOKING_MODE_COPY[m].label}
              </span>
              <span className="text-xs text-muted-foreground">
                {PUBLIC_BOOKING_MODE_COPY[m].hint}
              </span>
            </button>
          );
        })}
      </div>
      {form.bookingMode === "package" && (
        <div className="space-y-1.5 pt-1">
          <Label htmlFor="service-public-package">Package sold online</Label>
          <Select value={form.packageId} onValueChange={(v) => setForm({ ...form, packageId: v })}>
            <SelectTrigger id="service-public-package" className="min-w-0">
              <SelectValue placeholder="Pick a package" />
            </SelectTrigger>
            <SelectContent>
              {packages.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} ({p.sessions_count} sessions, {formatServiceMoney(p.price_cents)})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </fieldset>
  );
}
