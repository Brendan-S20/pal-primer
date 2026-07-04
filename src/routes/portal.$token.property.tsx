import { createFileRoute } from "@tanstack/react-router";
import { Building2, Dog, Sparkles, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  usePortalCtx, StationsPanel, DogsGrid, AddonCard, EmptyBox,
  money, fmtDayShort,
} from "@/lib/portal-ui";

export const Route = createFileRoute("/portal/$token/property")({
  component: PortalProperty,
});

function PortalProperty() {
  const {
    clientQ, dogsQ, stationsQ, catalogQ, clientAddonsQ,
    subscribeAddonMut, cancelAddonMut,
  } = usePortalCtx();
  const c = clientQ.data as any;
  const isCommercial = c?.account_type === "commercial";
  const activeAddons = (clientAddonsQ.data ?? []).filter((a) => a.status === "active");

  return (
    <div className="space-y-6">
      {isCommercial ? (
        <section>
          <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
            <Building2 className="h-4 w-4" /> Property & stations
          </h2>
          <StationsPanel rows={stationsQ.data ?? []} />
        </section>
      ) : (
        <section>
          <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
            <Dog className="h-4 w-4" /> Your dogs on file
          </h2>
          {(dogsQ.data ?? []).length === 0 ? (
            <EmptyBox icon={<Dog className="h-6 w-6" />}
              title="No dogs on file yet"
              body="Text the office and we'll add them to your account." />
          ) : (
            <DogsGrid rows={dogsQ.data as any[]} />
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <Sparkles className="h-4 w-4" /> {isCommercial ? "Additional services" : "Add-ons & extras"}
        </h2>

        {activeAddons.length > 0 && (
          <ul className="divide-y rounded-md border bg-card mb-3">
            {activeAddons.map((a) => (
              <li key={a.addon_subscription_id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div>
                  <div className="font-medium flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" /> {a.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {money(a.price_cents)} · {a.frequency} · next {fmtDayShort(a.next_charge_on)}
                  </div>
                </div>
                <Button size="sm" variant="outline"
                  disabled={cancelAddonMut.isPending}
                  onClick={() => cancelAddonMut.mutate(a.addon_subscription_id)}>
                  Cancel
                </Button>
              </li>
            ))}
          </ul>
        )}

        {(catalogQ.data ?? []).length > 0 ? (
          <ul className="grid gap-2">
            {catalogQ.data!.map((a) => (
              <AddonCard key={a.addon_service_id} a={a}
                onSubscribe={(freq, qty) => subscribeAddonMut.mutate({
                  addonServiceId: a.addon_service_id, frequency: freq, quantity: qty,
                })}
                pending={subscribeAddonMut.isPending} />
            ))}
          </ul>
        ) : (
          activeAddons.length === 0 && (
            <EmptyBox icon={<Sparkles className="h-6 w-6" />}
              title={isCommercial ? "No additional services offered right now" : "No add-ons available yet"}
              body="Reach out and we can tailor something for you." />
          )
        )}
      </section>
    </div>
  );
}
