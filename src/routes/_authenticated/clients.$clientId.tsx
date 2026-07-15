// Client detail page (docs/client-detail-refactor.md): a persistent header,
// six tabs, read-only by default, editing in right-side drawers. The heavy
// lifting lives in src/components/client-detail/*.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getClient, listClientVisitHistory, listDogsForClient } from "@/lib/clients.functions";
import { listPropertiesForClient } from "@/lib/properties.functions";
import { listSubscriptionsForClient } from "@/lib/subscriptions.functions";
import { listZones } from "@/lib/zones.functions";
import { getClientBillingSummary } from "@/lib/invoices.functions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/useMyRole";
import { ClientHeader } from "@/components/client-detail/ClientHeader";
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

const TABS = [
  "summary",
  "properties",
  "services",
  "visits",
  "billing",
  "communication",
  "activity",
] as const;
type TabValue = (typeof TABS)[number];

export const Route = createFileRoute("/_authenticated/clients/$clientId")({
  component: ClientDetail,
  // QA follow-up 2.2: tabs are URL-addressable so refresh, back/forward, and
  // deep links land on the right tab instead of resetting to Summary.
  validateSearch: (search: Record<string, unknown>): { tab?: TabValue } => {
    const tab = search.tab as string | undefined;
    return TABS.includes(tab as TabValue) && tab !== "summary" ? { tab: tab as TabValue } : {};
  },
});

function ClientDetail() {
  const { clientId } = Route.useParams();
  const { can } = usePermissions();
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

  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const tab: TabValue = search.tab ?? "summary";
  const setTab = (next: string) =>
    navigate({
      search: next === "summary" ? {} : { tab: next as TabValue },
      replace: false,
    });
  const [editClientOpen, setEditClientOpen] = useState(false);

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-destructive">{(error as Error).message}</p>;

  const client = clientData!.client as any;
  const properties = propsData?.properties ?? [];
  const activeProperties = properties.filter((p: any) => !p.archived_at);
  const subs = subsData?.subscriptions ?? [];
  const zones = zonesData?.zones ?? [];
  const visits = visitsData?.visits ?? [];
  const dogs = dogsData?.dogs ?? [];

  const today = new Date();
  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const activeSubs = subs.filter(
    (s: any) => s.status === "active" && (!s.ends_on || s.ends_on >= todayISO),
  );
  const isCommercial = client.account_type === "commercial";

  return (
    <div className="space-y-5">
      <Link to="/clients" className="text-sm text-muted-foreground hover:underline">
        ← Clients
      </Link>

      <ClientHeader
        client={client}
        clientId={clientId}
        propertyCount={activeProperties.length}
        activeServiceCount={activeSubs.length}
        outstandingCents={canBill ? (billing?.openTotalCents ?? 0) : null}
        canBill={canBill}
        onEditClient={() => setEditClientOpen(true)}
      />

      <Tabs value={tab} onValueChange={setTab} className="space-y-5">
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="properties">Properties</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
          <TabsTrigger value="visits">Visits</TabsTrigger>
          {canBill && <TabsTrigger value="billing">Billing</TabsTrigger>}
          <TabsTrigger value="communication">Communication</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="summary">
          <SummaryTab
            client={client}
            clientId={clientId}
            properties={properties}
            subscriptions={subs}
            visits={visits}
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
          />
        </TabsContent>

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
          <CommunicationTab client={client} clientId={clientId} canBill={canBill} />
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
