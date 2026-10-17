// Services tab (spec: subscriptions are "Services" in the UI). Read-only
// rows with lifecycle actions — edit in a drawer, pause/resume, end with an
// effective date + reason, delete only when the service never started. The
// creation form stays hidden until "Add Service".
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
import { useOrgToday } from "@/hooks/useOrgToday";
import { MetaChip, SectionLabel, StatusChip } from "@/components/client-detail/primitives";
import { TrainingPackagesSection } from "@/components/clients/TrainingPackagesSection";
import {
  createSubscription,
  updateSubscription,
  pauseSubscription,
  resumeSubscription,
  endSubscription,
  deleteDraftSubscription,
  getStandardPricing,
} from "@/lib/subscriptions.functions";
import {
  computeZoneVisitPrice,
  computeCommercialZonePrice,
  zoneHasCommercialPricing,
} from "@/lib/pricing";
import { describePriceProvenance } from "@/lib/price-provenance";
import {
  subscriptionToFormValues,
  blankSubscriptionFormValues,
  scheduleChoiceFromRecord,
  scheduleChoiceToFields,
  formatFrequency,
  isServiceEnded,
  serviceScheduleState,
  type ScheduleChoice,
  type SubscriptionFormValues,
} from "@/lib/subscription-form";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { PrepayInline } from "@/components/client-detail/billing-panels";
import {
  listAddonRequests,
  listClientAddons,
  approveAddonRequest,
  declineAddonRequest,
} from "@/lib/addons.functions";
import { listClientActivity } from "@/lib/activity.functions";
import { activityChanges } from "@/lib/activity-diff";
import { generatePrepaidInvoice } from "@/lib/invoices.functions";
import { generateVisits } from "@/lib/visits.functions";
import { listStations } from "@/lib/stations.functions";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { getQuote, markQuoteConverted } from "@/lib/quotes.functions";
import { formatQuoteMoney, quoteConversion } from "@/lib/quotes";
import { humanizeEnum } from "@/lib/humanize";
import { CHURN_REASONS } from "@/lib/churn-reasons";
import { planTitle } from "@/lib/visit-service";
import {
  ServicePicker,
  effectiveServiceId,
  useOrgServices,
} from "@/components/client-detail/ServicePicker";
import { WeekdayPicker } from "@/components/client-detail/WeekdayPicker";
import { WORK_WEEK, normalizeWeekdays, offersSetDays } from "@/lib/weekday-set";
import { servicePriceCents } from "@/lib/services";
import { useIntlLocale } from "@/lib/i18n";
import { createWalkPlans } from "@/lib/walk-plans.functions";
import { walkWindowsProblem, type WalkWindow } from "@/lib/subscription-form";
import { isDog } from "@/lib/pets";
import { StaysSection } from "@/components/client-detail/StaysSection";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];


export function ServicesTab({
  clientId,
  client,
  properties,
  subscriptions: allSubscriptions,
  zones,
  visits,
  dogs: pets,
  canBill,
  canManagePricing,
  editServiceId,
  onEditServiceConsumed,
  newServiceFromQuoteId,
  onNewServiceFromQuoteConsumed,
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
  /** Deep-linked ?editService=<subscriptionId> (already stripped from the URL
   * by the route): opens the edit drawer once the subscription is loaded. */
  editServiceId?: string | null;
  onEditServiceConsumed?: () => void;
  /** Deep-linked ?fromQuote=<quoteId> ("Convert to work" on an accepted
   * quote): opens Add service with the quote's per-visit price filled in. */
  newServiceFromQuoteId?: string | null;
  onNewServiceFromQuoteConsumed?: () => void;
}) {
  const qc = useQueryClient();
  const today = useOrgToday();
  // A stay's plans (#411) are listed with their stay under Stays, not as
  // services of their own; and every dog count here counts dogs, not a
  // sitting client's cat.
  const subscriptions = useMemo(
    () => allSubscriptions.filter((s: any) => !s.stay_id),
    [allSubscriptions],
  );
  const dogs = useMemo(() => pets.filter((p: any) => isDog(p)), [pets]);
  // The formatters' locale, so a set-days plan reads "Mon–Fri" in the
  // interface language.
  const locale = useIntlLocale();
  const navigate = useNavigate();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [drawerSub, setDrawerSub] = useState<any | null | "new">(null);
  const [endingSub, setEndingSub] = useState<any | null>(null);
  const [detailSub, setDetailSub] = useState<any | null>(null);

  // Consume the ?editService deep link once the subscription list contains
  // the id (the drawer needs the full row). An unknown id is never consumed.
  useEffect(() => {
    if (!editServiceId) return;
    const sub = subscriptions.find((s: any) => s.id === editServiceId);
    if (sub) {
      setDrawerSub(sub);
      onEditServiceConsumed?.();
    }
  }, [editServiceId, subscriptions]); // eslint-disable-line react-hooks/exhaustive-deps

  // An accepted quote being turned into work. The quote is read for its
  // per-visit price, the drawer opens on a new service with that price in it,
  // and the quote is marked converted when the service saves. Nothing is
  // written by arriving here: the drawer is the confirmation.
  const [fromQuote, setFromQuote] = useState<ServiceFromQuote | null>(null);
  const getQuoteFn = useServerFn(getQuote);
  const quoteQ = useQuery({
    queryKey: ["quote", newServiceFromQuoteId],
    queryFn: () => getQuoteFn({ data: { id: newServiceFromQuoteId! } }),
    enabled: !!newServiceFromQuoteId,
    staleTime: 0,
    retry: false,
  });
  useEffect(() => {
    if (!newServiceFromQuoteId) return;
    if (quoteQ.isError) {
      toast.error((quoteQ.error as Error).message || "That quote could not be loaded.");
      onNewServiceFromQuoteConsumed?.();
      return;
    }
    if (!quoteQ.data) return;
    const { quote, lines } = quoteQ.data;
    onNewServiceFromQuoteConsumed?.();
    if (quote.clientId !== clientId || quote.status !== "accepted" || quote.convertedAt) {
      toast.error(
        quote.convertedAt
          ? `${quote.label} has already been turned into work.`
          : `${quote.label} is not an accepted quote for this client.`,
      );
      return;
    }
    setFromQuote({ quoteId: quote.id, label: quote.label, ...quoteConversion(lines) });
    setDrawerSub("new");
  }, [newServiceFromQuoteId, quoteQ.data, quoteQ.isError]); // eslint-disable-line react-hooks/exhaustive-deps

  // The list's Edit button goes through the URL (?editService=<id>, the
  // ?edit=true pattern) so an edit is deep-linkable/shareable; the route
  // strips the param and hands it back via editServiceId.
  const openEditViaUrl = (subscriptionId: string) =>
    navigate({
      to: "/clients/$clientId",
      params: { clientId },
      search: { tab: "services", editService: subscriptionId } as any,
    });

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
      // 60 days out from the ORG's today, not the device's. Noon anchor so
      // toISOString's UTC rendering stays on the same date at every offset.
      const d = new Date(`${today}T12:00:00`);
      d.setDate(d.getDate() + 60);
      const through = d.toISOString().slice(0, 10);
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

  /**
   * Point a service at its property's zone.
   *
   * Deliberately carries `price_cents` through unchanged. The zone is what
   * EXPLAINS a price, not what silently sets it — re-pricing here would change
   * what a customer is billed as a side effect of correcting a record, and the
   * owner has a price field and a "Use zone" button for when they mean it.
   */
  const syncZoneFn = useServerFn(updateSubscription);
  const syncZoneMut = useMutation({
    mutationFn: (v: { sub: any; zoneId: string | null }) =>
      syncZoneFn({
        data: {
          subscriptionId: v.sub.id,
          propertyId: v.sub.property_id,
          frequency: v.sub.frequency,
          intervalWeeks: v.sub.interval_weeks ?? undefined,
          intervalDays: v.sub.interval_days ?? undefined,
          priceCents: v.sub.price_cents,
          dogCount: v.sub.dog_count ?? undefined,
          zoneId: v.zoneId ?? undefined,
          billingCadence: v.sub.billing_cadence ?? undefined,
          startedOn: v.sub.started_on ?? undefined,
          endsOn: v.sub.ends_on ?? null,
          preferredWeekdays: v.sub.preferred_weekdays ?? undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Pricing zone synced from the property. The price is unchanged.");
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
            // The same question about the zone, which nothing was asking. A
            // service's zone sets its price; the property's zone is where that
            // zone comes from. They drifted two ways — a service saved with no
            // zone at all after being priced from the property's, and a
            // service moved to another property keeping the first one's zone —
            // and both are fixed at the source now. This catches the rows that
            // drifted before that, and any future cause, which is the half a
            // form fix cannot reach.
            const propertyZoneId =
              (properties.find((p: any) => p.id === s.property_id)?.zone_id as string | null) ??
              null;
            const zoneMismatch = !!propertyZoneId && s.zone_id !== propertyZoneId;
            const propertyZoneName = zones.find((z: any) => z.id === propertyZoneId)?.name;
            // QA follow-up 1.6: an active service with no upcoming visit must
            // say why and offer a way out.
            const startsLater = s.started_on && s.started_on > today;
            // Moved to lib/subscription-form so it can be tested: this was
            // inline and wrong in the case that mattered — see
            // serviceScheduleState's header.
            const { reason: noVisitReason, canGenerate } = serviceScheduleState(s, {
              today,
              nextVisit,
              ended,
              paused,
            });
            const showEnd = !ended && started;
            const showDelete = !started;
            return (
              <li key={s.id} className="@container rounded-lg border bg-card shadow-sm p-4 text-sm">
                {/* THREE ITEMS, ONE WRAPPING ROW: the details, the price, the
                    actions. The details were `flex-1` with no basis, and a
                    basis of 0 always fits on the first line — so the row never
                    wrapped, and the details got whatever the price and three
                    buttons left over. On the owner's iPhone that was about
                    80px: the title ran into "$33.00", the meta line went one
                    word per line, and the amber dog-count warning was
                    narrower than its own words.
                    Now the details take the full width until the CARD is 48rem
                    wide (the price moves into the title row, the actions to a
                    row of their own), and from there they ask for 18rem before
                    the actions will share a line with them.
                    The card's width and not the screen's, because the column
                    beside the sidebar decides it: at 768px the office sidebar
                    became a 60px rail, the card grew to 660px, and a viewport
                    `sm:` let all three share one line again with the details
                    at 342px, a long street wrapping the meta line. */}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div
                    className="min-w-0 flex-1 basis-full cursor-pointer @3xl:basis-72"
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
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 break-words font-semibold">
                          {planTitle(s.frequency, s.services)}
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
                      {/* The narrow card's price: beside the title it belongs
                          to. The one after this block takes over once the
                          card is 48rem wide; `hidden` is display:none, so a
                          screen reader hears one price, not two. */}
                      <div className="shrink-0 whitespace-nowrap text-right @3xl:hidden">
                        <span className="font-semibold">${(s.price_cents / 100).toFixed(2)}</span>
                        <span className="text-xs text-muted-foreground"> /visit</span>
                      </div>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {formatFrequency(s, locale)}
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
                          <Clock className="h-3 w-3 shrink-0" />
                          {formatWindow(s.earliest_time, s.latest_time)}
                        </span>
                      )}
                      {!ended && !paused && nextVisit && (
                        <span className="inline-flex items-center gap-1">
                          <CalendarClock className="h-3 w-3 shrink-0" />
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
                    {zoneMismatch && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-800 dark:text-amber-300">
                        <span>
                          {s.zone_id
                            ? `Priced from a different zone than this property's (${propertyZoneName ?? "unnamed"}).`
                            : `No pricing zone recorded, but this property is in ${propertyZoneName ?? "a zone"}.`}
                        </span>
                        {canManagePricing && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs touch:min-h-11"
                            disabled={syncZoneMut.isPending}
                            onClick={() => syncZoneMut.mutate({ sub: s, zoneId: propertyZoneId })}
                          >
                            Use {propertyZoneName ?? "the property's zone"}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="shrink-0 whitespace-nowrap text-right @max-3xl:hidden">
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
                      <Button size="sm" variant="outline" onClick={() => openEditViaUrl(s.id)}>
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
                        <Pause className="mr-1 h-3.5 w-3.5 shrink-0" /> Pause
                      </Button>
                    )}
                    {canManagePricing && paused && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => resumeMut.mutate(s.id)}
                        disabled={resumeMut.isPending}
                      >
                        <Play className="mr-1 h-3.5 w-3.5 shrink-0" /> Resume
                      </Button>
                    )}
                    {canManagePricing && (showEnd || showDelete) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          {/* size="icon": 40px wide was under the 44px touch
                              floor that size carries in both axes. */}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10 p-0"
                            aria-label="More actions"
                          >
                            <MoreHorizontal className="h-4 w-4 shrink-0" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {showEnd && (
                            <DropdownMenuItem onSelect={() => setEndingSub(s)}>
                              <Square className="mr-2 h-3.5 w-3.5 shrink-0" /> End service…
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
                              <Trash2 className="mr-2 h-3.5 w-3.5 shrink-0" /> Delete service…
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
      <TrainingPackagesSection clientId={clientId} />
      {canBill && <AddonRequestsPanel clientId={clientId} />}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {liveSubs.length} service{liveSubs.length === 1 ? "" : "s"}
        </h2>
        {properties.length > 0 && canManagePricing && (
          <Button size="sm" onClick={() => setDrawerSub("new")}>
            <Plus className="mr-1 h-4 w-4 shrink-0" /> Add Service
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
              <ChevronDown className="h-4 w-4 shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0" />
            )}
            Ended services ({endedSubs.length})
          </button>
          {showEnded && (
            <ul className="mt-3 space-y-3 opacity-80">{endedSubs.map(renderServiceRow)}</ul>
          )}
        </div>
      )}

      <StaysSection
        clientId={clientId}
        client={client}
        properties={properties}
        pets={pets}
        canManagePricing={canManagePricing}
      />

      <ServiceDrawer
        open={drawerSub !== null}
        onClose={() => {
          setDrawerSub(null);
          setFromQuote(null);
        }}
        clientId={clientId}
        client={client}
        properties={properties}
        zones={zones}
        dogs={dogs}
        subscription={drawerSub === "new" ? null : drawerSub}
        fromQuote={drawerSub === "new" ? fromQuote : null}
        onSaved={() => {
          invalidate();
          qc.invalidateQueries({ queryKey: ["quotes"] });
        }}
      />

      <EndServiceDialog
        subscription={endingSub}
        onClose={() => setEndingSub(null)}
        onEnded={invalidate}
      />

      <ServiceDetailDrawer
        subscription={detailSub}
        clientId={clientId}
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

/**
 * What this service has cost over time.
 *
 * The drawer showed today's price and nothing about how it got there, on the
 * screen an owner opens when a customer asks why their bill changed. The
 * history was already being written: `updateSubscription` and the total-units
 * propagation in `properties.functions.ts` both log a `service.price_changed`
 * entry with a before/after in `meta`, and nothing read it.
 *
 * Scoped by `subscriptionId` server-side rather than filtered here, so a price
 * change from two years ago is not lost behind fifty unrelated client edits
 * that happen to be newer.
 */
function ServicePricingHistory({
  clientId,
  subscriptionId,
}: {
  clientId: string;
  subscriptionId: string;
}) {
  const listFn = useServerFn(listClientActivity);
  const { data, isLoading } = useQuery({
    queryKey: ["service-activity", clientId, subscriptionId],
    queryFn: () => listFn({ data: { clientId, subscriptionId, limit: 50 } }),
  });
  const entries = (data?.entries ?? []).filter((e: any) => (e.kind ?? "").startsWith("service."));

  if (isLoading || entries.length === 0) return null;

  return (
    <div>
      <SectionLabel>Price &amp; schedule history</SectionLabel>
      <ul className="mt-1.5 divide-y">
        {entries.map((e: any) => {
          const changes = activityChanges(e.meta, e.kind);
          return (
            <li key={e.id} className="py-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="min-w-0">{e.summary}</span>
                <span className="text-xs text-muted-foreground">
                  {formatDay(e.created_at)}
                  {e.actor_label ? ` · ${e.actor_label}` : ""}
                </span>
              </div>
              {changes.length > 0 && (
                <ul className="mt-0.5 text-xs">
                  {changes.map((c) => (
                    <li key={c.field} className="flex flex-wrap gap-x-1.5">
                      <span className="text-muted-foreground">{c.label}</span>
                      <span className="line-through opacity-60">{c.before}</span>
                      <span className="font-medium">{c.after}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Add-ons billed on this service's visits.
 *
 * `addon_charges` has no subscription column — it carries `visit_id`, and a
 * visit carries the subscription. That hop is the only exact link between a
 * charge and a service, so it is the one used: matching on `property_id`
 * instead would sweep in charges from a second service at the same address,
 * which is a real configuration (two frequencies on one property).
 *
 * Behind the billing permission, like every other money figure on this tab.
 */
function ServiceAddonCharges({
  clientId,
  visitIds,
  canSeeBilling,
}: {
  clientId: string;
  visitIds: string[];
  canSeeBilling: boolean;
}) {
  const listFn = useServerFn(listClientAddons);
  const { data } = useQuery({
    queryKey: ["client-addons", clientId],
    queryFn: () => listFn({ data: { clientId } }),
    enabled: canSeeBilling && visitIds.length > 0,
  });

  if (!canSeeBilling) return null;
  const ids = new Set(visitIds);
  const charges = ((data as any)?.charges ?? []).filter(
    (c: any) => c.visit_id && ids.has(c.visit_id) && c.status !== "void",
  );
  if (charges.length === 0) return null;

  const total = charges.reduce((sum: number, c: any) => sum + Number(c.amount_cents ?? 0), 0);

  return (
    <div>
      <SectionLabel>Add-ons billed on this service</SectionLabel>
      <ul className="mt-1.5 divide-y">
        {charges.map((c: any) => (
          <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-2 py-1.5">
            <span className="min-w-0">
              {c.addon_services?.name ?? c.description}
              {c.quantity > 1 ? ` ×${c.quantity}` : ""}
            </span>
            <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
              <span>{formatDay(c.occurred_on)}</span>
              {/* "Invoiced" and "paid" are different answers to "was this ever
                  billed", and listClientAddons resolves both. */}
              <span>
                {c.billed_invoice_id
                  ? c.billed_invoice_status === "paid"
                    ? "Paid"
                    : "Invoiced"
                  : "Not yet invoiced"}
              </span>
              <span className="font-medium text-foreground">
                ${(Number(c.amount_cents) / 100).toFixed(2)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {charges.length} charge{charges.length === 1 ? "" : "s"} · ${(total / 100).toFixed(2)} on
        top of the per-visit price.
      </p>
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
  clientId,
  onClose,
  properties,
  zones,
  visits,
  canManagePricing,
  onEdit,
}: {
  subscription: any | null;
  clientId: string;
  onClose: () => void;
  properties: any[];
  zones: any[];
  visits: any[];
  canManagePricing: boolean;
  onEdit: (s: any) => void;
}) {
  const locale = useIntlLocale();
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
            <dd className="font-medium">{formatFrequency(s, locale)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Price</dt>
            <dd className="font-medium">${(s.price_cents / 100).toFixed(2)} /visit</dd>
            {/* Where the number came from. A price with no provenance says so
                rather than being read as "priced from the zone it sits in",
                which is the assumption that made a stale rate invisible. */}
            <dd className="text-xs text-muted-foreground">
              {describePriceProvenance(s, (id) => zones.find((z: any) => z.id === id)?.name).text}
            </dd>
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
            {/* BUG-4: `capitalize` only uppercases the first letter, so a
                snake_case cadence still reached the user as "Per_visit". */}
            <dd>{humanizeEnum(s.billing_cadence)}</dd>
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

        {/* What this service has cost over time, and what was billed on top of
            it. The drawer showed today's price and nothing about how it got
            there — on the screen an owner opens when a customer asks why their
            bill changed. Both were recorded all along: price changes land in
            activity_log as `service.price_changed` with a before/after, and
            add-on charges carry the visit they were taken on. */}
        <ServicePricingHistory clientId={clientId} subscriptionId={s.id} />
        <ServiceAddonCharges
          clientId={clientId}
          visitIds={visits.filter((v: any) => v.subscription_id === s.id).map((v: any) => v.id)}
          canSeeBilling={canManagePricing}
        />

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
  { value: "set_days", label: "Set days each week", hint: "One visit on each chosen day, every week (Mon–Fri, or Mon, Wed, Fri)." },
  { value: "monthly", label: "Monthly (calendar)", hint: "Repeats on the calendar date, e.g. the 15th of each month." },
  { value: "every_x_days", label: "Every X days", hint: "A fixed number of days between visits." },
  { value: "one_time", label: "One time", hint: "A single visit on the chosen date." },
];

type ServiceFromQuote = {
  quoteId: string;
  label: string;
  /** Every recurring line on the quote, per visit. null: none, so ask. */
  priceCents: number | null;
  oneTimeCents: number;
};

function ServiceDrawer({
  open,
  onClose,
  clientId,
  client,
  properties,
  zones,
  dogs = [],
  subscription,
  fromQuote = null,
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
  /** A new service started from an accepted quote. */
  fromQuote?: ServiceFromQuote | null;
  onSaved: () => void;
}) {
  const createFn = useServerFn(createSubscription);
  const createWalksFn = useServerFn(createWalkPlans);
  const convertedFn = useServerFn(markQuoteConverted);
  const updateFn = useServerFn(updateSubscription);
  const stationsFn = useServerFn(listStations);
  const { confirm: confirmPrice, dialog: priceDialog } = useConfirmDialog();
  // The org's today, for the form's date defaults. FOUR components in this
  // file ask what day it is; this one cannot borrow ServicesTab's, the same
  // way VisitsTab's siblings each needed their own tz.
  const today = useOrgToday();

  // Property dogs are the source of truth for the billed count (UX round 3):
  // new services prefill from the property's active dog records, and picking
  // a different property refills the count.
  const activeDogsFor = (propertyId: string) =>
    dogs.filter((d: any) => d.property_id === propertyId && d.active !== false).length;

  // What the plan sells. "" until the person picks: the picker shows the
  // business's pet waste removal, and Save sends whatever it shows.
  const { services: orgServices, isLoading: servicesLoading } = useOrgServices(open);

  const initial: SubscriptionFormValues & { choice: ScheduleChoice; serviceId: string } = useMemo(() => {
    if (subscription) {
      return {
        ...subscriptionToFormValues(subscription, today),
        serviceId: (subscription.service_id as string | null) ?? "",
        intervalWeeks:
          subscription.frequency === "biweekly"
            ? "2"
            : subscription.interval_weeks
              ? String(subscription.interval_weeks)
              : "",
        choice: scheduleChoiceFromRecord(subscription),
      };
    }
    const blank = {
      ...blankSubscriptionFormValues({ properties, today }),
      choice: "weekly" as ScheduleChoice,
      serviceId: "",
    };
    if (blank.propertyId) {
      const n = activeDogsFor(blank.propertyId);
      if (n > 0) blank.dogCount = String(n);
    }
    // The price the customer accepted, not the zone's: the quote is what they
    // said yes to.
    if (fromQuote?.priceCents != null) blank.priceDollars = (fromQuote.priceCents / 100).toFixed(2);
    return blank;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscription, properties, dogs, fromQuote]);

  const [form, setForm] = useState(initial);
  const [extraWalkWindows, setExtraWalkWindows] = useState<WalkWindow[]>([]);
  // Reset only when the drawer transitions closed -> open; a background
  // refetch changing `initial`'s identity must not wipe in-progress edits.
  const wasOpen = useRef(false);
  const [showErrors, setShowErrors] = useState(false);
  // A scooper's plan offers "Set days each week" once the business turns it
  // on here (offersSetDays); a walk, a sit or a groom always offers it.
  const [setDaysOn, setSetDaysOn] = useState(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setForm(initial);
      setExtraWalkWindows([]);
      setShowErrors(false);
      setSetDaysOn(false);
    }
    wasOpen.current = open;
  }, [open, initial]);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || extraWalkWindows.length > 0;
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const accountType = (client?.account_type ?? "residential") as "residential" | "commercial";

  // The formatters' locale, for the weekday chips' names.
  const locale = useIntlLocale();
  // What the plan sells, as the picker shows it (its default until chosen).
  const chosenService =
    orgServices.find((x) => x.id === effectiveServiceId(form.serviceId, orgServices)) ?? null;
  const creatingWalk = !subscription && chosenService?.service_line === "dog_walking";
  const walkWindows = [
    { earliestTime: form.earliestTime, latestTime: form.latestTime },
    ...extraWalkWindows,
  ];
  const setDaysOffered = offersSetDays({
    serviceLine: chosenService?.service_line,
    alreadySetDays: initial.choice === "set_days" || form.choice === "set_days",
    turnedOn: setDaysOn,
  });
  const scheduleChoices = SCHEDULE_CHOICES.filter((c) => c.value !== "set_days" || setDaysOffered);

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
  if (form.choice === "set_days" && form.weekdays.length === 0)
    errors.weekdays = "Choose at least one day";
  if (form.earliestTime && form.latestTime && form.earliestTime >= form.latestTime)
    errors.window = "The earliest arrival must be before the latest arrival";
  if (creatingWalk && extraWalkWindows.length > 0) {
    const problem = walkWindowsProblem(walkWindows);
    if (problem) errors.window = problem;
  }

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
  const hasErrors = Object.keys(errors).length > 0;
  const fieldError = (k: string) => (showErrors && errors[k] ? errors[k] : null);
  // The service's own price for one visit (a walk at $25, an hourly groom at
  // its duration), or null when it has none (pet waste priced by zone). A plan
  // bills per visit, so this IS the plan's price: five walks a week is five
  // of these (migration 20261010010000, "Billing"). The one pricing rule,
  // servicePriceCents (phase 5); pet waste never reaches it.
  //
  // A service's length lives on the SERVICE: an hourly price is the rate ×
  // the service's own duration, and a business that sells a 45-minute and a
  // 90-minute groom has two services, which is how routing, drift, the portal
  // and public_quote already read it. A plan has no duration of its own.
  const serviceCents = chosenService
    ? servicePriceCents(chosenService, { pets: dogsForPricing })
    : null;
  const hourly = chosenService?.price_unit === "hour";
  const hourlyHint =
    hourly && chosenService && serviceCents != null && chosenService.default_duration_min != null
      ? `Priced at ${chosenService.default_duration_min} min × $${((chosenService.base_price_cents ?? 0) / 100).toFixed(2)} per hour; for a different length, add another service.`
      : null;

  /** A different service: a new walk plan starts Monday to Friday while its
   *  schedule is still the untouched default, and a blank price takes the
   *  service's per-visit price. Neither overwrites anything a person set. */
  const onServiceChange = (id: string) => {
    const next = orgServices.find((x) => x.id === id) ?? null;
    setForm((f) => {
      const patch: Partial<typeof f> = { serviceId: id };
      if (
        !subscription &&
        next &&
        next.service_line !== "pet_waste" &&
        f.choice === "weekly" &&
        f.weekdays.length === 0
      ) {
        patch.choice = "set_days";
        patch.weekdays = [...WORK_WEEK];
      }
      const cents = next ? servicePriceCents(next, { pets: dogsForPricing }) : null;
      if (cents != null && f.priceDollars.trim() === "") patch.priceDollars = (cents / 100).toFixed(2);
      return { ...f, ...patch };
    });
  };
  const selectedProperty = properties.find((p: any) => p.id === form.propertyId);
  // The zone that actually applies, in ONE place.
  //
  // This expression used to exist only here, to pick the zone the price
  // preview is computed from, while the save wrote `form.zoneId || undefined`.
  // For a client with more than one property those disagree: the form field
  // starts empty (there is no property selected yet, so nothing to prefill
  // from), the user picks a property, the preview correctly falls back to that
  // property's zone and prices the visit from it — and the subscription is
  // then saved with NO zone at all. The number is right on the day and the row
  // cannot explain where it came from, so nothing can re-derive it later.
  //
  // `zone_id` and not `auto_zone_id`: properties.functions.ts is explicit that
  // "auto_zone_id is what the matcher detected; zone_id is what actually
  // applies", and an override exists precisely because the detected one was
  // wrong.
  const effectiveZoneId = form.zoneId || selectedProperty?.zone_id || "";
  const pricingZone = zones.find((z: any) => z.id === effectiveZoneId);
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
  // Standard pricing is per-dog residential math — hidden for commercial.
  const stdParts =
    accountType === "residential" && std?.basePriceCents != null
      ? {
          base: std.basePriceCents,
          dogAdj: extraDogs * (std.perDogAddlCents ?? 0),
          perDog: std.perDogAddlCents ?? 0,
        }
      : null;
  const standardCents = stdParts
    ? Math.round((stdParts.base + stdParts.dogAdj) * freqMultiplier)
    : null;
  const zonePrice =
    accountType === "residential" && pricingZone
      ? computeZoneVisitPrice(
          {
            base_price_cents: pricingZone.base_price_cents,
            per_dog_addl_cents: pricingZone.per_dog_addl_cents,
            pricing_mode: (pricingZone.pricing_mode ?? "flat") as "flat" | "per_sqft" | "per_acre",
            price_per_sqft_cents: Number(pricingZone.price_per_sqft_cents ?? 0),
            price_per_acre_cents: pricingZone.price_per_acre_cents,
            area_min_charge_cents: pricingZone.area_min_charge_cents,
            area_max_charge_cents: pricingZone.area_max_charge_cents,
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
  // Commercial zone pricing (HOA model): base + per-unit x units + per-acre x
  // acres + per-station x waste stations, then the schedule multiplier.
  // C2: units for pricing come from the property's TOTAL unit count (not
  // dog-owning units); the subscription's unit field is the fallback.
  const propTotalUnits =
    selectedProperty?.has_units && selectedProperty?.total_units != null
      ? Number(selectedProperty.total_units)
      : null;
  const unitsForPricing =
    accountType === "commercial"
      ? Math.max(1, propTotalUnits ?? (parseInt(form.unitCount, 10) || 1))
      : 0;
  // Active waste stations on the property feed the per-station rate + breakdown.
  const { data: stationsData } = useQuery({
    queryKey: ["service-stations", selectedProperty?.id],
    queryFn: () => stationsFn({ data: { propertyId: selectedProperty!.id } }),
    enabled: open && accountType === "commercial" && !!selectedProperty?.id,
  });
  const stationCount =
    accountType === "commercial"
      ? ((stationsData as any)?.stations ?? []).filter((s: any) => s.active !== false).length
      : 0;
  const commercialFields = pricingZone
    ? {
        commercial_base_cents: pricingZone.commercial_base_cents ?? null,
        commercial_per_unit_cents: pricingZone.commercial_per_unit_cents ?? null,
        commercial_per_acre_cents: pricingZone.commercial_per_acre_cents ?? null,
        commercial_per_station_cents: pricingZone.commercial_per_station_cents ?? null,
      }
    : null;
  const commercialConfigured =
    accountType === "commercial" && commercialFields
      ? zoneHasCommercialPricing(commercialFields)
      : false;
  const commercialPrice =
    commercialConfigured && commercialFields
      ? computeCommercialZonePrice(commercialFields, {
          unitCount: unitsForPricing,
          boundaryAreaSqm: selectedProperty?.boundary_area_sqm
            ? Number(selectedProperty.boundary_area_sqm)
            : null,
          stationCount,
          multiplier: freqMultiplier,
        })
      : null;
  const zoneCents =
    accountType === "commercial"
      ? (commercialPrice?.recurringCents ?? null)
      : zonePrice
        ? zonePrice.recurringCents
        : null;
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
        // Units come from the PROPERTY record when it carries a total (single
        // source of truth — no double entry); the manual field only exists as
        // a fallback for properties that haven't recorded total_units yet.
        unitCount:
          accountType === "commercial"
            ? Math.max(1, propTotalUnits ?? (parseInt(form.unitCount, 10) || 1))
            : undefined,
        // The same expression the price was computed from. Writing
        // `form.zoneId` here is what let a service be priced from a zone it
        // did not record.
        zoneId: effectiveZoneId || undefined,
        billingCadence: form.billingCadence,
        startedOn: form.startedOn || undefined,
        endsOn: form.endsOn || null,
        preferredWeekdays:
          form.choice !== "set_days" && form.preferredWeekdays.length
            ? form.preferredWeekdays
            : undefined,
        // null on every other schedule, which clears a set the plan had.
        weekdays: form.choice === "set_days" ? normalizeWeekdays(form.weekdays) : null,
        earliestTime: form.earliestTime || null,
        latestTime: form.latestTime || null,
        serviceId: effectiveServiceId(form.serviceId, orgServices) ?? undefined,
      };
      const run = subscription
        ? updateFn({ data: { subscriptionId: subscription.id, ...common } })
        : creatingWalk && extraWalkWindows.length > 0
          ? createWalksFn({
              data: {
                clientId,
                accountType,
                ...common,
                serviceId: chosenService!.id,
                windows: walkWindows,
              },
            })
          : createFn({ data: { clientId, accountType, ...common } });
      return run.then(() => ({ ok: true }));
    },
    onSuccess: async () => {
      toast.success(subscription ? "Service saved" : "Service added");
      if (!subscription && fromQuote) {
        // Best effort: the service exists either way, and a quote that still
        // reads "accepted" is a smaller problem than a failed save message.
        try {
          await convertedFn({ data: { id: fromQuote.quoteId, clientId } });
        } catch {
          toast.error(`The service was added, but ${fromQuote.label} could not be marked as converted.`);
        }
      }
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
      {!subscription && fromQuote && (
        <div role="status" className="mb-4 space-y-1 rounded-md border bg-primary/5 p-3 text-sm">
          <p className="break-words">
            Started from accepted quote <strong>{fromQuote.label}</strong>.{" "}
            {fromQuote.priceCents != null
              ? "The price per visit is the quote's recurring total."
              : "The quote has no per-visit line, so set the price below."}
          </p>
          {fromQuote.oneTimeCents > 0 && (
            <p className="text-muted-foreground">
              Its one-time charges ({formatQuoteMoney(fromQuote.oneTimeCents)}) are not billed by
              adding a service. Once the work is done, press &ldquo;Invoice one-time charges&rdquo;
              on the quote.
            </p>
          )}
        </div>
      )}
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
        <ServicePicker
          value={form.serviceId}
          currentId={(subscription?.service_id as string | null) ?? null}
          services={orgServices}
          isLoading={servicesLoading}
          onChange={onServiceChange}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Property</Label>
            <select
              value={form.propertyId}
              onChange={(e) => {
                const pid = e.target.value;
                const n = pid ? activeDogsFor(pid) : 0;
                const next = pid ? properties.find((p: any) => p.id === pid) : null;
                setForm((f) => ({
                  ...f,
                  propertyId: pid,
                  // Refill from the property's dog records on switch.
                  ...(n > 0 && accountType === "residential" ? { dogCount: String(n) } : {}),
                  // And from its zone. This line was missing while the dog
                  // count beside it was not, so editing a service and moving
                  // it to another property left the OLD property's zone in the
                  // form — and that zone then priced the visit and was saved
                  // onto the row. Cleared rather than kept when the new
                  // property has no zone: carrying the previous address's
                  // zone across is the bug, not a useful default.
                  zoneId: (next?.zone_id as string | null | undefined) ?? "",
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
              onChange={(e) => {
                const choice = e.target.value as ScheduleChoice;
                setForm((f) => ({
                  ...f,
                  choice,
                  // Set days start on Monday to Friday rather than on none.
                  ...(choice === "set_days" && f.weekdays.length === 0
                    ? { weekdays: [...WORK_WEEK] }
                    : {}),
                }));
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {scheduleChoices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">{choiceMeta.hint}</p>
            {!setDaysOffered && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="px-0"
                onClick={() => {
                  setSetDaysOn(true);
                  setForm((f) => ({
                    ...f,
                    choice: "set_days",
                    weekdays: f.weekdays.length ? f.weekdays : [...WORK_WEEK],
                  }));
                }}
              >
                Visit on set days each week instead
              </Button>
            )}
          </div>
        </div>

        {form.choice === "set_days" && (
          <div>
            <WeekdayPicker
              label="Days each week"
              value={form.weekdays}
              onChange={(days) => set("weekdays", days)}
              locale={locale}
              invalid={!!fieldError("weekdays")}
            />
            {fieldError("weekdays") ? (
              <p className="mt-1 text-xs text-destructive">{fieldError("weekdays")}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                One visit on each day, every week, billed per visit. Blackout days and client
                holds are skipped, not moved.
              </p>
            )}
          </div>
        )}

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
            {serviceCents != null && serviceCents !== finalCents && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="px-0"
                onClick={() => set("priceDollars", (serviceCents / 100).toFixed(2))}
              >
                Use the service price, ${(serviceCents / 100).toFixed(2)}
              </Button>
            )}
            {hourlyHint && <p className="mt-1 text-xs text-muted-foreground">{hourlyHint}</p>}
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
          ) : propTotalUnits != null ? (
            <div>
              <Label>Units</Label>
              <div className="mt-1 flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm">
                {propTotalUnits} unit{propTotalUnits === 1 ? "" : "s"}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Pulled from the property record. Edit Total units on the property to change it.
              </p>
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
              <p className="mt-1 text-xs text-muted-foreground">
                Tip: set Total units on the property so it's entered once and reused everywhere.
              </p>
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
          {creatingWalk && (
            <div className="mt-3 space-y-3">
              {extraWalkWindows.map((window, index) => (
                <fieldset key={index} className="min-w-0 space-y-2 rounded-md border p-3">
                  <legend className="px-1 text-sm font-medium">Walk time {index + 2}</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TimeField
                      label="Earliest arrival"
                      value={window.earliestTime}
                      onChange={(value) =>
                        setExtraWalkWindows((rows) =>
                          rows.map((row, i) =>
                            i === index ? { ...row, earliestTime: value } : row,
                          ),
                        )
                      }
                    />
                    <TimeField
                      label="Latest arrival"
                      value={window.latestTime}
                      onChange={(value) =>
                        setExtraWalkWindows((rows) =>
                          rows.map((row, i) => (i === index ? { ...row, latestTime: value } : row)),
                        )
                      }
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11"
                    aria-label={`Remove walk time ${index + 2}`}
                    onClick={() =>
                      setExtraWalkWindows((rows) => rows.filter((_, i) => i !== index))
                    }
                  >
                    Remove walk time
                  </Button>
                </fieldset>
              ))}
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={extraWalkWindows.length >= 5}
                onClick={() =>
                  setExtraWalkWindows((rows) => [...rows, { earliestTime: "", latestTime: "" }])
                }
              >
                <Plus className="h-4 w-4 shrink-0" /> Add another walk time
              </Button>
              {extraWalkWindows.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Each walk time creates its own plan at the price shown above.
                </p>
              )}
            </div>
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

        {(standardCents != null ||
          zoneCents != null ||
          (accountType === "commercial" && pricingZone)) && (
          <div className="rounded-md border bg-muted/20 p-3 text-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Price comparison (per visit at this schedule)
            </div>
            {accountType === "commercial" && pricingZone && !commercialConfigured && (
              <p className="mt-2 text-xs text-muted-foreground">
                This zone has no commercial pricing yet. Set base, per-unit, and per-acre rates on
                the Zones page to compare against it here.
              </p>
            )}
            <dl className="mt-2 space-y-1">
              {commercialPrice && zoneCents != null && (
                <>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <dt>{pricingZone?.name} zone commercial base</dt>
                    <dd>${(commercialPrice.baseCents / 100).toFixed(2)}</dd>
                  </div>
                  {commercialPrice.unitCents > 0 && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <dt>
                        Units ({unitsForPricing} × $
                        {((pricingZone?.commercial_per_unit_cents ?? 0) / 100).toFixed(2)})
                      </dt>
                      <dd>+${(commercialPrice.unitCents / 100).toFixed(2)}</dd>
                    </div>
                  )}
                  {commercialPrice.acreageCents > 0 && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <dt>Acreage charge</dt>
                      <dd>+${(commercialPrice.acreageCents / 100).toFixed(2)}</dd>
                    </div>
                  )}
                  {commercialPrice.stationCents > 0 && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <dt>
                        Waste stations ({stationCount} × $
                        {((pricingZone?.commercial_per_station_cents ?? 0) / 100).toFixed(2)})
                      </dt>
                      <dd>+${(commercialPrice.stationCents / 100).toFixed(2)}</dd>
                    </div>
                  )}
                  {freqMultiplier !== 1 && (
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <dt>
                        Schedule adjustment (${(commercialPrice.perVisitCents / 100).toFixed(2)} ×{" "}
                        {freqMultiplier})
                      </dt>
                      <dd>
                        {zoneCents - commercialPrice.perVisitCents >= 0 ? "+" : "−"}$
                        {(Math.abs(zoneCents - commercialPrice.perVisitCents) / 100).toFixed(2)}
                      </dd>
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
                      <dd>
                        {zoneCents - zoneParts.perVisit >= 0 ? "+" : "−"}$
                        {(Math.abs(zoneCents - zoneParts.perVisit) / 100).toFixed(2)}
                      </dd>
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
                    <Badge variant={priceSource === "custom" ? "outline" : "secondary"} className="text-3xs">
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

        {form.choice !== "one_time" && form.choice !== "monthly" && form.choice !== "set_days" && (
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
  // The org's today: "end effective today" must mean the same day the chip
  // and the schedule call today.
  const today = useOrgToday();
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (subscription) {
      setEffectiveDate(today);
      setReason("");
      setNotes("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          <Label htmlFor="end-reason">Why is this ending?</Label>
          {/* One of a few answers, so Reports can count them; the detail
              goes in the notes. See src/lib/churn-reasons.ts. */}
          <select
            id="end-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">Choose a reason…</option>
            {CHURN_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="end-notes">
            {reason === "Other" ? "What happened?" : "Notes (optional)"}
          </Label>
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
