import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2, Dog, Sparkles, CheckCircle2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  usePortalCtx, StationsPanel, DogsGrid, AddonCard, EmptyBox,
  money, fmtDayShort, friendlyFrequency,
} from "@/lib/portal-ui";
import { portalListProperties } from "@/lib/portal.functions";

export const Route = createFileRoute("/portal/$slug/$token/property")({
  component: PortalProperty,
});

function PortalProperty() {
  const {
    token, slug, clientQ, dogsQ, stationsQ, catalogQ, clientAddonsQ,
    subscribeAddonMut, cancelAddonMut,
  } = usePortalCtx();
  const c = clientQ.data as any;
  const isCommercial = c?.account_type === "commercial";
  const activeAddons = (clientAddonsQ.data ?? []).filter((a) => a.status === "active");

  // Finding #29: show the client's distinct serviced addresses when they have
  // more than one, instead of a single undifferentiated view.
  const propsFn = useServerFn(portalListProperties);
  const propsQ = useQuery({ queryKey: ["portal-properties", token], queryFn: () => propsFn({ data: { token } }) });
  const properties: any[] = (propsQ.data as any)?.properties ?? [];

  return (
    <div className="space-y-6">
      {c?.mobile_grooming && (
        <p className="rounded-lg border bg-card p-4 text-sm">
          Vaccine records and groom requests are on the{" "}
          <Link
            to="/portal/$slug/$token/grooming"
            params={{ slug, token }}
            className="font-medium underline underline-offset-2"
          >
            Grooming page
          </Link>
          .
        </p>
      )}

      {properties.length > 1 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
            <MapPin className="h-4 w-4 shrink-0" /> Your properties ({properties.length})
          </h2>
          <ul className="space-y-2">
            {properties.map((p) => (
              <li key={p.id} className="rounded-md border bg-card p-3 text-sm">
                <div className="font-medium">{p.label || p.street}</div>
                <div className="text-xs text-muted-foreground">
                  {[p.street, p.city, p.region, p.postal_code].filter(Boolean).join(", ")}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            When you add a service below, pick the property it's for. Dogs on file cover your whole
            account. Mention the address if you need a change specific to one property.
          </p>
        </section>
      )}
      {isCommercial ? (
        <section>
          <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
            <Building2 className="h-4 w-4 shrink-0" /> Property & stations
          </h2>
          <StationsPanel rows={stationsQ.data ?? []} />
        </section>
      ) : (
        <section>
          <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
            <Dog className="h-4 w-4 shrink-0" /> Your dogs on file
          </h2>
          {(dogsQ.data ?? []).length === 0 ? (
            <EmptyBox icon={<Dog className="h-6 w-6 shrink-0" />}
              title="No dogs on file yet"
              body="Text the office and we'll add them to your account." />
          ) : (
            <DogsGrid rows={dogsQ.data as any[]} />
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0" /> {isCommercial ? "Additional services" : "Add-ons & extras"}
        </h2>

        {activeAddons.length > 0 && (
          <ul className="divide-y rounded-md border bg-card mb-3">
            {activeAddons.map((a) => (
              <li key={a.addon_subscription_id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div>
                  <div className="font-medium flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" /> {a.name}
                  </div>
                  {/* `a.frequency` is the raw addon_frequency enum off the RPC.
                      Printed as-is it gave a homeowner "$35.00 · biweekly · next
                      Aug 14" — the database's word, lower-cased, in the one
                      place a customer checks what they are paying for. Worse,
                      "biweekly" is the ambiguous one: the rest of the portal
                      spells that cadence "Every 2 weeks" precisely so nobody has
                      to guess between twice a week and every other week.
                      friendlyFrequency is the portal's own label helper (it
                      backs the plan row and the frequency-change picker), so
                      this row now reads the same cadence the same way. */}
                  <div className="text-xs text-muted-foreground">
                    {money(a.price_cents)} · {friendlyFrequency(a.frequency)} · next{" "}
                    {fmtDayShort(a.next_charge_on)}
                    {properties.length > 1 && (a as any).property_label ? ` · ${(a as any).property_label}` : ""}
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
              <AddonCard key={a.addon_service_id} a={a} properties={properties}
                onSubscribe={(freq, qty, propertyId) => subscribeAddonMut.mutate({
                  addonServiceId: a.addon_service_id, frequency: freq, quantity: qty, propertyId,
                })}
                pending={subscribeAddonMut.isPending} />
            ))}
          </ul>
        ) : (
          activeAddons.length === 0 && (
            <EmptyBox icon={<Sparkles className="h-6 w-6 shrink-0" />}
              title={isCommercial ? "No additional services offered right now" : "No add-ons available yet"}
              body="Reach out and we can tailor something for you." />
          )
        )}
      </section>
    </div>
  );
}
