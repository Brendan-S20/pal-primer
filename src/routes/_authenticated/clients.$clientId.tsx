// Client detail page (docs/client-detail-refactor.md): a persistent header,
// eight tabs, read-only by default, editing in right-side drawers. The heavy
// lifting lives in src/components/client-detail/*.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { getClient, listClientVisitHistory, listDogsForClient } from "@/lib/clients.functions";
import { listPropertiesForClient } from "@/lib/properties.functions";
import { listSubscriptionsForClient } from "@/lib/subscriptions.functions";
import { isServiceEnded } from "@/lib/subscription-form";
import { useOrgToday } from "@/hooks/useOrgToday";
import { listZones } from "@/lib/zones.functions";
import { getClientBillingSummary, getClientCredit } from "@/lib/invoices.functions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/useMyRole";
import { ClientHeader } from "@/components/client-detail/ClientHeader";
import { UnitsTab } from "@/components/client-detail/UnitsTab";
import { EditClientDrawer } from "@/components/client-detail/EditClientDrawer";
import { SummaryTab } from "@/components/client-detail/SummaryTab";
import { PropertiesTab } from "@/components/client-detail/PropertiesTab";
import { ServicesTab } from "@/components/client-detail/ServicesTab";
import { VisitsTab } from "@/components/client-detail/VisitsTab";
import { ActivityTab } from "@/components/client-detail/ActivityTab";
import { AddonsPanel } from "@/components/client-detail/billing-panels";
import { BillingTab } from "@/components/client-detail/BillingTab";
import { StationsPanel } from "@/components/client-detail/stations-panel";
import { CommunicationTab } from "@/components/client-detail/CommunicationTab";
import { ReviewsReferralsTab } from "@/components/client-detail/ReviewsReferralsTab";

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
};

export const Route = createFileRoute("/_authenticated/clients/$clientId")({
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
    return out;
  },
});

function ClientDetail() {
  const { clientId } = Route.useParams();
  const { can, loading: roleLoading } = usePermissions();
  const canBill = can("manage_client_billing");
  const canManagePricing = can("manage_pricing");

  const getClientFn = useServerFn(getClient);
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
  });
  const { data: propsData } = useQuery({
    queryKey: ["properties", clientId],
    queryFn: () => listPropsFn({ data: { clientId } }),
  });
  const { data: subsData } = useQuery({
    queryKey: ["subs", clientId],
    queryFn: () => listSubsFn({ data: { clientId } }),
  });
  const { data: zonesData } = useQuery({ queryKey: ["zones"], queryFn: () => listZonesFn() });
  const { data: visitsData, isLoading: visitsLoading } = useQuery({
    queryKey: ["client-visit-history", clientId],
    queryFn: () => listVisitsFn({ data: { clientId } }),
  });
  const listDogsFn = useServerFn(listDogsForClient);
  const { data: dogsData } = useQuery({
    queryKey: ["client-dogs", clientId],
    queryFn: () => listDogsFn({ data: { clientId } }),
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

  // Deep-linked edit affordances (?edit=true from the Clients list row
  // actions; ?editProperty / ?editService from the Properties / Services
  // lists' Edit buttons): open the drawer once, then clean the URL (replace
  // nav) so refresh doesn't re-open it. editProperty / editService force the
  // owning tab, since drawers inside an unmounted tab can't render.
  useEffect(() => {
    if (!search.edit && !search.editProperty && !search.editService) return;
    if (search.edit) setEditClientOpen(true);
    if (search.editProperty) setPendingEditPropertyId(search.editProperty);
    if (search.editService) setPendingEditServiceId(search.editService);
    const nextTab: TabValue | undefined = search.editProperty
      ? "properties"
      : search.editService
        ? "services"
        : search.tab;
    navigate({
      search: nextTab && nextTab !== "summary" ? { tab: nextTab } : {},
      replace: true,
    });
  }, [search.edit, search.editProperty, search.editService]); // eslint-disable-line react-hooks/exhaustive-deps

  // A deep link to ?tab=billing for a role without billing visibility (e.g. a
  // dispatcher) falls back to Summary below — also strip the param (replace
  // nav) so refresh/back don't keep re-pointing at a tab that never shows.
  useEffect(() => {
    if (!roleLoading && search.tab === "billing" && !canBill) {
      navigate({ search: {}, replace: true });
    }
  }, [roleLoading, canBill, search.tab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-destructive">{(error as Error).message}</p>;

  const client = clientData!.client as any;
  const properties = propsData?.properties ?? [];
  const activeProperties = properties.filter((p: any) => !p.archived_at);
  const subs = subsData?.subscriptions ?? [];
  const zones = zonesData?.zones ?? [];
  const visits = visitsData?.visits ?? [];
  const dogs = dogsData?.dogs ?? [];

  const todayISO = useOrgToday();
  const activeSubs = subs.filter(
    (s: any) => s.status === "active" && !isServiceEnded(s, todayISO),
  );
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
    <div className="space-y-5">
      <Link to="/clients" className="inline-flex items-center text-sm text-muted-foreground hover:underline touch:min-h-11">
        ← Clients
      </Link>

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
        </TabsContent>

        {hasCommercialProperty && (
          <TabsContent value="units">
            <UnitsTab
              clientId={clientId}
              client={client}
              properties={activeProperties}
              canBill={canBill}
              onGoToTab={setTab}
            />
          </TabsContent>
        )}

        <TabsContent value="services" className="space-y-6">
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
          />
          {canBill && <AddonsPanel clientId={clientId} />}
          {isCommercial && <StationsPanel clientId={clientId} properties={activeProperties} />}
        </TabsContent>

        <TabsContent value="visits">
          <VisitsTab
            visits={visits}
            isLoading={visitsLoading}
            clientId={clientId}
            subscriptions={subs}
            canCorrect={canBill}
          />
        </TabsContent>

        {canBill && (
          <TabsContent value="billing">
            <BillingTab clientId={clientId} />
          </TabsContent>
        )}

        <TabsContent value="communication">
          <CommunicationTab client={client} />
        </TabsContent>

        <TabsContent value="reviews">
          <ReviewsReferralsTab client={client} clientId={clientId} canBill={canBill} />
        </TabsContent>

        <TabsContent value="activity">
          <ActivityTab clientId={clientId} />
        </TabsContent>
      </Tabs>

      <EditClientDrawer
        open={editClientOpen}
        onClose={() => setEditClientOpen(false)}
        client={client}
        clientId={clientId}
      />
    </div>
  );
}
