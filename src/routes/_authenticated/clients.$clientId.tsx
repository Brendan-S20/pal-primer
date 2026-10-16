// Client detail page (docs/client-detail-refactor.md): a persistent header,
// eight tabs, read-only by default, editing in right-side drawers. The heavy
// lifting lives in src/components/client-detail/*.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ClientDetailSkeleton } from "@/components/PageSkeletons";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  getClient,
  getFieldClientInfo,
  listClientVisitHistory,
  listDogsForClient,
} from "@/lib/clients.functions";
import { listPropertiesForClient } from "@/lib/properties.functions";
import { listSubscriptionsForClient } from "@/lib/subscriptions.functions";
import { isServiceEnded } from "@/lib/subscription-form";
import { useOrgToday } from "@/hooks/useOrgToday";
import { listZones } from "@/lib/zones.functions";
import { getClientBillingSummary, getClientCredit } from "@/lib/invoices.functions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/useMyRole";
import { ClientHeader } from "@/components/client-detail/ClientHeader";
import { EditClientDrawer } from "@/components/client-detail/EditClientDrawer";
import { SummaryTab } from "@/components/client-detail/SummaryTab";
import { Skeleton } from "@/components/ui/skeleton";
import { pageTitle, titleHead, useDocumentTitle } from "@/lib/page-title";

// ── EVERY TAB BUT THE FIRST IS ITS OWN CHUNK ─────────────────────────────
//
// This page was one 219KB chunk, plus a 71KB date picker, all of it parsed
// before the Summary tab could draw, though a visit to a client opens on
// Summary and most never leave it. On a phone that is the gap between the
// tap on a client and the client: the slide had to wait for the parse.
//
// Now Summary and the header are the page, and each other tab is loaded
// when it is first opened. They are all fetched as soon as the page is idle
// (preloadClientTabs below), so by the time a thumb reaches the tab bar the
// code is almost always already there and the switch is instant; the
// fallback is for the tab opened straight from a link (?tab=billing).
const tabLoaders = {
  properties: () => import("@/components/client-detail/PropertiesTab"),
  units: () => import("@/components/client-detail/UnitsTab"),
  services: () => import("@/components/client-detail/ServicesTab"),
  billingPanels: () => import("@/components/client-detail/billing-panels"),
  stations: () => import("@/components/client-detail/stations-panel"),
  visits: () => import("@/components/client-detail/VisitsTab"),
  billing: () => import("@/components/client-detail/BillingTab"),
  communication: () => import("@/components/client-detail/CommunicationTab"),
  reviews: () => import("@/components/client-detail/ReviewsReferralsTab"),
  activity: () => import("@/components/client-detail/ActivityTab"),
  // Not a tab: ClientHeader's drawer, lazy for its date picker.
  vacationHold: () => import("@/components/client-detail/VacationHoldDrawer"),
};
const PropertiesTab = lazy(() =>
  tabLoaders.properties().then((m) => ({ default: m.PropertiesTab })),
);
const UnitsTab = lazy(() => tabLoaders.units().then((m) => ({ default: m.UnitsTab })));
const ServicesTab = lazy(() => tabLoaders.services().then((m) => ({ default: m.ServicesTab })));
const AddonsPanel = lazy(() =>
  tabLoaders.billingPanels().then((m) => ({ default: m.AddonsPanel })),
);
const StationsPanel = lazy(() => tabLoaders.stations().then((m) => ({ default: m.StationsPanel })));
const VisitsTab = lazy(() => tabLoaders.visits().then((m) => ({ default: m.VisitsTab })));
const BillingTab = lazy(() => tabLoaders.billing().then((m) => ({ default: m.BillingTab })));
const CommunicationTab = lazy(() =>
  tabLoaders.communication().then((m) => ({ default: m.CommunicationTab })),
);
const ReviewsReferralsTab = lazy(() =>
  tabLoaders.reviews().then((m) => ({ default: m.ReviewsReferralsTab })),
);
const ActivityTab = lazy(() => tabLoaders.activity().then((m) => ({ default: m.ActivityTab })));

/** Fetch every tab's code once the page has drawn and the thread is free. */
function preloadClientTabs() {
  const run = () => {
    for (const load of Object.values(tabLoaders)) load().catch(() => {});
  };
  const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(run);
  else setTimeout(run, 300);
}

/** A tab whose code is still on its way: the shape of a tab, drawn only if
 *  the wait is real (ui/skeleton.tsx). */
function TabLoading({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="space-y-3 pt-2" aria-hidden="true">
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

function FieldClientInfoView({
  client,
  properties,
  dogs,
}: {
  client: any;
  properties: any[];
  dogs: any[];
}) {
  useDocumentTitle(pageTitle(client.display_name ?? "Client", "Clients"));
  const dogsByProperty = new Map<string, any[]>();
  for (const dog of dogs) {
    const list = dogsByProperty.get(dog.property_id) ?? [];
    list.push(dog);
    dogsByProperty.set(dog.property_id, list);
  }

  const flagsFor = (p: any) =>
    [
      [p.aggressive_dog, "Aggressive dog"],
      [p.dog_in_yard_during_service, "Dog in yard during service"],
      [p.escape_risk, "Escape risk"],
      [p.invisible_fence, "Invisible fence"],
      [p.bees_wasps, "Bees or wasps"],
      [p.sharp_objects, "Sharp objects"],
      [p.slippery_surfaces, "Slippery surfaces"],
      [p.do_not_enter_if_dog_out, "Do not enter if dog is out"],
    ]
      .filter(([on]) => on)
      .map(([, label]) => label as string);

  return (
    <div className="space-y-4">
      <Link
        to="/my-day"
        className="inline-flex items-center text-sm text-muted-foreground hover:underline touch:min-h-11"
      >
        Back to My Day
      </Link>

      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase text-muted-foreground">Field client info</p>
        <h1 className="text-2xl font-bold tracking-tight">{client.display_name}</h1>
        {client.primary_phone && (
          <a className="text-sm font-medium underline" href={`tel:${client.primary_phone}`}>
            {client.primary_phone}
          </a>
        )}
        {client.notes && <p className="whitespace-pre-wrap text-sm">{client.notes}</p>}
      </header>

      {properties.map((p) => {
        const dogRows = dogsByProperty.get(p.id) ?? [];
        const flags = flagsFor(p);
        return (
          <section key={p.id} className="space-y-3 border-t pt-4">
            <div>
              <h2 className="text-lg font-semibold">{p.street || p.label || "Property"}</h2>
              <p className="text-sm text-muted-foreground">
                {[p.city, p.region, p.postal_code].filter(Boolean).join(" ")}
              </p>
            </div>

            {(p.gate_code || p.lock_box_code || p.key_location) && (
              <div className="grid gap-2 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-2">
                {p.gate_code && (
                  <div>
                    <span className="text-muted-foreground">Gate:</span>{" "}
                    <span className="font-mono">{p.gate_code}</span>
                  </div>
                )}
                {p.lock_box_code && (
                  <div>
                    <span className="text-muted-foreground">Lock box:</span>{" "}
                    <span className="font-mono">{p.lock_box_code}</span>
                  </div>
                )}
                {p.key_location && (
                  <div className="sm:col-span-2">
                    <span className="text-muted-foreground">Key:</span> {p.key_location}
                  </div>
                )}
              </div>
            )}

            {(p.parking_notes || p.access_notes || p.hazard_notes || flags.length > 0) && (
              <div className="space-y-2 text-sm">
                {p.parking_notes && (
                  <p>
                    <span className="font-medium">Parking:</span> {p.parking_notes}
                  </p>
                )}
                {p.access_notes && (
                  <p>
                    <span className="font-medium">Access:</span> {p.access_notes}
                  </p>
                )}
                {flags.length > 0 && (
                  <p>
                    <span className="font-medium">Hazards:</span> {flags.join(", ")}
                  </p>
                )}
                {p.hazard_notes && <p className="whitespace-pre-wrap">{p.hazard_notes}</p>}
              </div>
            )}

            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                Dogs ({dogRows.length})
              </h3>
              {dogRows.length ? (
                <ul className="mt-1 space-y-2">
                  {dogRows.map((d) => (
                    <li key={d.id} className="rounded-md border p-2 text-sm">
                      <div className="font-medium">{d.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[d.breed, d.weight_class, d.temperament].filter(Boolean).join(" · ")}
                      </div>
                      {d.notes && <p className="mt-1 whitespace-pre-wrap text-xs">{d.notes}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">No dogs on file.</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const TABS = [
  "summary",
  "properties",
  "units",
  "services",
  "visits",
  "billing",
  "communication",
  "reviews",
  "activity",
] as const;
type TabValue = (typeof TABS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ClientDetailSearch = {
  tab?: TabValue;
  edit?: boolean;
  editProperty?: string;
  editService?: string;
  /** An accepted quote being turned into work: opens Add service on the
   *  Services tab with the quote's price. Stripped on arrival like the rest. */
  fromQuote?: string;
};

export const Route = createFileRoute("/_authenticated/clients/$clientId")({
  head: () => titleHead("Client"),
  component: ClientDetail,
  // QA follow-up 2.2: tabs are URL-addressable so refresh, back/forward, and
  // deep links land on the right tab instead of resetting to Summary.
  // ?edit=true (row actions on the Clients list) opens the Edit Client drawer
  // on arrival, then is stripped from the URL so refresh doesn't re-open it.
  // ?editProperty=<propertyId> / ?editService=<subscriptionId> extend the same
  // pattern: they open the matching Properties / Services edit drawer once,
  // then are stripped (replace nav) exactly like ?edit=true.
  validateSearch: (search: Record<string, unknown>): ClientDetailSearch => {
    const tab = search.tab as string | undefined;
    const out: ClientDetailSearch =
      TABS.includes(tab as TabValue) && tab !== "summary" ? { tab: tab as TabValue } : {};
    if (search.edit === true || search.edit === "true" || search.edit === "1") out.edit = true;
    if (typeof search.editProperty === "string" && UUID_RE.test(search.editProperty))
      out.editProperty = search.editProperty;
    if (typeof search.editService === "string" && UUID_RE.test(search.editService))
      out.editService = search.editService;
    if (typeof search.fromQuote === "string" && UUID_RE.test(search.fromQuote))
      out.fromQuote = search.fromQuote;
    return out;
  },
});

function ClientDetail() {
  const { clientId } = Route.useParams();
  const { can, loading: roleLoading } = usePermissions();
  const canViewDirectory = can("view_client_directory");
  const canBill = can("manage_client_billing");
  const canManagePricing = can("manage_pricing");

  const getClientFn = useServerFn(getClient);
  const getFieldClientInfoFn = useServerFn(getFieldClientInfo);
  const listPropsFn = useServerFn(listPropertiesForClient);
  const listSubsFn = useServerFn(listSubscriptionsForClient);
  const listZonesFn = useServerFn(listZones);
  const listVisitsFn = useServerFn(listClientVisitHistory);
  const getBillingFn = useServerFn(getClientBillingSummary);

  const {
    data: clientData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["client", clientId],
    queryFn: () => getClientFn({ data: { clientId } }),
    enabled: canViewDirectory,
  });
  const {
    data: fieldData,
    isLoading: fieldLoading,
    error: fieldError,
  } = useQuery({
    queryKey: ["client-field-info", clientId],
    queryFn: () => getFieldClientInfoFn({ data: { clientId } }),
    enabled: !roleLoading && !canViewDirectory,
  });
  // The tab names the client, so five clients open in five tabs are five
  // different tabs. The route's head says "Client" until this loads.
  const clientName = (clientData?.client as { display_name?: string | null } | undefined)
    ?.display_name;
  useDocumentTitle(clientName ? pageTitle(clientName, "Clients") : null);
  const { data: propsData } = useQuery({
    queryKey: ["properties", clientId],
    queryFn: () => listPropsFn({ data: { clientId } }),
    enabled: canViewDirectory,
  });
  const { data: subsData } = useQuery({
    queryKey: ["subs", clientId],
    queryFn: () => listSubsFn({ data: { clientId } }),
    enabled: canViewDirectory,
  });
  const { data: zonesData } = useQuery({
    queryKey: ["zones"],
    queryFn: () => listZonesFn(),
    enabled: canViewDirectory,
  });
  const { data: visitsData, isLoading: visitsLoading } = useQuery({
    queryKey: ["client-visit-history", clientId],
    queryFn: () => listVisitsFn({ data: { clientId } }),
    enabled: canViewDirectory,
  });
  const listDogsFn = useServerFn(listDogsForClient);
  const { data: dogsData } = useQuery({
    queryKey: ["client-dogs", clientId],
    queryFn: () => listDogsFn({ data: { clientId } }),
    enabled: canViewDirectory,
  });
  const { data: billing } = useQuery({
    queryKey: ["billing-summary", clientId],
    queryFn: () => getBillingFn({ data: { clientId } }),
    enabled: canBill,
  });
  const getCreditFn = useServerFn(getClientCredit);
  const { data: credit, isLoading: creditLoading } = useQuery({
    queryKey: ["credit", clientId],
    queryFn: () => getCreditFn({ data: { clientId } }),
    enabled: canBill,
  });

  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const tab: TabValue = search.tab ?? "summary";
  const setTab = (next: string) =>
    navigate({
      search: next === "summary" ? {} : { tab: next as TabValue },
      replace: false,
    });
  const [editClientOpen, setEditClientOpen] = useState(false);
  // Deep-linked property / service edits (?editProperty / ?editService): held
  // in state until the owning tab's data has loaded, then consumed by the tab.
  const [pendingEditPropertyId, setPendingEditPropertyId] = useState<string | null>(null);
  const [pendingEditServiceId, setPendingEditServiceId] = useState<string | null>(null);
  const [pendingFromQuoteId, setPendingFromQuoteId] = useState<string | null>(null);

  // Deep-linked edit affordances (?edit=true from the Clients list row
  // actions; ?editProperty / ?editService from the Properties / Services
  // lists' Edit buttons): open the drawer once, then clean the URL (replace
  // nav) so refresh doesn't re-open it. editProperty / editService force the
  // owning tab, since drawers inside an unmounted tab can't render.
  useEffect(() => {
    if (!search.edit && !search.editProperty && !search.editService && !search.fromQuote) return;
    if (search.edit) setEditClientOpen(true);
    if (search.editProperty) setPendingEditPropertyId(search.editProperty);
    if (search.editService) setPendingEditServiceId(search.editService);
    if (search.fromQuote) setPendingFromQuoteId(search.fromQuote);
    const nextTab: TabValue | undefined = search.editProperty
      ? "properties"
      : search.editService || search.fromQuote
        ? "services"
        : search.tab;
    navigate({
      search: nextTab && nextTab !== "summary" ? { tab: nextTab } : {},
      replace: true,
    });
  }, [search.edit, search.editProperty, search.editService, search.fromQuote]); // eslint-disable-line react-hooks/exhaustive-deps

  // A deep link to ?tab=billing for a role without billing visibility (e.g. a
  // dispatcher) falls back to Summary below — also strip the param (replace
  // nav) so refresh/back don't keep re-pointing at a tab that never shows.
  useEffect(() => {
    if (!roleLoading && search.tab === "billing" && !canBill) {
      navigate({ search: {}, replace: true });
    }
  }, [roleLoading, canBill, search.tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const todayISO = useOrgToday();

  // The other tabs' code, fetched while the client is read (see tabLoaders).
  useEffect(() => {
    preloadClientTabs();
  }, []);

  // Drawn the same way loaded or not, so the one control on the screen while
  // the client loads does not move when it arrives.
  const backLink = (
    <Link
      to="/clients"
      className="inline-flex items-center text-sm text-muted-foreground hover:underline touch:min-h-11"
    >
      ← Clients
    </Link>
  );

  if (!roleLoading && !canViewDirectory) {
    if (fieldLoading) return <ClientDetailSkeleton />;
    if (fieldError) return <p className="text-destructive">{(fieldError as Error).message}</p>;
    if (fieldData?.client?.display_name) {
      return (
        <FieldClientInfoView
          client={fieldData.client}
          properties={fieldData.properties ?? []}
          dogs={fieldData.dogs ?? []}
        />
      );
    }
    return null;
  }

  if (isLoading || roleLoading)
    return (
      <>
        {backLink}
        <ClientDetailSkeleton />
      </>
    );
  if (error) return <p className="text-destructive">{(error as Error).message}</p>;

  const client = clientData!.client as any;
  const properties = propsData?.properties ?? [];
  const activeProperties = properties.filter((p: any) => !p.archived_at);
  const subs = subsData?.subscriptions ?? [];
  const zones = zonesData?.zones ?? [];
  const visits = visitsData?.visits ?? [];
  const dogs = dogsData?.dogs ?? [];

  const activeSubs = subs.filter((s: any) => s.status === "active" && !isServiceEnded(s, todayISO));
  const isCommercial = client.account_type === "commercial";
  // Units exist for HOA/commercial portfolios: gate on the client's account
  // type or any commercial property (same signal as unit_count on services).
  const hasCommercialProperty =
    isCommercial ||
    activeProperties.some((p: any) => (p.account_type ?? client.account_type) === "commercial");
  // Deep links to a tab the caller can't see fall back to Summary instead of
  // rendering an empty content area (H4): ?tab=units on a residential client,
  // and ?tab=billing for a role without billing visibility (e.g. dispatcher).
  // The Billing DATA fns are independently permission-gated server-side
  // (getClientBillingSummary → manage_client_billing), so this redirect is a
  // usability layer, not the security boundary (I7).
  const effectiveTab: TabValue =
    (tab === "units" && !hasCommercialProperty) || (tab === "billing" && !canBill)
      ? "summary"
      : tab;

  return (
    <>
      {backLink}

      <ClientHeader
        client={client}
        clientId={clientId}
        subscriptions={subs}
        properties={activeProperties}
        propertyCount={activeProperties.length}
        activeServiceCount={activeSubs.length}
        outstandingCents={canBill ? (billing?.openTotalCents ?? 0) : null}
        canBill={canBill}
        onEditClient={() => setEditClientOpen(true)}
      />

      <Tabs value={effectiveTab} onValueChange={setTab} className="space-y-5">
        {/* Mobile Phase 2: below `md` the 9 pills scroll horizontally on one
            line (no wrap, hidden scrollbar) instead of wrapping into pill
            soup. Desktop keeps the wrapping layout. ?tab= behavior unchanged. */}
        {/* The phone half of this — no-scrollbar, full width, nowrap,
            overflow-x-auto — moved onto TabsList itself, so every tab bar in
            the app behaves the same. What is left here is the desktop-only
            part: nine tabs are too many for one 36px row, so above `md` they
            wrap on purpose. */}
        <TabsList className="inline-flex h-auto w-auto flex-wrap justify-start max-md:flex-nowrap">
          <TabsTrigger
            value="summary"
            className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-md px-3 py-1.5"
          >
            Summary
          </TabsTrigger>
          <TabsTrigger
            value="properties"
            className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-md px-3 py-1.5"
          >
            Properties
          </TabsTrigger>
          {hasCommercialProperty && (
            <TabsTrigger
              value="units"
              className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-md px-3 py-1.5"
            >
              Units
            </TabsTrigger>
          )}
          <TabsTrigger
            value="services"
            className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-md px-3 py-1.5"
          >
            Services
          </TabsTrigger>
          <TabsTrigger
            value="visits"
            className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-md px-3 py-1.5"
          >
            Visits
          </TabsTrigger>
          {canBill && (
            <TabsTrigger
              value="billing"
              className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-md px-3 py-1.5"
            >
              Billing
            </TabsTrigger>
          )}
          <TabsTrigger
            value="communication"
            className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-md px-3 py-1.5"
          >
            Communication
          </TabsTrigger>
          <TabsTrigger
            value="reviews"
            className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-md px-3 py-1.5"
          >
            Reviews & referrals
          </TabsTrigger>
          <TabsTrigger
            value="activity"
            className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground rounded-md px-3 py-1.5"
          >
            Activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="summary">
          <SummaryTab
            client={client}
            clientId={clientId}
            properties={properties}
            subscriptions={subs}
            visits={visits}
            dogs={dogs}
            zones={zones}
            creditCents={canBill ? (credit?.balanceCents ?? 0) : null}
            billingClient={billing?.client ?? null}
            visitsLoading={visitsLoading}
            creditLoading={canBill ? creditLoading : false}
            canBill={canBill}
            onGoToTab={setTab}
          />
        </TabsContent>

        <TabsContent value="properties">
          <TabLoading>
            <PropertiesTab
              clientId={clientId}
              client={client}
              subscriptions={subs}
              zones={zones}
              visits={visits}
              canManagePricing={canManagePricing}
              onGoToTab={setTab}
              editPropertyId={pendingEditPropertyId}
              onEditPropertyConsumed={() => setPendingEditPropertyId(null)}
            />
          </TabLoading>
        </TabsContent>

        {hasCommercialProperty && (
          <TabsContent value="units">
            <TabLoading>
              <UnitsTab
                clientId={clientId}
                client={client}
                properties={activeProperties}
                canBill={canBill}
                onGoToTab={setTab}
              />
            </TabLoading>
          </TabsContent>
        )}

        <TabsContent value="services" className="space-y-6">
          <TabLoading>
            <ServicesTab
              clientId={clientId}
              client={client}
              properties={activeProperties}
              subscriptions={subs}
              zones={zones}
              visits={visits}
              dogs={dogs}
              canBill={canBill}
              canManagePricing={canManagePricing}
              editServiceId={pendingEditServiceId}
              onEditServiceConsumed={() => setPendingEditServiceId(null)}
              newServiceFromQuoteId={pendingFromQuoteId}
              onNewServiceFromQuoteConsumed={() => setPendingFromQuoteId(null)}
            />
            {canBill && <AddonsPanel clientId={clientId} />}
            {isCommercial && <StationsPanel clientId={clientId} properties={activeProperties} />}
          </TabLoading>
        </TabsContent>

        <TabsContent value="visits">
          <TabLoading>
            <VisitsTab
              visits={visits}
              isLoading={visitsLoading}
              clientId={clientId}
              subscriptions={subs}
              canCorrect={canBill}
            />
          </TabLoading>
        </TabsContent>

        {canBill && (
          <TabsContent value="billing">
            <TabLoading>
              <BillingTab clientId={clientId} />
            </TabLoading>
          </TabsContent>
        )}

        <TabsContent value="communication">
          <TabLoading>
            <CommunicationTab client={client} />
          </TabLoading>
        </TabsContent>

        <TabsContent value="reviews">
          <TabLoading>
            <ReviewsReferralsTab client={client} clientId={clientId} canBill={canBill} />
          </TabLoading>
        </TabsContent>

        <TabsContent value="activity">
          <TabLoading>
            <ActivityTab clientId={clientId} />
          </TabLoading>
        </TabsContent>
      </Tabs>

      <EditClientDrawer
        open={editClientOpen}
        onClose={() => setEditClientOpen(false)}
        client={client}
        clientId={clientId}
      />
    </>
  );
}
