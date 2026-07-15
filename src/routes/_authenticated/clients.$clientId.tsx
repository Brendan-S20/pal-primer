// Client detail page (docs/client-detail-refactor.md): a persistent header,
// six tabs, read-only by default, editing in right-side drawers. The heavy
// lifting lives in src/components/client-detail/*.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getClient, listClientVisitHistory } from "@/lib/clients.functions";
import { listPropertiesForClient } from "@/lib/properties.functions";
import { listSubscriptionsForClient } from "@/lib/subscriptions.functions";
import { listZones } from "@/lib/zones.functions";
import { getClientCredit, getClientBillingSummary } from "@/lib/invoices.functions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePermissions } from "@/hooks/useMyRole";
import { ClientHeader } from "@/components/client-detail/ClientHeader";
import { EditClientDrawer } from "@/components/client-detail/EditClientDrawer";
import { SummaryTab } from "@/components/client-detail/SummaryTab";
import { PropertiesTab } from "@/components/client-detail/PropertiesTab";
import { ServicesTab } from "@/components/client-detail/ServicesTab";
import { VisitsTab } from "@/components/client-detail/VisitsTab";
import { ActivityTab } from "@/components/client-detail/ActivityTab";
import { BillingPanel, AddonsPanel } from "@/components/client-detail/billing-panels";
import { StationsPanel } from "@/components/client-detail/stations-panel";

export const Route = createFileRoute("/_authenticated/clients/$clientId")({
  component: ClientDetail,
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
  const getCreditFn = useServerFn(getClientCredit);
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
  const { data: credit } = useQuery({
    queryKey: ["credit", clientId],
    queryFn: () => getCreditFn({ data: { clientId } }),
    enabled: canBill,
  });
  const { data: billing } = useQuery({
    queryKey: ["billing-summary", clientId],
    queryFn: () => getBillingFn({ data: { clientId } }),
    enabled: canBill,
  });

  const [tab, setTab] = useState("summary");
  const [editClientOpen, setEditClientOpen] = useState(false);

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-destructive">{(error as Error).message}</p>;

  const client = clientData!.client as any;
  const properties = propsData?.properties ?? [];
  const activeProperties = properties.filter((p: any) => !p.archived_at);
  const subs = subsData?.subscriptions ?? [];
  const zones = zonesData?.zones ?? [];
  const visits = visitsData?.visits ?? [];

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
            canBill={canBill}
          />
          {isCommercial && <StationsPanel clientId={clientId} properties={activeProperties} />}
        </TabsContent>

        <TabsContent value="visits">
          <VisitsTab visits={visits} isLoading={visitsLoading} />
        </TabsContent>

        {canBill && (
          <TabsContent value="billing" className="space-y-6">
            <section className="rounded-lg border bg-card p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">Prepaid credit balance</h2>
                <span
                  className={`text-lg font-semibold ${(credit?.balanceCents ?? 0) < 0 ? "text-destructive" : ""}`}
                >
                  ${((credit?.balanceCents ?? 0) / 100).toFixed(2)}
                </span>
              </div>
              {credit && credit.ledger.length > 0 ? (
                <ul className="mt-3 divide-y text-sm">
                  {credit.ledger.map((l: any) => (
                    <li key={l.id} className="flex items-center justify-between py-2">
                      <span>
                        <span className="text-muted-foreground">
                          {new Date(l.created_at).toLocaleDateString()}
                        </span>
                        <span className="ml-2">{l.note ?? l.kind}</span>
                      </span>
                      <span className={l.delta_cents < 0 ? "text-destructive" : "text-primary"}>
                        {l.delta_cents < 0 ? "−" : "+"}${Math.abs(l.delta_cents / 100).toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">No credit activity yet.</p>
              )}
            </section>

            <BillingPanel clientId={clientId} />

            <AddonsPanel clientId={clientId} />
          </TabsContent>
        )}

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
