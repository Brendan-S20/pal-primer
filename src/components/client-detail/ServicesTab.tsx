// Services tab (spec: subscriptions are "Services" in the UI). Read-only
// rows with lifecycle actions — edit in a drawer, pause/resume, end with an
// effective date + reason, delete only when the service never started. The
// creation form stays hidden until "Add Service".
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Square,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DateField, TimeField } from "@/components/fields";
import { formatDay, formatWindow } from "@/lib/format";
import { MetaChip, SectionLabel, StatusChip } from "@/components/client-detail/primitives";
import {
  createSubscription,
  updateSubscription,
  pauseSubscription,
  resumeSubscription,
  endSubscription,
  deleteDraftSubscription,
  getStandardPricing,
} from "@/lib/subscriptions.functions";
import { computeZoneVisitPrice } from "@/lib/pricing";
import {
  subscriptionToFormValues,
  blankSubscriptionFormValues,
  scheduleChoiceFromRecord,
  scheduleChoiceToFields,
  formatFrequency,
  isServiceEnded,
  type ScheduleChoice,
  type SubscriptionFormValues,
} from "@/lib/subscription-form";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { PrepayInline } from "@/components/client-detail/billing-panels";
import {
  listAddonRequests,
  approveAddonRequest,
  declineAddonRequest,
} from "@/lib/addons.functions";
import { generatePrepaidInvoice } from "@/lib/invoices.functions";
import { generateVisits } from "@/lib/visits.functions";
import { useConfirmDialog } from "@/components/ConfirmDialog";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ServicesTab({
  clientId,
  client,
  properties,
  subscriptions,
  zones,
  visits,
  dogs,
  canBill,
  canManagePricing,
}: {
  clientId: string;
  client: any;
  properties: any[];
  subscriptions: any[];
  zones: any[];
  visits: any[];
  dogs: any[];
  canBill: boolean;
  canManagePricing: boolean;
}) {
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [drawerSub, setDrawerSub] = useState<any | null | "new">(null);
  const [endingSub, setEndingSub] = useState<any | null>(null);
  const [detailSub, setDetailSub] = useState<any | null>(null);

  const pauseFn = useServerFn(pauseSubscription);
  const resumeFn = useServerFn(resumeSubscription);
  const deleteFn = useServerFn(deleteDraftSubscription);
  const prepayFn = useServerFn(generatePrepaidInvoice);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["subs", clientId] });
    qc.invalidateQueries({ queryKey: ["client-visit-history", clientId] });
    qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
  };

  const pauseMut = useMutation({
    mutationFn: (id: string) => pauseFn({ data: { subscriptionId: id } }),
    onSuccess: () => {
      toast.success("Service paused. Future visits removed.");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const resumeMut = useMutation({
    mutationFn: (id: string) => resumeFn({ data: { subscriptionId: id } }),
    onSuccess: () => {
      toast.success("Service resumed. Schedule regenerated.");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { subscriptionId: id } }),
    onSuccess: () => {
      toast.success("Service deleted");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const generateFn = useServerFn(generateVisits);
  const generateMut = useMutation({
    mutationFn: () => {
      const d = new Date();
      d.setDate(d.getDate() + 60);
      const through = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return generateFn({ data: { through } });
    },
    onSuccess: (r: any) => {
      toast.success(
        r?.inserted ? `Scheduled ${r.inserted} visit${r.inserted === 1 ? "" : "s"}` : "Schedule is up to date",
      );
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const syncDogsFn = useServerFn(updateSubscription);
  const syncDogsMut = useMutation({
    mutationFn: (v: { sub: any; count: number }) =>
      syncDogsFn({
        data: {
          subscriptionId: v.sub.id,
          propertyId: v.sub.property_id,
          frequency: v.sub.frequency,
          intervalWeeks: v.sub.interval_weeks ?? undefined,
          intervalDays: v.sub.interval_days ?? undefined,
          priceCents: v.sub.price_cents,
          dogCount: v.count,
          zoneId: v.sub.zone_id ?? undefined,
          billingCadence: v.sub.billing_cadence ?? undefined,
          startedOn: v.sub.started_on ?? undefined,
          endsOn: v.sub.ends_on ?? null,
          preferredWeekdays: v.sub.preferred_weekdays ?? undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Dog count synced from the property's records");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const prepayMut = useMutation({
    mutationFn: (v: { subscriptionId: string; visitCount: number }) => prepayFn({ data: v }),
    onSuccess: (r: any) => {
      // Stay on the page (UX round 4): the invoice is one click away on the
      // Billing tab, and yanking the user off the client page lost context.
      toast.success("Prepaid invoice created. Find it on the Billing tab.", {
        action: {
          label: "View invoice",
          onClick: () => window.location.assign(`/invoices/${r.invoiceId}`),
        },
      });
      qc.invalidateQueries({ queryKey: ["credit", clientId] });
      qc.invalidateQueries({ queryKey: ["billing-summary", clientId] });
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const today = todayISO();
  const nextVisitBySub = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of visits) {
      if (v.status !== "scheduled" || !v.scheduled_on || v.scheduled_on < today) continue;
      const sid = (v as any).subscription_id;
      if (!sid) continue;
      const cur = map.get(sid);
      if (!cur || v.scheduled_on < cur) map.set(sid, v.scheduled_on);
    }
    return map;
  }, [visits, today]);

  const streetById = new Map(properties.map((p: any) => [p.id, p.street]));

  // Ended services drop out of the main list into a collapsed section (UX
  // round 4: "when I end a service, it doesn't end or go away").
  const liveSubs = subscriptions.filter((s: any) => !isServiceEnded(s, today));
  const endedSubs = subscriptions.filter((s: any) => isServiceEnded(s, today));
  const [showEnded, setShowEnded] = useState(false);

  const renderServiceRow = (s: any) => {
            const ended = isServiceEnded(s, today);
            const paused = s.status === "paused";
            const started = s.started_on && s.started_on <= today;
            const nextVisit = nextVisitBySub.get(s.id);
            // QA follow-up 1.5: service dog count vs the property's records.
            const propertyDogs = dogs.filter(
              (d: any) => d.property_id === s.property_id && d.active !== false,
            ).length;
            const dogMismatch =
              s.account_type === "residential" &&
              s.dog_count != null &&
              s.dog_count !== propertyDogs;
            // QA follow-up 1.6: an active service with no upcoming visit must
            // say why and offer a way out.
            const startsLater = s.started_on && s.started_on > today;
            const noVisitReason =
              !ended && !paused && s.status === "active" && !nextVisit
                ? startsLater
                  ? `Starts ${s.started_on}; visits appear once it begins`
                  : s.frequency === "one_time"
                    ? "Its one-time visit is in the past"
                    : "Schedule hasn't been generated yet"
                : null;
            const canGenerate = noVisitReason != null && !startsLater && s.frequency !== "one_time";
            const showEnd = !ended && started;
            const showDelete = !started;
            return (
              <li key={s.id} className="rounded-lg border bg-card shadow-sm p-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div
                    className="min-w-0 flex-1 cursor-pointer"
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetailSub(s)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setDetailSub(s);
                      }
                    }}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">
                        {s.frequency === "one_time"
                          ? "One-time pet waste removal"
                          : "Recurring pet waste removal"}
                      </span>
                      {ended ? (
                        <StatusChip status="ended" />
                      ) : (
                        <StatusChip status={paused ? "paused" : s.status} />
                      )}
                      <MetaChip>
                        {s.billing_cadence === "prepaid" ? "Prepaid" : "Postpaid"}
                      </MetaChip>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {formatFrequency(s)}
                      {streetById.get(s.property_id) ? ` · ${streetById.get(s.property_id)}` : ""}
                      {" · "}
                      {s.account_type === "residential"
                        ? `${s.dog_count} dog${s.dog_count === 1 ? "" : "s"}`
                        : `${s.unit_count} unit${s.unit_count === 1 ? "" : "s"}`}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        {s.frequency === "one_time" ? "Visit on" : "Started"}{" "}
                        {formatDay(s.started_on)}
                        {s.ends_on
                          ? ` · ${ended ? "ended" : "ends"} ${formatDay(s.ends_on)}`
                          : ""}
                      </span>
                      {s.preferred_weekdays?.length ? (
                        <span>{s.preferred_weekdays.map((d: number) => WEEKDAYS[d]).join(" ")}</span>
                      ) : null}
                      {(s.earliest_time || s.latest_time) && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatWindow(s.earliest_time, s.latest_time)}
                        </span>
                      )}
                      {!ended && !paused && nextVisit && (
                        <span className="inline-flex items-center gap-1">
                          <CalendarClock className="h-3 w-3" />
                          Next visit {formatDay(nextVisit)}
                        </span>
                      )}
                      {ended && s.end_reason && <span>Reason: {s.end_reason}</span>}
                    </div>
                    {noVisitReason && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-300">
                        <span>No upcoming visit: {noVisitReason}.</span>
                        {canGenerate && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs"
                            onClick={() => generateMut.mutate()}
                            disabled={generateMut.isPending}
                          >
                            {generateMut.isPending ? "Scheduling…" : "Generate schedule"}
                          </Button>
                        )}
                      </div>
                    )}
                    {dogMismatch && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-300">
                        <span>
                          Bills for {s.dog_count} dog{s.dog_count === 1 ? "" : "s"}, but the
                          property has {propertyDogs} active dog record
                          {propertyDogs === 1 ? "" : "s"}.
                        </span>
                        {canManagePricing && propertyDogs > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs"
                            disabled={syncDogsMut.isPending}
                            onClick={() => syncDogsMut.mutate({ sub: s, count: propertyDogs })}
                          >
                            Use {propertyDogs} dog{propertyDogs === 1 ? "" : "s"}
                          </Button>
                        )}
                        {propertyDogs === 0 && <span>Add the dogs on the Properties tab.</span>}
                      </div>
                    )}
                  </div>

                  <div className="shrink-0 whitespace-nowrap text-right">
                    <span className="font-semibold">${(s.price_cents / 100).toFixed(2)}</span>
                    <span className="text-xs text-muted-foreground"> /visit</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {canBill && s.billing_cadence === "prepaid" && s.status === "active" && (
                      <PrepayInline
                        disabled={prepayMut.isPending}
                        onSubmit={(n: number) =>
                          prepayMut.mutate({ subscriptionId: s.id, visitCount: n })
                        }
                      />
                    )}
                    {canManagePricing && (
                      <Button size="sm" variant="outline" onClick={() => setDrawerSub(s)}>
                        Edit
                      </Button>
                    )}
                    {canManagePricing && !ended && s.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => pauseMut.mutate(s.id)}
                        disabled={pauseMut.isPending}
                      >
                        <Pause className="mr-1 h-3.5 w-3.5" /> Pause
                      </Button>
                    )}
                    {canManagePricing && paused && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => resumeMut.mutate(s.id)}
                        disabled={resumeMut.isPending}
                      >
                        <Play className="mr-1 h-3.5 w-3.5" /> Resume
                      </Button>
                    )}
                    {canManagePricing && (showEnd || showDelete) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" className="h-10 w-10 p-0" aria-label="More actions">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {showEnd && (
                            <DropdownMenuItem onSelect={() => setEndingSub(s)}>
                              <Square className="mr-2 h-3.5 w-3.5" /> End service…
                            </DropdownMenuItem>
                          )}
                          {showDelete && (
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              disabled={deleteMut.isPending}
                              onSelect={async () => {
                                if (
                                  await confirm({
                                    title: "Delete this service?",
                                    description:
                                      "Deleting is only allowed before the first visit happens and removes its scheduled visits. Started services are ended instead, keeping their history.",
                                    confirmLabel: "Delete service",
                                    destructive: true,
                                  })
                                )
                                  deleteMut.mutate(s.id);
                              }}
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete service…
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              </li>
            );
  };

  return (
    <div className="space-y-4">
      {confirmDialog}
      {canBill && <AddonRequestsPanel clientId={clientId} />}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {liveSubs.length} service{liveSubs.length === 1 ? "" : "s"}
        </h2>
        {properties.length > 0 && canManagePricing && (
          <Button size="sm" onClick={() => setDrawerSub("new")}>
            <Plus className="mr-1 h-4 w-4" /> Add Service
          </Button>
        )}
      </div>

      {liveSubs.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {properties.length === 0
            ? "Add a property first, then set up service."
            : endedSubs.length > 0
              ? "No active services. Past services are below."
              : "No services yet. Add one to start generating visits."}
        </div>
      ) : (
        <ul className="space-y-3">{liveSubs.map(renderServiceRow)}</ul>
      )}

      {endedSubs.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={showEnded}
            onClick={() => setShowEnded((v) => !v)}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {showEnded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Ended services ({endedSubs.length})
          </button>
          {showEnded && (
            <ul className="mt-3 space-y-3 opacity-80">{endedSubs.map(renderServiceRow)}</ul>
          )}
        </div>
      )}

      <ServiceDrawer
        open={drawerSub !== null}
        onClose={() => setDrawerSub(null)}
        clientId={clientId}
        client={client}
        properties={properties}
        zones={zones}
        dogs={dogs}
        subscription={drawerSub === "new" ? null : drawerSub}
        onSaved={invalidate}
      />

      <EndServiceDialog
        subscription={endingSub}
        onClose={() => setEndingSub(null)}
        onEnded={invalidate}
      />

      <ServiceDetailDrawer
        subscription={detailSub}
        onClose={() => setDetailSub(null)}
        properties={properties}
        zones={zones}
        visits={visits}
        canManagePricing={canManagePricing}
        onEdit={(sub: any) => {
          setDetailSub(null);
          setDrawerSub(sub);
        }}
      />
    </div>
  );
}

// ── Client portal add-on requests (QA round 8) ──────────────────────────────
// Portal requests are pending until staff approve (creates the real charge or
// subscription) or decline. Staff-added add-ons never appear here — they are
// billable immediately.

function AddonRequestsPanel({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listAddonRequests);
  const approveFn = useServerFn(approveAddonRequest);
  const declineFn = useServerFn(declineAddonRequest);
  const { data } = useQuery({
    queryKey: ["addon-requests", clientId],
    queryFn: () => listFn({ data: { clientId } }),
  });
  const requests: any[] = (data as any)?.requests ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["addon-requests", clientId] });
    qc.invalidateQueries({ queryKey: ["client-addons", clientId] });
    qc.invalidateQueries({ queryKey: ["client-activity", clientId] });
  };
  const approveMut = useMutation({
    mutationFn: (id: string) => approveFn({ data: { requestId: id } }),
    onSuccess: () => {
      toast.success("Request approved");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const declineMut = useMutation({
    mutationFn: (id: string) => declineFn({ data: { requestId: id } }),
    onSuccess: () => {
      toast.success("Request declined");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (requests.length === 0) return null;

  return (
    <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
      <h2 className="text-sm font-medium">
        Client requests from the portal ({requests.length})
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Nothing is billed until a request is approved.
      </p>
      <ul className="mt-2 space-y-2">
        {requests.map((r: any) => (
          <li
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm"
          >
            <div>
              <span className="font-medium">{r.addon_services?.name ?? "Add-on"}</span>
              <span className="text-muted-foreground">
                {" "}
                · ${((r.unit_price_cents * r.quantity) / 100).toFixed(2)}
                {r.kind === "recurring" ? ` ${String(r.frequency ?? "").replace(/_/g, " ")}` : " one time"}
                {r.quantity > 1 ? ` · qty ${r.quantity}` : ""}
                {r.properties?.street ? ` · ${r.properties.street}` : ""}
                {" · requested "}
                {formatDay(r.created_at)}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                onClick={() => approveMut.mutate(r.id)}
                disabled={approveMut.isPending || declineMut.isPending}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => declineMut.mutate(r.id)}
                disabled={approveMut.isPending || declineMut.isPending}
              >
                Decline
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Service detail drawer (QA follow-up 2.3): read-only depth on click ─────

function ServiceDetailDrawer({
  subscription: s,
  onClose,
  properties,
  zones,
  visits,
  canManagePricing,
  onEdit,
}: {
  subscription: any | null;
  onClose: () => void;
  properties: any[];
  zones: any[];
  visits: any[];
  canManagePricing: boolean;
  onEdit: (s: any) => void;
}) {
  if (!s) return null;
  const street = properties.find((p: any) => p.id === s.property_id)?.street;
  const zoneName = zones.find((z: any) => z.id === s.zone_id)?.name;
  const serviceVisits = visits
    .filter((v: any) => v.subscription_id === s.id)
    .sort((a: any, b: any) => (a.scheduled_on < b.scheduled_on ? 1 : -1))
    .slice(0, 12);

  return (
    <EditDrawer open={!!s} onClose={onClose} title="Service details" size="md">
      <div className="space-y-5 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          <div>
            <dt className="text-xs text-muted-foreground">Schedule</dt>
            <dd className="font-medium">{formatFrequency(s)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Price</dt>
            <dd className="font-medium">${(s.price_cents / 100).toFixed(2)} /visit</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Property</dt>
            <dd>{street ?? "-"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Pricing zone</dt>
            <dd>{zoneName ?? "None"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {s.account_type === "residential" ? "Dogs" : "Units"}
            </dt>
            <dd>{s.account_type === "residential" ? (s.dog_count ?? "-") : (s.unit_count ?? "-")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Billing</dt>
            <dd className="capitalize">{s.billing_cadence}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Arrival window</dt>
            <dd>{formatWindow(s.earliest_time, s.latest_time)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Started</dt>
            <dd>{s.started_on ? formatDay(s.started_on) : "-"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Ends</dt>
            <dd>{s.ends_on ? formatDay(s.ends_on) : "Open-ended"}</dd>
          </div>
          {s.end_reason && (
            <div className="col-span-2">
              <dt className="text-xs text-muted-foreground">End reason</dt>
              <dd>
                {s.end_reason}
                {s.end_notes ? ` (${s.end_notes})` : ""}
              </dd>
            </div>
          )}
        </dl>

        <div>
          <SectionLabel>Visit history for this service</SectionLabel>
          {serviceVisits.length === 0 ? (
            <p className="mt-1.5 text-muted-foreground">No visits yet.</p>
          ) : (
            <ul className="mt-1.5 divide-y">
              {serviceVisits.map((v: any) => (
                <li key={v.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span>{formatDay(v.scheduled_on)}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusChip status={v.status} />
                    {v.staff?.display_name ? ` ${v.staff.display_name}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DrawerFooter>
          {canManagePricing && (
            <Button type="button" onClick={() => onEdit(s)}>
              Edit service
            </Button>
          )}
        </DrawerFooter>
      </div>
    </EditDrawer>
  );
}

// ── Add / edit service drawer ───────────────────────────────────────────────

const SCHEDULE_CHOICES: Array<{ value: ScheduleChoice; label: string; hint: string }> = [
  { value: "weekly", label: "Weekly", hint: "Same day every week." },
  { value: "every_n_weeks", label: "Every N weeks", hint: "A fixed number of weeks between visits (every 4 weeks is not the same as monthly)." },
  { value: "twice_weekly", label: "Twice weekly", hint: "Two visits per week on chosen days." },
  { value: "monthly", label: "Monthly (calendar)", hint: "Repeats on the calendar date, e.g. the 15th of each month." },
  { value: "every_x_days", label: "Every X days", hint: "A fixed number of days between visits." },
  { value: "one_time", label: "One time", hint: "A single visit on the chosen date." },
];

function ServiceDrawer({
  open,
  onClose,
  clientId,
  client,
  properties,
  zones,
  dogs = [],
  subscription,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  client: any;
  properties: any[];
  zones: any[];
  dogs?: any[];
  subscription: any | null;
  onSaved: () => void;
}) {
  const createFn = useServerFn(createSubscription);
  const updateFn = useServerFn(updateSubscription);
  const { confirm: confirmPrice, dialog: priceDialog } = useConfirmDialog();

  // Property dogs are the source of truth for the billed count (UX round 3):
  // new services prefill from the property's active dog records, and picking
  // a different property refills the count.
  const activeDogsFor = (propertyId: string) =>
    dogs.filter((d: any) => d.property_id === propertyId && d.active !== false).length;

  const initial: SubscriptionFormValues & { choice: ScheduleChoice } = useMemo(() => {
    if (subscription) {
      return {
        ...subscriptionToFormValues(subscription),
        intervalWeeks:
          subscription.frequency === "biweekly"
            ? "2"
            : subscription.interval_weeks
              ? String(subscription.interval_weeks)
              : "",
        choice: scheduleChoiceFromRecord(subscription),
      };
    }
    const blank = { ...blankSubscriptionFormValues({ properties }), choice: "weekly" as ScheduleChoice };
    if (blank.propertyId) {
      const n = activeDogsFor(blank.propertyId);
      if (n > 0) blank.dogCount = String(n);
    }
    return blank;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscription, properties, dogs]);

  const [form, setForm] = useState(initial);
  // Reset only when the drawer transitions closed -> open; a background
  // refetch changing `initial`'s identity must not wipe in-progress edits.
  const wasOpen = useRef(false);
  const [showErrors, setShowErrors] = useState(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setForm(initial);
      setShowErrors(false);
    }
    wasOpen.current = open;
  }, [open, initial]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const accountType = (client?.account_type ?? "residential") as "residential" | "commercial";

  // Inline validation (QA follow-up 1.3): a blank price must be an error the
  // user can see, never a silent no-op or a $0.00 save.
  const priceValue = form.priceDollars.trim() === "" ? null : Number(form.priceDollars);
  const errors: Partial<Record<string, string>> = {};
  if (priceValue == null || !Number.isFinite(priceValue)) errors.price = "Price is required";
  else if (priceValue < 0) errors.price = "Price can't be negative";
  if (accountType === "residential") {
    const n = parseInt(form.dogCount, 10);
    if (!form.dogCount.trim() || !Number.isFinite(n) || n < 1)
      errors.dogCount = "At least 1 dog";
  } else {
    const n = parseInt(form.unitCount, 10);
    if (!form.unitCount.trim() || !Number.isFinite(n) || n < 1)
      errors.unitCount = "At least 1 unit";
  }
  if (form.choice === "every_n_weeks") {
    const n = parseInt(form.intervalWeeks || "2", 10);
    if (!Number.isFinite(n) || n < 2 || n > 26) errors.intervalWeeks = "Between 2 and 26 weeks";
  }
  if (form.choice === "every_x_days") {
    const n = parseInt(form.intervalDays || "", 10);
    if (!Number.isFinite(n) || n < 1 || n > 90) errors.intervalDays = "Between 1 and 90 days";
  }
  if (!form.propertyId) errors.propertyId = "Choose a property";
  if (form.earliestTime && form.latestTime && form.earliestTime >= form.latestTime)
    errors.window = "The earliest arrival must be before the latest arrival";
  const hasErrors = Object.keys(errors).length > 0;
  const fieldError = (k: string) => (showErrors && errors[k] ? errors[k] : null);

  // Pricing precedence (spec): Standard -> Zone -> Custom, always displayed,
  // never silently replaced. The buttons copy a computed price into the
  // price field; the user always sees what they're choosing.
  const stdFn = useServerFn(getStandardPricing);
  const { data: std } = useQuery({
    queryKey: ["std-pricing"],
    queryFn: () => stdFn(),
    enabled: open,
  });
  const dogsForPricing =
    accountType === "residential" ? Math.max(1, parseInt(form.dogCount, 10) || 1) : 1;
  const selectedProperty = properties.find((p: any) => p.id === form.propertyId);
  const pricingZone = zones.find(
    (z: any) => z.id === (form.zoneId || selectedProperty?.zone_id || ""),
  );
  // The wizard stores multiplied prices (org frequency_multipliers keyed by
  // stored frequency), so the comparison must use the same multiplier for
  // this schedule or "Use zone" would silently discount non-weekly services.
  const schedFields = scheduleChoiceToFields(form.choice, {
    intervalWeeks: form.intervalWeeks ? parseInt(form.intervalWeeks, 10) : undefined,
    intervalDays: form.intervalDays ? parseInt(form.intervalDays, 10) : undefined,
  });
  const freqMultiplier = Number(std?.frequencyMultipliers?.[schedFields.frequency] ?? 1) || 1;
  // Breakdown parts (QA follow-up 1.2): the owner must be able to derive the
  // zone price from the Zones page config, so show every component.
  const extraDogs = Math.max(0, dogsForPricing - 1);
  const stdParts =
    std?.basePriceCents != null
      ? {
          base: std.basePriceCents,
          dogAdj: extraDogs * (std.perDogAddlCents ?? 0),
          perDog: std.perDogAddlCents ?? 0,
        }
      : null;
  const standardCents = stdParts
    ? Math.round((stdParts.base + stdParts.dogAdj) * freqMultiplier)
    : null;
  const zonePrice = pricingZone
    ? computeZoneVisitPrice(
        {
          base_price_cents: pricingZone.base_price_cents,
          per_dog_addl_cents: pricingZone.per_dog_addl_cents,
          pricing_mode: (pricingZone.pricing_mode ?? "flat") as "flat" | "per_sqft" | "per_acre",
          price_per_sqft_cents: Number(pricingZone.price_per_sqft_cents ?? 0),
          price_per_acre_cents: pricingZone.price_per_acre_cents,
          area_min_charge_cents: pricingZone.area_min_charge_cents,
        },
        {
          dogCount: dogsForPricing,
          boundaryAreaSqm: selectedProperty?.boundary_area_sqm
            ? Number(selectedProperty.boundary_area_sqm)
            : null,
          multiplier: freqMultiplier,
        },
      )
    : null;
  const zoneParts = zonePrice
    ? {
        base: pricingZone.base_price_cents ?? 0,
        perDog: pricingZone.per_dog_addl_cents ?? 0,
        dogAdj: extraDogs * (pricingZone.per_dog_addl_cents ?? 0),
        areaCharge:
          zonePrice.perVisitCents -
          (pricingZone.base_price_cents ?? 0) -
          extraDogs * (pricingZone.per_dog_addl_cents ?? 0),
        perVisit: zonePrice.perVisitCents,
      }
    : null;
  const zoneCents = zonePrice ? zonePrice.recurringCents : null;
  const finalCents =
    priceValue != null && Number.isFinite(priceValue) ? Math.round(priceValue * 100) : null;
  const priceSource =
    finalCents != null && zoneCents != null && finalCents === zoneCents
      ? "zone"
      : finalCents != null && standardCents != null && finalCents === standardCents
        ? "standard"
        : finalCents != null
          ? "custom"
          : null;
  // QA follow-up 1.7: flag prices wildly off the zone/standard reference.
  const referenceCents = zoneCents ?? standardCents;
  const deviationPct =
    finalCents != null && referenceCents != null && referenceCents > 0
      ? Math.round(((finalCents - referenceCents) / referenceCents) * 100)
      : null;
  const bigDeviation = deviationPct != null && Math.abs(deviationPct) >= 50;
  const referenceName = zoneCents != null ? `${pricingZone?.name} zone` : "standard";

  const saveMut = useMutation({
    mutationFn: () => {
      const sched = scheduleChoiceToFields(form.choice, {
        intervalWeeks: form.intervalWeeks ? parseInt(form.intervalWeeks, 10) : undefined,
        intervalDays: form.intervalDays ? parseInt(form.intervalDays, 10) : undefined,
      });
      const common = {
        propertyId: form.propertyId,
        frequency: sched.frequency as any,
        intervalWeeks: sched.intervalWeeks,
        intervalDays: sched.intervalDays,
        priceCents: finalCents ?? 0,
        dogCount:
          accountType === "residential" ? Math.max(1, parseInt(form.dogCount, 10) || 1) : undefined,
        unitCount:
          accountType === "commercial" ? Math.max(1, parseInt(form.unitCount, 10) || 1) : undefined,
        zoneId: form.zoneId || undefined,
        billingCadence: form.billingCadence,
        startedOn: form.startedOn || undefined,
        endsOn: form.endsOn || null,
        preferredWeekdays: form.preferredWeekdays.length ? form.preferredWeekdays : undefined,
        earliestTime: form.earliestTime || null,
        latestTime: form.latestTime || null,
      };
      const run = subscription
        ? updateFn({ data: { subscriptionId: subscription.id, ...common } })
        : createFn({ data: { clientId, accountType, ...common } });
      return run.then(() => ({ ok: true }));
    },
    onSuccess: () => {
      toast.success(subscription ? "Service saved" : "Service added");
      onSaved();
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const choiceMeta = SCHEDULE_CHOICES.find((c) => c.value === form.choice)!;

  return (
    <EditDrawer
      open={open}
      onClose={onClose}
      title={subscription ? "Edit service" : "Add service"}
      size="md"
      dirty={dirty}
    >
      {priceDialog}
      <form
        className="space-y-4"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (hasErrors) {
            setShowErrors(true);
            return;
          }
          if (bigDeviation) {
            // Soft guardrail (QA follow-up 1.7): warn, never block.
            const keep = await confirmPrice({
              title: "Keep this price?",
              description: `$${((finalCents ?? 0) / 100).toFixed(2)} per visit is ${Math.abs(deviationPct!)}% ${deviationPct! < 0 ? "below" : "above"} the ${referenceName} price of $${((referenceCents ?? 0) / 100).toFixed(2)}.`,
              confirmLabel: "Keep price",
              cancelLabel: "Go back",
            });
            if (!keep) return;
          }
          saveMut.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Property</Label>
            <select
              value={form.propertyId}
              onChange={(e) => {
                const pid = e.target.value;
                const n = pid ? activeDogsFor(pid) : 0;
                setForm((f) => ({
                  ...f,
                  propertyId: pid,
                  // Refill from the property's dog records on switch.
                  ...(n > 0 && accountType === "residential" ? { dogCount: String(n) } : {}),
                }));
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              required
            >
              <option value="">Select…</option>
              {properties.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.street}
                </option>
              ))}
            </select>
            {fieldError("propertyId") && (
              <p className="mt-1 text-xs text-destructive">{fieldError("propertyId")}</p>
            )}
          </div>
          <div>
            <Label>Schedule</Label>
            <select
              value={form.choice}
              onChange={(e) => set("choice", e.target.value as ScheduleChoice)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {SCHEDULE_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">{choiceMeta.hint}</p>
          </div>
        </div>

        {form.choice === "every_n_weeks" && (
          <div>
            <Label htmlFor="sd-nweeks">Weeks between visits</Label>
            <Input
              id="sd-nweeks"
              type="number"
              min="2"
              max="26"
              className="w-32"
              value={form.intervalWeeks || "2"}
              onChange={(e) => set("intervalWeeks", e.target.value)}
              aria-invalid={!!fieldError("intervalWeeks")}
            />
            {fieldError("intervalWeeks") && (
              <p className="mt-1 text-xs text-destructive">{fieldError("intervalWeeks")}</p>
            )}
          </div>
        )}
        {form.choice === "every_x_days" && (
          <div>
            <Label htmlFor="sd-xdays">Days between visits</Label>
            <Input
              id="sd-xdays"
              type="number"
              min="1"
              max="90"
              className="w-32"
              value={form.intervalDays || "7"}
              onChange={(e) => set("intervalDays", e.target.value)}
              aria-invalid={!!fieldError("intervalDays")}
            />
            {fieldError("intervalDays") && (
              <p className="mt-1 text-xs text-destructive">{fieldError("intervalDays")}</p>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="sd-price">Price ($ per visit)</Label>
            <Input
              id="sd-price"
              type="number"
              min="0"
              step="0.01"
              value={form.priceDollars}
              onChange={(e) => set("priceDollars", e.target.value)}
              aria-invalid={!!fieldError("price")}
              className={fieldError("price") ? "border-destructive" : undefined}
            />
            {fieldError("price") && (
              <p className="mt-1 text-xs text-destructive">{fieldError("price")}</p>
            )}
          </div>
          {accountType === "residential" ? (
            <div>
              <Label htmlFor="sd-dogs">Dogs</Label>
              <Input
                id="sd-dogs"
                type="number"
                min="1"
                value={form.dogCount}
                onChange={(e) => set("dogCount", e.target.value)}
                aria-invalid={!!fieldError("dogCount")}
              />
              {fieldError("dogCount") && (
                <p className="mt-1 text-xs text-destructive">{fieldError("dogCount")}</p>
              )}
            </div>
          ) : (
            <div>
              <Label htmlFor="sd-units">Units</Label>
              <Input
                id="sd-units"
                type="number"
                min="1"
                value={form.unitCount}
                onChange={(e) => set("unitCount", e.target.value)}
                aria-invalid={!!fieldError("unitCount")}
              />
              {fieldError("unitCount") && (
                <p className="mt-1 text-xs text-destructive">{fieldError("unitCount")}</p>
              )}
            </div>
          )}
          <div>
            <Label>Billing</Label>
            <select
              value={form.billingCadence}
              onChange={(e) => set("billingCadence", e.target.value as "postpaid" | "prepaid")}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="postpaid">Postpaid</option>
              <option value="prepaid">Prepaid</option>
            </select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <DateField
            label={form.choice === "one_time" ? "Visit date" : "Start date"}
            value={form.startedOn}
            onChange={(v) => set("startedOn", v)}
            hint={
              form.choice === "one_time"
                ? "The day of the single visit."
                : "The first day service applies."
            }
          />
          {form.choice !== "one_time" && (
            <DateField
              label="End date"
              value={form.endsOn}
              onChange={(v) => set("endsOn", v)}
              clearable
              clearLabel="Open-ended"
              minISO={form.startedOn || undefined}
              hint="Leave open-ended unless the service has a known last day."
            />
          )}
        </div>

        <div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TimeField
              label="Earliest arrival"
              value={form.earliestTime}
              onChange={(v) => set("earliestTime", v)}
            />
            <TimeField
              label="Latest arrival"
              value={form.latestTime}
              onChange={(v) => set("latestTime", v)}
            />
          </div>
          {fieldError("window") ? (
            <p className="mt-1 text-xs text-destructive">{fieldError("window")}</p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              The arrival window for this service's visits. Leave as anytime if the client has no
              preference.
            </p>
          )}
        </div>

        <div>
          <Label>Zone (pricing)</Label>
          <select
            value={form.zoneId}
            onChange={(e) => set("zoneId", e.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">-</option>
            {zones.map((z: any) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </div>

        {(standardCents != null || zoneCents != null) && (
          <div className="rounded-md border bg-muted/20 p-3 text-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Price comparison (per visit at this schedule)
            </div>
            <dl className="mt-2 space-y-1">
              {zoneParts && zoneCents != null && (
                <>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <dt>{pricingZone?.name} zone base</dt>
                    <dd>${(zoneParts.base / 100).toFixed(2)}</dd>
                  </div>
                  {zoneParts.dogAdj > 0 && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <dt>
                        Extra dogs ({extraDogs} × ${(zoneParts.perDog / 100).toFixed(2)})
                      </dt>
                      <dd>+${(zoneParts.dogAdj / 100).toFixed(2)}</dd>
                    </div>
                  )}
                  {zoneParts.areaCharge > 0 && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <dt>Yard area charge</dt>
                      <dd>+${(zoneParts.areaCharge / 100).toFixed(2)}</dd>
                    </div>
                  )}
                  {freqMultiplier !== 1 && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <dt>
                        Schedule adjustment (${(zoneParts.perVisit / 100).toFixed(2)} ×{" "}
                        {freqMultiplier})
                      </dt>
                      <dd>+${((zoneCents - zoneParts.perVisit) / 100).toFixed(2)}</dd>
                    </div>
                  )}
                  <div className="flex items-center justify-between border-t pt-1">
                    <dt className="text-muted-foreground">{pricingZone?.name} zone price</dt>
                    <dd className="flex items-center gap-2">
                      ${(zoneCents / 100).toFixed(2)}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs"
                        onClick={() => set("priceDollars", (zoneCents / 100).toFixed(2))}
                      >
                        Use zone
                      </Button>
                    </dd>
                  </div>
                </>
              )}
              {stdParts && standardCents != null && (
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">
                    Standard price
                    <span className="ml-1 text-xs">
                      (${(stdParts.base / 100).toFixed(2)}
                      {stdParts.dogAdj > 0
                        ? ` + ${extraDogs} × $${(stdParts.perDog / 100).toFixed(2)}`
                        : ""}
                      {freqMultiplier !== 1 ? ` × ${freqMultiplier}` : ""})
                    </span>
                  </dt>
                  <dd className="flex items-center gap-2">
                    ${(standardCents / 100).toFixed(2)}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      onClick={() => set("priceDollars", (standardCents / 100).toFixed(2))}
                    >
                      Use standard
                    </Button>
                  </dd>
                </div>
              )}
              {standardCents != null && zoneCents != null && (
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Difference (zone vs standard)</dt>
                  <dd className={zoneCents - standardCents > 0 ? "text-destructive" : "text-primary"}>
                    {zoneCents - standardCents >= 0 ? "+" : "−"}$
                    {(Math.abs(zoneCents - standardCents) / 100).toFixed(2)}
                  </dd>
                </div>
              )}
              <div className="flex items-center justify-between border-t pt-1">
                <dt className="font-medium">Final price</dt>
                <dd className="flex items-center gap-2 font-medium">
                  {finalCents != null ? `$${(finalCents / 100).toFixed(2)}` : "—"}
                  {priceSource && (
                    <Badge variant={priceSource === "custom" ? "outline" : "secondary"} className="text-[10px]">
                      {priceSource === "zone"
                        ? "Zone"
                        : priceSource === "standard"
                          ? "Standard"
                          : "Custom"}
                    </Badge>
                  )}
                </dd>
              </div>
            </dl>
            {bigDeviation && (
              <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300">
                This price is {Math.abs(deviationPct!)}% {deviationPct! < 0 ? "below" : "above"} the{" "}
                {referenceName} price. You'll be asked to confirm on save.
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Changing this price never touches invoices that were already issued.
            </p>
          </div>
        )}

        {form.choice !== "one_time" && form.choice !== "monthly" && (
          <div>
            <Label>Preferred weekdays (optional)</Label>
            <div className="mt-1 flex flex-wrap gap-2">
              {WEEKDAYS.map((d, i) => {
                const on = form.preferredWeekdays.includes(i);
                return (
                  <button
                    key={i}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set(
                        "preferredWeekdays",
                        on
                          ? form.preferredWeekdays.filter((x) => x !== i)
                          : [...form.preferredWeekdays, i].sort(),
                      )
                    }
                    className={`rounded-md border px-3 py-1 text-xs ${on ? "border-primary bg-primary text-primary-foreground" : "bg-background"}`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {form.choice === "twice_weekly"
                ? "Twice-weekly needs two days (e.g. Mon + Thu)."
                : "Visits land on the first selected day."}
            </p>
          </div>
        )}

        <DrawerFooter>
          <Button type="submit" disabled={saveMut.isPending}>
            {saveMut.isPending ? "Saving…" : subscription ? "Save changes" : "Add service"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}

// ── End service dialog (drawer, small) ──────────────────────────────────────

function EndServiceDialog({
  subscription,
  onClose,
  onEnded,
}: {
  subscription: any | null;
  onClose: () => void;
  onEnded: () => void;
}) {
  const endFn = useServerFn(endSubscription);
  const [effectiveDate, setEffectiveDate] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (subscription) {
      setEffectiveDate(todayISO());
      setReason("");
      setNotes("");
    }
  }, [subscription]);

  const mut = useMutation({
    mutationFn: () =>
      endFn({
        data: {
          subscriptionId: subscription.id,
          effectiveDate,
          reason: reason.trim(),
          notes: notes.trim() || undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Service ended");
      onEnded();
      onClose();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <EditDrawer
      open={!!subscription}
      onClose={onClose}
      title="End service"
      description="Ended services keep their history. Scheduled visits after the effective date are removed."
      size="sm"
      dirty={!!reason || !!notes}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          mut.mutate();
        }}
      >
        <DateField
          label="Effective date"
          value={effectiveDate}
          onChange={setEffectiveDate}
          hint="The last day service applies. Future visits past it are removed automatically."
        />
        <div>
          <Label htmlFor="end-reason">Reason</Label>
          <Input
            id="end-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Moving, cost, seasonal…"
            required
          />
        </div>
        <div>
          <Label htmlFor="end-notes">Notes (optional)</Label>
          <Textarea id="end-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <DrawerFooter>
          <Button type="submit" variant="destructive" disabled={mut.isPending || !reason.trim()}>
            {mut.isPending ? "Ending…" : "End service"}
          </Button>
        </DrawerFooter>
      </form>
    </EditDrawer>
  );
}
