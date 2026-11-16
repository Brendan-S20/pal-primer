// Add a plan at the set price (#728, owner decision 2026-11-10: "Yes,
// dispatchers can manage plans at the set price").
//
// The form somebody who manages plans but does not set prices (a dispatcher)
// gets from Add service on an existing client. It has no price box: the price
// is the business's set price for the service, schedule and pets chosen,
// worked out by the server (getPlanSetPrice) and shown read-only. Save sends
// that number, and createSubscription works it out again and refuses any
// other, so a price typed into a request never reaches a plan.
//
// Its own component rather than a mode of ServiceDrawer: that drawer is the
// pricing surface (standard, zone, custom, deviation warnings) and none of it
// applies here.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateField } from "@/components/fields";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import {
  ServicePicker,
  effectiveServiceId,
  useOrgServices,
} from "@/components/client-detail/ServicePicker";
import { usePickerLines } from "@/components/CommercialOnly";
import { useOrgToday } from "@/hooks/useOrgToday";
import { createSubscription, getPlanSetPrice } from "@/lib/subscriptions.functions";

/** The schedules a set price exists for (setPriceFrequency on the server).
 *  Twice weekly has a set price too, but needs its two days chosen, which is
 *  the full plan form's job; it is left out here rather than half-asked. */
export const SET_PRICE_SCHEDULES = [
  { value: "weekly", label: "Weekly", frequency: "weekly", intervalWeeks: undefined },
  { value: "every_2_weeks", label: "Every 2 weeks", frequency: "weekly", intervalWeeks: 2 },
  { value: "monthly", label: "Monthly", frequency: "monthly", intervalWeeks: undefined },
] as const;
type ScheduleValue = (typeof SET_PRICE_SCHEDULES)[number]["value"];

export function PlanAtSetPriceDrawer({
  open,
  onClose,
  clientId,
  client,
  properties,
  dogs,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  client: any;
  properties: any[];
  dogs: any[];
  onSaved: () => void;
}) {
  const today = useOrgToday();
  const accountType = (client?.account_type ?? "residential") as "residential" | "commercial";
  const residential = accountType === "residential";
  const { services, isLoading: servicesLoading } = useOrgServices(open);
  const lines = usePickerLines();

  const activeDogsFor = (propertyId: string) =>
    dogs.filter((d: any) => d.property_id === propertyId && d.active !== false).length;
  const blank = useMemo(() => {
    const propertyId = properties.length === 1 ? (properties[0].id as string) : "";
    return {
      propertyId,
      serviceId: "",
      schedule: "weekly" as ScheduleValue,
      count: String(residential ? Math.max(1, propertyId ? activeDogsFor(propertyId) : 1) : 1),
      startedOn: today,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [properties, dogs, residential, today]);
  const [form, setForm] = useState(blank);
  useEffect(() => {
    if (open) setForm(blank);
    // Reset on open only, never under somebody's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const schedule = SET_PRICE_SCHEDULES.find((s) => s.value === form.schedule)!;
  const serviceId = effectiveServiceId(form.serviceId, services, lines) ?? undefined;
  const count = Math.max(1, parseInt(form.count, 10) || 1);

  const priceFn = useServerFn(getPlanSetPrice);
  const priceInput = form.propertyId
    ? {
        clientId,
        propertyId: form.propertyId,
        frequency: schedule.frequency,
        ...(schedule.intervalWeeks ? { intervalWeeks: schedule.intervalWeeks } : {}),
        ...(serviceId ? { serviceId } : {}),
        ...(residential ? { dogCount: count } : { unitCount: count }),
      }
    : null;
  const price = useQuery({
    queryKey: ["plan-set-price", priceInput],
    queryFn: () => priceFn({ data: priceInput! }),
    enabled: open && !!priceInput && !servicesLoading,
    retry: false,
  });

  const createFn = useServerFn(createSubscription);
  const save = useMutation({
    mutationFn: () => {
      const cents = price.data?.cents;
      if (cents == null || !priceInput) throw new Error("There is no set price for this plan yet.");
      return createFn({
        data: {
          clientId,
          propertyId: form.propertyId,
          accountType,
          frequency: schedule.frequency,
          ...(schedule.intervalWeeks ? { intervalWeeks: schedule.intervalWeeks } : {}),
          priceCents: cents,
          ...(price.data?.zoneId ? { zoneId: price.data.zoneId } : {}),
          billingCadence: "postpaid",
          ...(residential ? { dogCount: count } : { unitCount: count }),
          ...(serviceId ? { serviceId } : {}),
          startedOn: form.startedOn || today,
        },
      });
    },
    onSuccess: () => {
      toast.success("Plan added at the set price.");
      onSaved();
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const dirty = JSON.stringify(form) !== JSON.stringify(blank);
  const cents = price.data?.cents ?? null;

  return (
    <EditDrawer
      open={open}
      onClose={onClose}
      title="Add plan"
      description="Plans you add use the business's set price. To change a price, ask somebody who sets prices."
      size="sm"
      dirty={dirty}
    >
      <div className="space-y-4">
        <div className="min-w-0">
          <Label htmlFor="psp-property">Property</Label>
          <select
            id="psp-property"
            value={form.propertyId}
            onChange={(e) => {
              const propertyId = e.target.value;
              setForm((f) => ({
                ...f,
                propertyId,
                ...(residential && propertyId
                  ? { count: String(Math.max(1, activeDogsFor(propertyId))) }
                  : {}),
              }));
            }}
            className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm touch:h-11"
          >
            <option value="">Choose a property</option>
            {properties.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.label ? `${p.label}: ` : ""}
                {p.street}
              </option>
            ))}
          </select>
        </div>

        <ServicePicker
          id="psp-service"
          value={form.serviceId}
          currentId={null}
          services={services}
          isLoading={servicesLoading}
          onChange={(id) => setForm((f) => ({ ...f, serviceId: id }))}
          lines={lines}
        />

        <fieldset className="min-w-0">
          <legend className="text-sm font-medium">How often</legend>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {SET_PRICE_SCHEDULES.map((s) => (
              <Button
                key={s.value}
                type="button"
                variant={form.schedule === s.value ? "default" : "outline"}
                aria-pressed={form.schedule === s.value}
                className="min-w-0 max-w-full"
                onClick={() => setForm((f) => ({ ...f, schedule: s.value }))}
              >
                <span className="truncate">{s.label}</span>
              </Button>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <Label htmlFor="psp-count">{residential ? "Dogs" : "Units"}</Label>
            <Input
              id="psp-count"
              type="number"
              inputMode="numeric"
              min={1}
              value={form.count}
              onChange={(e) => setForm((f) => ({ ...f, count: e.target.value }))}
              className="touch:h-11"
            />
          </div>
          <DateField
            label="First visit"
            value={form.startedOn}
            minISO={today}
            onChange={(iso) => setForm((f) => ({ ...f, startedOn: iso }))}
          />
        </div>

        <div
          className="rounded-md border bg-muted/40 p-3 text-sm"
          data-testid="plan-set-price"
          aria-live="polite"
        >
          {!form.propertyId ? (
            <span className="text-muted-foreground">Choose a property to see the set price.</span>
          ) : price.isLoading ? (
            <span className="text-muted-foreground">Working out the set price…</span>
          ) : price.isError ? (
            <span className="text-destructive">{(price.error as Error).message}</span>
          ) : cents != null ? (
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-muted-foreground">Set price</span>
              <span>
                <span className="text-base font-semibold">${(cents / 100).toFixed(2)}</span>
                <span className="text-xs text-muted-foreground">
                  {" "}
                  per visit, billed after each visit
                </span>
              </span>
            </div>
          ) : (
            <span className="text-amber-800 dark:text-amber-300">{price.data?.reason}</span>
          )}
        </div>
      </div>

      <DrawerFooter>
        <Button
          type="button"
          onClick={() => save.mutate()}
          disabled={cents == null || save.isPending || !form.propertyId}
        >
          {save.isPending ? "Adding…" : "Add plan"}
        </Button>
      </DrawerFooter>
    </EditDrawer>
  );
}
