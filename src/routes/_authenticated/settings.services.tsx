// Settings → Services: what this business sells.
//
// The catalog for service lines (docs/other-trades-service-catalog.md).
// Pet waste removal and dog walking are bookable; other lines join when
// their paths work end to end. Office only: the route is limited
// to owner and office manager in ROUTE_ROLES, the same people who hold
// manage_pricing, which is what every write here asks for on the server and
// in RLS.
//
// Pricing is "both, business chooses": flat per visit or per hour on every
// line, and per night as well for pet sitting. The rules live in
// src/lib/services.ts so this form and the server say the same sentences.
//
// Nothing is deleted here. A service is deactivated, because from phase 2
// plans and visits point at it.

import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import {
  createService,
  listServices,
  setServiceActive,
  updateService,
} from "@/lib/services.functions";
import {
  PRICE_UNIT_LABEL,
  centsToDollarInput,
  defaultServiceLine,
  durationRequired,
  parseDollarsToCents,
  priceUnitsFor,
  serviceDurationLabel,
  serviceLineChoices,
  serviceLineLabel,
  servicePriceLabel,
  serviceProblem,
  type PriceUnit,
  type Service,
  type ServiceDraft,
} from "@/lib/services";
import type { ServiceLine } from "@/lib/service-lines";
import { useServiceLines } from "@/components/CommercialOnly";
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
import { titleHead } from "@/lib/page-title";

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
};

function formFor(s: Service | null, line: ServiceLine): FormState {
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
  };
  const problem = serviceProblem(draft);
  return problem ? { problem } : { draft };
}

function ServicesPage() {
  const qc = useQueryClient();
  const list = useServerFn(listServices);
  const create = useServerFn(createService);
  const update = useServerFn(updateService);
  const setActive = useServerFn(setServiceActive);
  const { can } = usePermissions();
  const canEdit = can("manage_pricing");
  const { lines } = useServiceLines();

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => list({ data: { includeInactive: true } }),
  });
  const services: Service[] = data?.services ?? [];

  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["services"] });

  const save = useMutation({
    mutationFn: async (f: FormState) => {
      const out = draftOf(f);
      if ("problem" in out) throw new Error(out.problem);
      return f.id ? update({ data: { id: f.id, ...out.draft } }) : create({ data: out.draft });
    },
    onSuccess: (_r, f) => {
      toast.success(f.id ? "Service saved" : "Service added");
      setForm(null);
      refresh();
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
    setForm(formFor(s, defaultServiceLine(lines)));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Services</h2>
          <p className="text-sm text-muted-foreground">
            What you sell, and how each one is priced: a flat price per visit or by the hour.
            Pet waste removal, dog walking and pet sitting are bookable. Grooming and training are Coming soon.
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
            No services yet. Add the first thing you sell, like a 30-minute walk.
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
                      {!s.active && (
                        <Badge variant="outline" className="shrink-0">
                          Inactive
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {servicePriceLabel(s)}
                      {duration ? ` · usually ${duration}` : ""}
                      {s.service_line === "dog_walking" && s.max_dogs != null && (
                        <p>Group walk, up to {s.max_dogs} dogs</p>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 gap-2">
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
  error,
  saving,
  onSubmit,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  lines: readonly ServiceLine[];
  error: string | null;
  saving: boolean;
  onSubmit: () => void;
}) {
  const units = priceUnitsFor(form.service_line);
  const minutesRequired = durationRequired(form.service_line);
  const per = form.price_unit;

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
          placeholder="30-minute walk"
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
            });
          }}
        >
          <SelectTrigger id="service-line">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {serviceLineChoices(lines, form.service_line).map((l) => (
              <SelectItem key={l} value={l}>
                {serviceLineLabel(l)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
                onClick={() => setForm({ ...form, price_unit: u })}
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
        <div className="space-y-1.5">
          <Label htmlFor="service-price">Price per {per} ($)</Label>
          <Input
            id="service-price"
            inputMode="decimal"
            placeholder={form.service_line === "pet_waste" ? "Set by your zones" : "0.00"}
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
            placeholder={minutesRequired ? "30" : "Set by each yard"}
            value={form.minutes}
            onChange={(e) => setForm({ ...form, minutes: e.target.value })}
            required={minutesRequired}
          />
        </div>
      </div>

      {form.service_line === "pet_sitting" && <div className="space-y-1.5">
        <Label htmlFor="service-holiday">Holiday surcharge (%)</Label>
        <Input id="service-holiday" type="number" min={0} max={500} step={1} value={form.holidayPct} onChange={(e) => setForm({ ...form, holidayPct: e.target.value })} />
        <p className="text-xs text-muted-foreground">Applied to sitting visits on dates in Settings &gt; Blackouts. Zero means the usual rate.</p>
      </div>}

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
