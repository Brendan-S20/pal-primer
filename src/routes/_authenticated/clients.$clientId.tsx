import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getClient } from "@/lib/clients.functions";
import { createProperty, listPropertiesForClient } from "@/lib/properties.functions";
import { createSubscription, listSubscriptionsForClient } from "@/lib/subscriptions.functions";
import { listZones } from "@/lib/zones.functions";
import { getClientCredit, generatePrepaidInvoice } from "@/lib/invoices.functions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/clients/$clientId")({
  component: ClientDetail,
});

const FREQ_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  twice_weekly: "Twice weekly",
  monthly: "Monthly",
  one_time: "One-time",
};

function ClientDetail() {
  const { clientId } = Route.useParams();
  const qc = useQueryClient();

  const getClientFn = useServerFn(getClient);
  const listPropsFn = useServerFn(listPropertiesForClient);
  const listSubsFn = useServerFn(listSubscriptionsForClient);
  const listZonesFn = useServerFn(listZones);
  const createPropFn = useServerFn(createProperty);
  const createSubFn = useServerFn(createSubscription);

  const { data: clientData, isLoading, error } = useQuery({
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
  const getCreditFn = useServerFn(getClientCredit);
  const prepayFn = useServerFn(generatePrepaidInvoice);
  const { data: credit } = useQuery({
    queryKey: ["credit", clientId],
    queryFn: () => getCreditFn({ data: { clientId } }),
  });
  const prepayMut = useMutation({
    mutationFn: (v: { subscriptionId: string; visitCount: number }) =>
      prepayFn({ data: v }),
    onSuccess: (r) => {
      toast.success(`Prepaid invoice created`);
      qc.invalidateQueries({ queryKey: ["credit", clientId] });
      window.location.href = `/invoices/${r.invoiceId}`;
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // property form
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [gateCode, setGateCode] = useState("");
  const [yardSize, setYardSize] = useState<"" | "small" | "medium" | "large" | "xlarge">("");
  const [hazardNotes, setHazardNotes] = useState("");
  const [hz, setHz] = useState({
    do_not_enter_if_dog_out: false,
    aggressive_dog: false,
    escape_risk: false,
    invisible_fence: false,
    dog_in_yard_during_service: false,
    bees_wasps: false,
    sharp_objects: false,
    slippery_surfaces: false,
  });
  const toggleHz = (k: keyof typeof hz) => setHz((s) => ({ ...s, [k]: !s[k] }));

  const propMut = useMutation({
    mutationFn: () =>
      createPropFn({
        data: {
          clientId,
          street,
          city,
          postalCode,
          gateCode: gateCode || undefined,
          yardSize: yardSize || undefined,
          hazardNotes: hazardNotes || undefined,
          doNotEnterIfDogOut: hz.do_not_enter_if_dog_out,
          aggressiveDog: hz.aggressive_dog,
          escapeRisk: hz.escape_risk,
          invisibleFence: hz.invisible_fence,
          dogInYardDuringService: hz.dog_in_yard_during_service,
          beesWasps: hz.bees_wasps,
          sharpObjects: hz.sharp_objects,
          slipperySurfaces: hz.slippery_surfaces,
        },
      }),
    onSuccess: () => {
      setStreet(""); setCity(""); setPostalCode(""); setGateCode("");
      setYardSize(""); setHazardNotes("");
      setHz({
        do_not_enter_if_dog_out: false, aggressive_dog: false, escape_risk: false,
        invisible_fence: false, dog_in_yard_during_service: false,
        bees_wasps: false, sharp_objects: false, slippery_surfaces: false,
      });
      qc.invalidateQueries({ queryKey: ["properties", clientId] });
    },
  });

  // subscription form
  const [propertyId, setPropertyId] = useState("");
  const [frequency, setFrequency] = useState("weekly");
  const [priceDollars, setPriceDollars] = useState("25");
  const [dogCount, setDogCount] = useState("1");
  const [unitCount, setUnitCount] = useState("1");
  const [zoneId, setZoneId] = useState("");
  const [billingCadence, setBillingCadence] = useState<"postpaid" | "prepaid">("postpaid");

  const subMut = useMutation({
    mutationFn: () => {
      const accountType = clientData!.client.account_type as "residential" | "commercial";
      return createSubFn({
        data: {
          clientId,
          propertyId,
          accountType,
          frequency: frequency as any,
          priceCents: Math.round(parseFloat(priceDollars) * 100),
          dogCount: accountType === "residential" ? parseInt(dogCount, 10) : undefined,
          unitCount: accountType === "commercial" ? parseInt(unitCount, 10) : undefined,
          zoneId: zoneId || undefined,
          billingCadence,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subs", clientId] });
    },
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-destructive">{(error as Error).message}</p>;
  const client = clientData!.client;
  const properties = propsData?.properties ?? [];
  const subs = subsData?.subscriptions ?? [];
  const zones = zonesData?.zones ?? [];

  return (
    <div className="space-y-6">
      <div>
        <Link to="/clients" className="text-sm text-muted-foreground hover:underline">
          ← Clients
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{client.display_name}</h1>
          <Badge variant={client.account_type === "commercial" ? "default" : "secondary"}>
            {client.account_type}
          </Badge>
        </div>
      </div>

      {/* Properties */}
      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium">Properties</h2>
        <ul className="mt-3 divide-y">
          {properties.map((p: any) => (
            <li key={p.id} className="py-2 text-sm">
              <span className="font-medium">{p.street}</span>, {p.city} {p.postal_code}
              {p.gate_code && <span className="ml-2 text-muted-foreground">gate {p.gate_code}</span>}
            </li>
          ))}
          {properties.length === 0 && (
            <li className="py-2 text-sm text-muted-foreground">No properties yet.</li>
          )}
        </ul>
        <form
          className="mt-4 grid gap-3 sm:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            propMut.mutate();
          }}
        >
          <div className="sm:col-span-2">
            <Label htmlFor="street">Street</Label>
            <Input id="street" value={street} onChange={(e) => setStreet(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="city">City</Label>
            <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="zip">Postal</Label>
            <Input id="zip" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="gate">Gate code</Label>
            <Input id="gate" value={gateCode} onChange={(e) => setGateCode(e.target.value)} />
          </div>
          <div className="sm:col-span-5">
            <Button type="submit" disabled={propMut.isPending}>
              {propMut.isPending ? "Adding…" : "Add property"}
            </Button>
            {propMut.error && (
              <span className="ml-3 text-sm text-destructive">{(propMut.error as Error).message}</span>
            )}
          </div>
        </form>
      </section>

      {/* Subscriptions */}
      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium">Subscriptions</h2>
        <ul className="mt-3 divide-y">
          {subs.map((s: any) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span>
                {FREQ_LABELS[s.frequency]} · {s.account_type === "residential" ? `${s.dog_count} dog(s)` : `${s.unit_count} unit(s)`}
                <Badge variant={s.billing_cadence === "prepaid" ? "default" : "secondary"} className="ml-2">
                  {s.billing_cadence}
                </Badge>
              </span>
              <span className="flex items-center gap-3 text-muted-foreground">
                <span>${(s.price_cents / 100).toFixed(2)} · {s.status}</span>
                {s.billing_cadence === "prepaid" && s.status === "active" && (
                  <PrepayInline
                    disabled={prepayMut.isPending}
                    onSubmit={(n) => prepayMut.mutate({ subscriptionId: s.id, visitCount: n })}
                  />
                )}
              </span>
            </li>
          ))}
          {subs.length === 0 && (
            <li className="py-2 text-sm text-muted-foreground">No subscriptions yet.</li>
          )}
        </ul>

        {properties.length > 0 && (
          <form
            className="mt-4 grid gap-3 sm:grid-cols-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (propertyId) subMut.mutate();
            }}
          >
            <div className="sm:col-span-2">
              <Label>Property</Label>
              <select
                value={propertyId}
                onChange={(e) => setPropertyId(e.target.value)}
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
            </div>
            <div>
              <Label>Frequency</Label>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                {Object.entries(FREQ_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <Label>Price ($)</Label>
              <Input type="number" min="0" step="0.01" value={priceDollars} onChange={(e) => setPriceDollars(e.target.value)} />
            </div>
            {client.account_type === "residential" ? (
              <div>
                <Label>Dogs</Label>
                <Input type="number" min="1" value={dogCount} onChange={(e) => setDogCount(e.target.value)} />
              </div>
            ) : (
              <div>
                <Label>Units</Label>
                <Input type="number" min="1" value={unitCount} onChange={(e) => setUnitCount(e.target.value)} />
              </div>
            )}
            <div>
              <Label>Zone</Label>
              <select
                value={zoneId}
                onChange={(e) => setZoneId(e.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">—</option>
                {zones.map((z: any) => (
                  <option key={z.id} value={z.id}>{z.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label>Billing</Label>
              <select
                value={billingCadence}
                onChange={(e) => setBillingCadence(e.target.value as "postpaid" | "prepaid")}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="postpaid">Postpaid</option>
                <option value="prepaid">Prepaid</option>
              </select>
            </div>
            <div className="sm:col-span-6">
              <Button type="submit" disabled={subMut.isPending || !propertyId}>
                {subMut.isPending ? "Adding…" : "Add subscription"}
              </Button>
              {subMut.error && (
                <span className="ml-3 text-sm text-destructive">{(subMut.error as Error).message}</span>
              )}
            </div>
          </form>
        )}
      </section>

      {/* Credit balance */}
      <section className="rounded-lg border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Prepaid credit balance</h2>
          <span className={`text-lg font-semibold ${((credit?.balanceCents ?? 0) < 0) ? "text-destructive" : ""}`}>
            ${((credit?.balanceCents ?? 0) / 100).toFixed(2)}
          </span>
        </div>
        {credit && credit.ledger.length > 0 ? (
          <ul className="mt-3 divide-y text-sm">
            {credit.ledger.map((l) => (
              <li key={l.id} className="flex items-center justify-between py-2">
                <span>
                  <span className="text-muted-foreground">{new Date(l.created_at).toLocaleDateString()}</span>
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
    </div>
  );
}

function PrepayInline({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (n: number) => void;
}) {
  const [count, setCount] = useState("4");
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const n = parseInt(count, 10);
        if (n > 0) onSubmit(n);
      }}
    >
      <Input
        type="number"
        min="1"
        max="52"
        value={count}
        onChange={(e) => setCount(e.target.value)}
        className="h-8 w-16"
      />
      <Button type="submit" size="sm" variant="outline" disabled={disabled}>
        Bill next
      </Button>
    </form>
  );
}
