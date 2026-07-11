import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { getClient, regeneratePortalLink, readPortalVerificationCode } from "@/lib/clients.functions";
import { getMyOrg } from "@/lib/org.functions";
import { createProperty, updateProperty, listPropertiesForClient } from "@/lib/properties.functions";
import { createSubscription, updateSubscription, listSubscriptionsForClient } from "@/lib/subscriptions.functions";
import { subscriptionToFormValues, blankSubscriptionFormValues } from "@/lib/subscription-form";
import { listZones } from "@/lib/zones.functions";
import { getClientCredit, generatePrepaidInvoice, getClientBillingSummary, generateInvoiceForClient, createCheckoutForInvoice, voidInvoice, resumeAutopay } from "@/lib/invoices.functions";
import { sendReviewRequest, applyReferralCode } from "@/lib/reviews.functions";
import { sendSmsToClient, listClientMessages } from "@/lib/messages.functions";
import { Textarea } from "@/components/ui/textarea";
import {
  listAddonServices,
  listClientAddons,
  createAddonCharge,
  voidAddonCharge,
  createAddonSubscription,
  setAddonSubscriptionStatus,
} from "@/lib/addons.functions";
import { listStations, upsertStation, deleteStation } from "@/lib/stations.functions";
import { updatePropertyWindow } from "@/lib/visits.functions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { usePermissions } from "@/hooks/useMyRole";

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
  const { can } = usePermissions();
  const canBill = can("manage_client_billing");

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
    enabled: canBill,
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
  // Which existing property the form is editing (null = adding a new one).
  const [editingPropId, setEditingPropId] = useState<string | null>(null);
  const updatePropFn = useServerFn(updateProperty);

  function resetPropertyForm() {
    setEditingPropId(null);
    setStreet(""); setCity(""); setPostalCode(""); setGateCode("");
    setYardSize(""); setHazardNotes("");
    setHz({
      do_not_enter_if_dog_out: false, aggressive_dog: false, escape_risk: false,
      invisible_fence: false, dog_in_yard_during_service: false,
      bees_wasps: false, sharp_objects: false, slippery_surfaces: false,
    });
  }

  // Load an existing property's saved values into the edit form (finding #21:
  // the fields were blank on load even though the property had a saved address).
  function editProperty(p: any) {
    setEditingPropId(p.id);
    setStreet(p.street ?? "");
    setCity(p.city ?? "");
    setPostalCode(p.postal_code ?? "");
    setGateCode(p.gate_code ?? "");
    setYardSize((p.yard_size ?? "") as typeof yardSize);
    setHazardNotes(p.hazard_notes ?? "");
    setHz({
      do_not_enter_if_dog_out: !!p.do_not_enter_if_dog_out,
      aggressive_dog: !!p.aggressive_dog,
      escape_risk: !!p.escape_risk,
      invisible_fence: !!p.invisible_fence,
      dog_in_yard_during_service: !!p.dog_in_yard_during_service,
      bees_wasps: !!p.bees_wasps,
      sharp_objects: !!p.sharp_objects,
      slippery_surfaces: !!p.slippery_surfaces,
    });
  }

  const propMut = useMutation({
    mutationFn: () => {
      const common = {
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
      };
      const run = editingPropId
        ? updatePropFn({ data: { propertyId: editingPropId, ...common } })
        : createPropFn({ data: { clientId, ...common } });
      return run.then(() => ({ ok: true }));
    },
    onSuccess: () => {
      resetPropertyForm();
      qc.invalidateQueries({ queryKey: ["properties", clientId] });
    },
  });

  // subscription form
  const [propertyId, setPropertyId] = useState("");
  const [frequency, setFrequency] = useState("weekly");
  const [priceDollars, setPriceDollars] = useState("");
  const [dogCount, setDogCount] = useState("1");
  const [unitCount, setUnitCount] = useState("1");
  const [zoneId, setZoneId] = useState("");
  const [billingCadence, setBillingCadence] = useState<"postpaid" | "prepaid">("postpaid");
  const [preferredWeekdays, setPreferredWeekdays] = useState<number[]>([]);
  // Which existing subscription the form is editing (null = adding a new one).
  // Defaults to the client's first subscription so the form always reflects a
  // real record rather than misleading hardcoded defaults (finding #8).
  const [editingSubId, setEditingSubId] = useState<string | null>(null);
  const [subFormInit, setSubFormInit] = useState(false);

  const updateSubFn = useServerFn(updateSubscription);

  function applyFormValues(v: ReturnType<typeof subscriptionToFormValues>) {
    setPropertyId(v.propertyId);
    setFrequency(v.frequency);
    setPriceDollars(v.priceDollars);
    setDogCount(v.dogCount);
    setUnitCount(v.unitCount);
    setZoneId(v.zoneId);
    setBillingCadence(v.billingCadence);
    setPreferredWeekdays(v.preferredWeekdays);
  }

  function editSubscription(sub: any) {
    setEditingSubId(sub.id);
    applyFormValues(subscriptionToFormValues(sub));
  }

  function startNewSubscription(props: Array<{ id: string }>) {
    setEditingSubId(null);
    applyFormValues(blankSubscriptionFormValues({ properties: props }));
  }

  // On first load, hydrate the form from the existing subscription (or blank +
  // single-property auto-select for a client with none), so the form beneath
  // the summary line always matches real data instead of stale defaults.
  useEffect(() => {
    if (subFormInit || !subsData || !propsData) return;
    const existing = subsData.subscriptions ?? [];
    if (existing.length > 0) {
      editSubscription(existing[0]);
    } else {
      startNewSubscription(propsData.properties ?? []);
    }
    setSubFormInit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsData, propsData, subFormInit]);

  const subMut = useMutation({
    mutationFn: () => {
      const accountType = clientData!.client.account_type as "residential" | "commercial";
      const common = {
        propertyId,
        frequency: frequency as any,
        priceCents: Math.round(parseFloat(priceDollars) * 100),
        dogCount: accountType === "residential" ? parseInt(dogCount, 10) : undefined,
        unitCount: accountType === "commercial" ? parseInt(unitCount, 10) : undefined,
        zoneId: zoneId || undefined,
        billingCadence,
        preferredWeekdays: preferredWeekdays.length ? preferredWeekdays : undefined,
      };
      const run = editingSubId
        ? updateSubFn({ data: { subscriptionId: editingSubId, ...common } })
        : createSubFn({ data: { clientId, accountType, ...common } });
      return run.then(() => ({ ok: true }));
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

  const activeSubs = subs.filter((s: any) => s.status === "active");
  const initials = (client.display_name ?? "?")
    .split(/\s+/)
    .map((w: string) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="space-y-6">
      <div>
        <Link to="/clients" className="text-sm text-muted-foreground hover:underline">
          ← Clients
        </Link>
        {/* Identity header (re-review): who they are, how to reach them, and
            the numbers that matter — before any tab is clicked. */}
        <div className="mt-2 rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary">
                {initials}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold">{client.display_name}</h1>
                  <Badge variant={client.account_type === "commercial" ? "default" : "secondary"}>
                    {client.account_type}
                  </Badge>
                  {client.active === false && <Badge variant="outline">Inactive</Badge>}
                  {((client as any).churn_score ?? 0) >= 60 && (
                    <Badge variant="destructive">At risk</Badge>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-muted-foreground">
                  {client.primary_email && (
                    <a href={`mailto:${client.primary_email}`} className="hover:text-foreground hover:underline">
                      {client.primary_email}
                    </a>
                  )}
                  {client.primary_phone && (
                    <a href={`tel:${client.primary_phone}`} className="hover:text-foreground hover:underline">
                      {client.primary_phone}
                    </a>
                  )}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Link to="/messages/$clientId" params={{ clientId }}>
                <Button variant="outline" size="sm">Message</Button>
              </Link>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-4 sm:grid-cols-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Properties</div>
              <div className="text-lg font-semibold">{properties.length}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Active subs</div>
              <div className="text-lg font-semibold">
                {activeSubs.length}
                {activeSubs.length > 0 && (
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    {[...new Set(activeSubs.map((s: any) => String(s.frequency ?? "").replace("_", "-")))].filter(Boolean).join(", ")}
                  </span>
                )}
              </div>
            </div>
            {canBill && (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Credit</div>
                <div className={`text-lg font-semibold ${((credit?.balanceCents ?? 0) < 0) ? "text-destructive" : ""}`}>
                  ${((credit?.balanceCents ?? 0) / 100).toFixed(2)}
                </div>
              </div>
            )}
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Churn score</div>
              <div className="text-lg font-semibold">{(client as any).churn_score ?? "—"}</div>
            </div>
          </div>
          {(client as any).portal_token && canBill && (
            <div className="mt-3 border-t pt-3">
              <PortalLinkPanel clientId={clientId} portalToken={(client as any).portal_token} />
            </div>
          )}
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="service">Service</TabsTrigger>
          {canBill && <TabsTrigger value="billing">Billing</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <MessageComposer client={client} />
          <ReviewsReferralPanel client={client} />
          {canBill && (
            <section className="rounded-lg border bg-card p-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-medium">Prepaid credit balance</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    See full ledger in the Billing tab.
                  </p>
                </div>
                <span className={`text-2xl font-semibold ${((credit?.balanceCents ?? 0) < 0) ? "text-destructive" : ""}`}>
                  ${((credit?.balanceCents ?? 0) / 100).toFixed(2)}
                </span>
              </div>
            </section>
          )}
        </TabsContent>

        <TabsContent value="service" className="space-y-6">
      {/* Properties */}
      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium">Properties</h2>

        <ul className="mt-3 divide-y">
          {properties.map((p: any) => {
            const chips: string[] = [];
            if (p.do_not_enter_if_dog_out) chips.push("no-enter/dog");
            if (p.aggressive_dog) chips.push("aggressive dog");
            if (p.escape_risk) chips.push("escape risk");
            if (p.invisible_fence) chips.push("invisible fence");
            if (p.dog_in_yard_during_service) chips.push("dog in yard");
            if (p.bees_wasps) chips.push("bees/wasps");
            if (p.sharp_objects) chips.push("sharp objects");
            if (p.slippery_surfaces) chips.push("slippery");
            return (
              <li key={p.id} className="py-2 text-sm">
                <span className="font-medium">{p.street}</span>, {p.city} {p.postal_code}
                {p.gate_code && <span className="ml-2 text-muted-foreground">gate {p.gate_code}</span>}
                {p.yard_size && <span className="ml-2 text-muted-foreground">· {p.yard_size} yard</span>}
                <button
                  type="button"
                  onClick={() => editProperty(p)}
                  className={`ml-2 text-xs underline underline-offset-2 ${editingPropId === p.id ? "font-semibold text-primary" : "text-primary hover:text-foreground"}`}
                >
                  {editingPropId === p.id ? "Editing" : "Edit"}
                </button>
                {chips.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {chips.map((c) => (
                      <span key={c} className="rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                        ⚠ {c}
                      </span>
                    ))}
                  </div>
                )}
                <PropertyWindowRow property={p} />
                <div className="mt-1">
                  <Link
                    to="/properties/$propertyId/boundary"
                    params={{ propertyId: p.id }}
                    className="text-xs text-primary hover:underline"
                  >
                    {p.boundary ? "Edit boundary on map" : "Sketch boundary on map"}
                  </Link>
                </div>
              </li>
            );
          })}
          {properties.length === 0 && (
            <li className="py-2 text-sm text-muted-foreground">No properties yet.</li>
          )}
        </ul>
        <div className="mt-4 flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase text-muted-foreground">
            {editingPropId ? "Edit property" : "Add property"}
          </h3>
          {editingPropId && (
            <button
              type="button"
              onClick={resetPropertyForm}
              className="text-xs text-primary underline underline-offset-2"
            >
              + Add a new property instead
            </button>
          )}
        </div>
        <form
          className="mt-2 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            propMut.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-6">
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
            <div>
              <Label htmlFor="yard">Yard size</Label>
              <select
                id="yard"
                value={yardSize}
                onChange={(e) => setYardSize(e.target.value as any)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">—</option>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large">Large</option>
                <option value="xlarge">Extra large</option>
              </select>
            </div>
          </div>

          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Safety & access hazards
            </div>
            <div className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
              {[
                ["do_not_enter_if_dog_out", "Do NOT enter if dog is outside"],
                ["aggressive_dog", "Aggressive dog"],
                ["escape_risk", "Escape risk (close gate)"],
                ["invisible_fence", "Invisible fence"],
                ["dog_in_yard_during_service", "Dog in yard during service"],
                ["bees_wasps", "Bees / wasps"],
                ["sharp_objects", "Sharp objects"],
                ["slippery_surfaces", "Slippery surfaces"],
              ].map(([k, label]) => (
                <label key={k} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={(hz as any)[k]}
                    onChange={() => toggleHz(k as any)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            <div className="mt-2">
              <Label htmlFor="hnotes" className="text-xs">Hazard notes</Label>
              <Input
                id="hnotes"
                value={hazardNotes}
                onChange={(e) => setHazardNotes(e.target.value)}
                placeholder="e.g. Pool uncovered in summer; loose board at back gate"
              />
            </div>
          </div>

          <div>
            <Button type="submit" disabled={propMut.isPending}>
              {propMut.isPending ? "Saving…" : editingPropId ? "Save changes" : "Add property"}
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
                {s.preferred_weekdays?.length ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {s.preferred_weekdays.map((d: number) => ["Su","Mo","Tu","We","Th","Fr","Sa"][d]).join(" ")}
                  </span>
                ) : null}
              </span>
              <span className="flex items-center gap-3 text-muted-foreground">
                <span>${(s.price_cents / 100).toFixed(2)} · {s.status}</span>
                <button
                  type="button"
                  onClick={() => editSubscription(s)}
                  className={`text-xs underline underline-offset-2 ${editingSubId === s.id ? "font-semibold text-primary" : "hover:text-foreground"}`}
                >
                  {editingSubId === s.id ? "Editing" : "Edit"}
                </button>
                {canBill && s.billing_cadence === "prepaid" && s.status === "active" && (
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
          <div className="mt-4 flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">
              {editingSubId ? "Edit subscription" : "Add subscription"}
            </h3>
            {editingSubId && (
              <button
                type="button"
                onClick={() => startNewSubscription(properties)}
                className="text-xs text-primary underline underline-offset-2"
              >
                + Add a new subscription instead
              </button>
            )}
          </div>
        )}
        {properties.length > 0 && (
          <form
            className="mt-2 grid gap-3 sm:grid-cols-6"
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
              <Label>Preferred weekdays (optional)</Label>
              <div className="mt-1 flex flex-wrap gap-2">
                {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d, i) => {
                  const on = preferredWeekdays.includes(i);
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() =>
                        setPreferredWeekdays(
                          on ? preferredWeekdays.filter((x) => x !== i) : [...preferredWeekdays, i].sort(),
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
                Weekly/biweekly use the first selected day. Twice-weekly needs two days (e.g. Mon + Thu).
              </p>
            </div>
            <div className="sm:col-span-6">
              <Button type="submit" disabled={subMut.isPending || !propertyId}>
                {subMut.isPending
                  ? "Saving…"
                  : editingSubId
                    ? "Save changes"
                    : "Add subscription"}
              </Button>
              {subMut.error && (
                <span className="ml-3 text-sm text-destructive">{(subMut.error as Error).message}</span>
              )}
            </div>
          </form>
        )}
      </section>

          <StationsPanel clientId={clientId} properties={properties} />
        </TabsContent>

        {canBill && (
        <TabsContent value="billing" className="space-y-6">
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

          <BillingPanel clientId={clientId} />

          <AddonsPanel clientId={clientId} />
        </TabsContent>
        )}
      </Tabs>
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

// Finding #11: the Messages empty-state points users to "send a first message
// from a client's detail page," but no composer existed anywhere. This is that
// entry point — it originates a thread by sending the first SMS via the same
// path replies use, so the conversation appears on both this page and Messages.
function MessageComposer({ client }: { client: any }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listClientMessages);
  const sendFn = useServerFn(sendSmsToClient);
  const [body, setBody] = useState("");

  const messagesQ = useQuery({
    queryKey: ["client-messages", client.id],
    queryFn: () => listFn({ data: { clientId: client.id } }),
  });
  const messages: any[] = (messagesQ.data as any)?.messages ?? [];

  const sendMut = useMutation({
    mutationFn: () => sendFn({ data: { clientId: client.id, body: body.trim() } }),
    onSuccess: () => {
      setBody("");
      toast.success("Message sent");
      qc.invalidateQueries({ queryKey: ["client-messages", client.id] });
      qc.invalidateQueries({ queryKey: ["message-threads"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const noPhone = !client.primary_phone;
  return (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="text-sm font-medium">Messages</h2>
      {messages.length > 0 && (
        <ul className="mt-3 max-h-48 space-y-2 overflow-y-auto">
          {messages.slice(-6).map((m) => (
            <li
              key={m.id}
              className={`rounded-md px-3 py-2 text-sm ${m.direction === "outbound" ? "bg-primary/10" : "bg-muted"}`}
            >
              <div className="text-[11px] uppercase text-muted-foreground">
                {m.direction === "outbound" ? "Sent" : "Received"}
                {m.status ? ` · ${m.status}` : ""}
              </div>
              {m.body}
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) sendMut.mutate();
        }}
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          maxLength={1500}
          placeholder={
            noPhone
              ? "Add a phone number to this client to send SMS."
              : messages.length === 0
                ? "Send the first message to this client…"
                : "Write a reply…"
          }
          disabled={noPhone}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Sends an SMS from your business number.
          </span>
          <Button type="submit" size="sm" disabled={noPhone || !body.trim() || sendMut.isPending}>
            {sendMut.isPending ? "Sending…" : "Send message"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function ReviewsReferralPanel({ client }: { client: any }) {
  const qc = useQueryClient();
  const sendReview = useServerFn(sendReviewRequest);
  const applyRef = useServerFn(applyReferralCode);
  const [code, setCode] = useState("");

  const askMut = useMutation({
    mutationFn: (force: boolean) => sendReview({ data: { clientId: client.id, force } }),
    onSuccess: () => {
      toast.success("Review request sent");
      qc.invalidateQueries({ queryKey: ["client", client.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const applyMut = useMutation({
    mutationFn: () => applyRef({ data: { clientId: client.id, code: code.trim() } }),
    onSuccess: (r) => {
      toast.success(`Referral applied — $${(r.reward_cents / 100).toFixed(2)} credited to both accounts`);
      setCode("");
      qc.invalidateQueries({ queryKey: ["client", client.id] });
      qc.invalidateQueries({ queryKey: ["credit", client.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Copy failed"),
    );
  };

  const alreadyAsked = client.review_asked_at
    ? new Date(client.review_asked_at).toLocaleDateString()
    : null;

  return (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="text-sm font-medium">Reviews & referrals</h2>

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Referral code</div>
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 font-mono text-sm">
              {client.referral_code ?? "—"}
            </code>
            {client.referral_code && (
              <Button size="sm" variant="outline" onClick={() => copy(client.referral_code, "Code")}>
                Copy
              </Button>
            )}
          </div>
          {client.referred_by_client_id && (
            <p className="text-xs text-muted-foreground">
              Referred by another client on{" "}
              {client.referral_applied_at
                ? new Date(client.referral_applied_at).toLocaleDateString()
                : "—"}
            </p>
          )}
          {!client.referred_by_client_id && (
            <form
              className="flex items-center gap-2 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) applyMut.mutate();
              }}
            >
              <Input
                placeholder="Redeem referral code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="h-8 max-w-[180px]"
              />
              <Button type="submit" size="sm" variant="outline" disabled={applyMut.isPending}>
                Apply
              </Button>
            </form>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Review request</div>
          {alreadyAsked ? (
            <p className="text-xs text-muted-foreground">Last asked {alreadyAsked}</p>
          ) : (
            <p className="text-xs text-muted-foreground">Not yet asked.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => askMut.mutate(false)}
              disabled={askMut.isPending || client.sms_opt_out || !client.primary_phone}
            >
              Send review SMS
            </Button>
            {alreadyAsked && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => askMut.mutate(true)}
                disabled={askMut.isPending || client.sms_opt_out || !client.primary_phone}
              >
                Send anyway
              </Button>
            )}
          </div>
          {(client.sms_opt_out || !client.primary_phone) && (
            <p className="text-xs text-amber-600">
              {client.sms_opt_out ? "Client opted out of SMS." : "No phone number on file."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function PortalLinkPanel({ clientId, portalToken }: { clientId: string; portalToken: string }) {
  const qc = useQueryClient();
  const [token, setToken] = useState(portalToken);
  const [code, setCode] = useState<string | null>(null);
  const regenFn = useServerFn(regeneratePortalLink);
  const readCodeFn = useServerFn(readPortalVerificationCode);
  const orgFn = useServerFn(getMyOrg);
  const { data: orgData } = useQuery({ queryKey: ["my-org"], queryFn: () => orgFn(), staleTime: 60_000 });
  const slug = (orgData?.organization as any)?.portal_slug as string | undefined;

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // Canonical pretty URL; falls back to the legacy form only if the org has no
  // slug yet (the legacy path redirects to the pretty URL anyway).
  const path = slug ? `/portal/${slug}/${token}` : `/portal/${token}`;
  const url = `${origin}${path}`;

  const regenMut = useMutation({
    mutationFn: () => regenFn({ data: { clientId } }),
    onSuccess: (r) => {
      setToken(r.portalToken);
      setCode(null);
      qc.invalidateQueries({ queryKey: ["client", clientId] });
      toast.success("Portal link regenerated — the old link and any signed-in devices are now locked out.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const codeMut = useMutation({
    mutationFn: () => readCodeFn({ data: { clientId } }),
    onSuccess: (r) => setCode(r.code),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mt-3 space-y-2 rounded-md border bg-muted/30 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Client portal link:</span>
        <code className="max-w-full truncate rounded bg-background px-2 py-1">{url}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            navigator.clipboard.writeText(url).then(
              () => toast.success("Portal link copied"),
              () => toast.error("Copy failed"),
            )
          }
        >
          Copy
        </Button>
        <a className="text-primary underline" href={path} target="_blank" rel="noreferrer">
          Open
        </a>
        <Button
          size="sm"
          variant="ghost"
          disabled={regenMut.isPending}
          onClick={() => {
            if (confirm("Regenerate this client's portal link? The current link stops working and any device already signed in is logged out. Use this if the link may have leaked.")) {
              regenMut.mutate();
            }
          }}
        >
          {regenMut.isPending ? "Regenerating…" : "Regenerate link"}
        </Button>
        <Button size="sm" variant="ghost" disabled={codeMut.isPending} onClick={() => codeMut.mutate()}>
          {codeMut.isPending ? "…" : "Read verification code"}
        </Button>
      </div>
      <p className="text-muted-foreground">
        The link opens the portal but the client must verify with a one-time code sent to their
        phone or email before seeing any account details.
      </p>
      {code && (
        <p className="rounded bg-background p-2 font-mono text-sm">
          Read this code to the client (valid 10 min): <strong className="tracking-widest">{code}</strong>
        </p>
      )}
    </div>
  );
}

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function AddonsPanel({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const listSvc = useServerFn(listAddonServices);
  const listAddons = useServerFn(listClientAddons);
  const createCharge = useServerFn(createAddonCharge);
  const voidCharge = useServerFn(voidAddonCharge);
  const createSub = useServerFn(createAddonSubscription);
  const setSubStatus = useServerFn(setAddonSubscriptionStatus);

  const { data: svcData } = useQuery({
    queryKey: ["addon-services"],
    queryFn: () => listSvc({ data: {} }),
  });
  const { data: addonsData } = useQuery({
    queryKey: ["client-addons", clientId],
    queryFn: () => listAddons({ data: { clientId } }),
  });

  const [svcId, setSvcId] = useState("");
  const [qty, setQty] = useState("1");
  const [priceOverride, setPriceOverride] = useState("");
  const [subSvcId, setSubSvcId] = useState("");
  const [subFreq, setSubFreq] = useState("monthly");
  const [subPrice, setSubPrice] = useState("");

  const services: any[] = svcData?.services ?? [];
  const charges: any[] = addonsData?.charges ?? [];
  const subs: any[] = addonsData?.subscriptions ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["client-addons", clientId] });
    qc.invalidateQueries({ queryKey: ["credit", clientId] });
  };

  const chargeMut = useMutation({
    mutationFn: () => {
      if (!svcId) throw new Error("Pick an add-on");
      return createCharge({
        data: {
          clientId,
          addonServiceId: svcId,
          quantity: Math.max(1, parseInt(qty, 10) || 1),
          unitPriceCents:
            priceOverride.trim() === ""
              ? undefined
              : Math.round(parseFloat(priceOverride) * 100),
          source: "office",
        },
      });
    },
    onSuccess: () => {
      toast.success("Add-on billed");
      setSvcId(""); setQty("1"); setPriceOverride("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const voidMut = useMutation({
    mutationFn: (id: string) => voidCharge({ data: { chargeId: id } }),
    onSuccess: () => { toast.success("Voided"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const subMut = useMutation({
    mutationFn: () => {
      if (!subSvcId || !subPrice.trim()) throw new Error("Pick service and price");
      return createSub({
        data: {
          clientId,
          addonServiceId: subSvcId,
          frequency: subFreq as any,
          priceCents: Math.round(parseFloat(subPrice) * 100),
        },
      });
    },
    onSuccess: () => {
      toast.success("Recurring add-on started");
      setSubSvcId(""); setSubPrice("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const statusMut = useMutation({
    mutationFn: (v: { id: string; status: "active" | "paused" | "canceled" }) =>
      setSubStatus({ data: v }),
    onSuccess: () => invalidate(),
  });

  return (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="text-sm font-medium">Add-ons &amp; cross-sells</h2>

      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <div>
          <div className="text-xs font-medium text-muted-foreground">One-time add-on</div>
          <form
            className="mt-2 grid grid-cols-6 gap-2"
            onSubmit={(e) => { e.preventDefault(); chargeMut.mutate(); }}
          >
            <select
              className="col-span-3 h-9 rounded-md border bg-background px-2 text-sm"
              value={svcId}
              onChange={(e) => {
                setSvcId(e.target.value);
                const s = services.find((x) => x.id === e.target.value);
                if (s) setPriceOverride((s.unit_price_cents / 100).toFixed(2));
              }}
            >
              <option value="">Select service…</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>{s.name} — {money(s.unit_price_cents)}</option>
              ))}
            </select>
            <Input className="col-span-1 h-9" type="number" min="1" value={qty}
              onChange={(e) => setQty(e.target.value)} placeholder="Qty" />
            <Input className="col-span-1 h-9" type="number" step="0.01" min="0"
              value={priceOverride} onChange={(e) => setPriceOverride(e.target.value)} placeholder="$" />
            <Button type="submit" size="sm" className="col-span-1"
              disabled={chargeMut.isPending || !svcId}>Add</Button>
          </form>
          <p className="mt-1 text-xs text-muted-foreground">
            Prepaid clients: debits credit balance immediately. Postpaid: added to next invoice.
          </p>
        </div>

        <div>
          <div className="text-xs font-medium text-muted-foreground">Recurring add-on</div>
          <form
            className="mt-2 grid grid-cols-6 gap-2"
            onSubmit={(e) => { e.preventDefault(); subMut.mutate(); }}
          >
            <select
              className="col-span-3 h-9 rounded-md border bg-background px-2 text-sm"
              value={subSvcId}
              onChange={(e) => {
                setSubSvcId(e.target.value);
                const s = services.find((x) => x.id === e.target.value);
                if (s) setSubPrice((s.unit_price_cents / 100).toFixed(2));
              }}
            >
              <option value="">Select service…</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <select
              className="col-span-1 h-9 rounded-md border bg-background px-2 text-sm"
              value={subFreq} onChange={(e) => setSubFreq(e.target.value)}
            >
              <option value="weekly">Wk</option>
              <option value="biweekly">Bi-wk</option>
              <option value="monthly">Mo</option>
              <option value="quarterly">Qtr</option>
              <option value="yearly">Yr</option>
            </select>
            <Input className="col-span-1 h-9" type="number" step="0.01" min="0"
              value={subPrice} onChange={(e) => setSubPrice(e.target.value)} placeholder="$" />
            <Button type="submit" size="sm" className="col-span-1"
              disabled={subMut.isPending || !subSvcId}>Start</Button>
          </form>
        </div>
      </div>

      {subs.length > 0 && (
        <div className="mt-6">
          <div className="text-xs font-medium text-muted-foreground">Active recurring add-ons</div>
          <ul className="mt-2 divide-y text-sm">
            {subs.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2">
                <span>
                  {s.addon_services?.name} — {money(s.price_cents)} · {s.frequency}
                  <span className="ml-2 text-xs text-muted-foreground">next {s.next_charge_on}</span>
                  {s.status !== "active" && (
                    <Badge variant="outline" className="ml-2">{s.status}</Badge>
                  )}
                </span>
                <div className="flex gap-1">
                  {s.status === "active" ? (
                    <Button size="sm" variant="outline"
                      onClick={() => statusMut.mutate({ id: s.id, status: "paused" })}>Pause</Button>
                  ) : s.status === "paused" ? (
                    <Button size="sm" variant="outline"
                      onClick={() => statusMut.mutate({ id: s.id, status: "active" })}>Resume</Button>
                  ) : null}
                  {s.status !== "canceled" && (
                    <Button size="sm" variant="ghost"
                      onClick={() => statusMut.mutate({ id: s.id, status: "canceled" })}>Cancel</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {charges.some((c) => c.source === "field" && c.status !== "invoiced" && c.status !== "voided") && (
        <div className="mt-6 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Field add-ons to review
          </div>
          <ul className="mt-2 divide-y text-sm">
            {charges
              .filter((c) => c.source === "field" && c.status !== "invoiced" && c.status !== "voided")
              .slice(0, 8)
              .map((c) => (
                <li key={c.id} className="flex items-center justify-between py-1.5">
                  <span>
                    <span className="text-muted-foreground">{c.occurred_on}</span>
                    <span className="ml-2">{c.description}</span>
                    {c.quantity > 1 && (
                      <span className="ml-1 text-xs text-muted-foreground">× {c.quantity}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{money(c.amount_cents)}</span>
                    <Button size="sm" variant="ghost"
                      onClick={() => voidMut.mutate(c.id)} disabled={voidMut.isPending}>Void</Button>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}

      <div className="mt-6">
        <div className="text-xs font-medium text-muted-foreground">Recent charges</div>
        {charges.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No add-on charges yet.</p>
        ) : (
          <ul className="mt-2 divide-y text-sm">
            {charges.slice(0, 12).map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2">
                <span>
                  <span className="text-muted-foreground">{c.occurred_on}</span>
                  <span className="ml-2">{c.description}</span>
                  {c.quantity > 1 && (
                    <span className="ml-1 text-xs text-muted-foreground">× {c.quantity}</span>
                  )}
                  <Badge variant="outline" className="ml-2 text-[10px]">{c.status}</Badge>
                  {c.source === "field" && (
                    <Badge variant="secondary" className="ml-1 text-[10px]">field</Badge>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-medium">{money(c.amount_cents)}</span>
                  {c.status !== "invoiced" && c.status !== "voided" && (
                    <Button size="sm" variant="ghost"
                      onClick={() => voidMut.mutate(c.id)} disabled={voidMut.isPending}>Void</Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function StationsPanel({ clientId, properties }: { clientId: string; properties: any[] }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listStations);
  const upsertFn = useServerFn(upsertStation);
  const delFn = useServerFn(deleteStation);

  const { data } = useQuery({
    queryKey: ["stations", clientId],
    queryFn: () => listFn({ data: { clientId } }),
  });

  const upsertMut = useMutation({
    mutationFn: (v: any) => upsertFn({ data: v }),
    onSuccess: () => {
      toast.success("Station saved");
      qc.invalidateQueries({ queryKey: ["stations", clientId] });
      setDraft({ label: "", locationDescription: "", linerSize: "", capacityLiners: "", propertyId: properties[0]?.id ?? "" });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stations", clientId] }),
  });

  const [draft, setDraft] = useState({
    label: "",
    locationDescription: "",
    linerSize: "",
    capacityLiners: "",
    propertyId: properties[0]?.id ?? "",
  });

  const stations: any[] = data?.stations ?? [];

  if (properties.length === 0) return null;

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Waste stations</h2>
        <span className="text-xs text-muted-foreground">Common for commercial / HOA properties</span>
      </div>

      {stations.length > 0 ? (
        <ul className="mt-3 divide-y text-sm">
          {stations.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium">{s.label}{!s.active && <Badge variant="outline" className="ml-2">inactive</Badge>}</div>
                <div className="text-xs text-muted-foreground">
                  {s.location_description ?? ""}{s.liner_size ? ` · liner: ${s.liner_size}` : ""}{s.capacity_liners ? ` · cap: ${s.capacity_liners}` : ""}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => delMut.mutate(s.id)}>Remove</Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">No stations added yet.</p>
      )}

      <form
        className="mt-4 grid gap-3 sm:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.label || !draft.propertyId) return;
          const prop = properties.find((p) => p.id === draft.propertyId);
          upsertMut.mutate({
            clientId,
            propertyId: draft.propertyId,
            label: draft.label,
            locationDescription: draft.locationDescription || null,
            linerSize: draft.linerSize || null,
            capacityLiners: draft.capacityLiners ? parseInt(draft.capacityLiners, 10) : null,
          });
        }}
      >
        <div className="sm:col-span-2">
          <Label>Property</Label>
          <select
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={draft.propertyId}
            onChange={(e) => setDraft({ ...draft, propertyId: e.target.value })}
          >
            {properties.map((p: any) => <option key={p.id} value={p.id}>{p.street}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2">
          <Label>Label</Label>
          <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Building A — north lot" />
        </div>
        <div>
          <Label>Liner size</Label>
          <Input value={draft.linerSize} onChange={(e) => setDraft({ ...draft, linerSize: e.target.value })} placeholder="10 gal" />
        </div>
        <div>
          <Label>Capacity</Label>
          <Input type="number" min="0" value={draft.capacityLiners} onChange={(e) => setDraft({ ...draft, capacityLiners: e.target.value })} />
        </div>
        <div className="sm:col-span-6">
          <Label>Location</Label>
          <Input value={draft.locationDescription} onChange={(e) => setDraft({ ...draft, locationDescription: e.target.value })} placeholder="Near mail kiosk" />
        </div>
        <div className="sm:col-span-6">
          <Button type="submit" disabled={upsertMut.isPending}>Add station</Button>
        </div>
      </form>
    </section>
  );
}




function PropertyWindowRow({ property }: { property: any }) {
  const upd = useServerFn(updatePropertyWindow);
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: (patch: any) =>
      upd({ data: { propertyId: property.id, ...patch } }),
    onSuccess: () => {
      toast.success("Time window saved");
      qc.invalidateQueries({ queryKey: ["properties"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
      <span className="text-muted-foreground">Service window</span>
      <Input
        type="time"
        className="h-7 w-24 text-xs"
        defaultValue={property.earliest_service_time?.slice(0, 5) ?? ""}
        onBlur={(e) => mut.mutate({ earliest_service_time: e.target.value || null })}
      />
      <span>–</span>
      <Input
        type="time"
        className="h-7 w-24 text-xs"
        defaultValue={property.latest_service_time?.slice(0, 5) ?? ""}
        onBlur={(e) => mut.mutate({ latest_service_time: e.target.value || null })}
      />
      <span className="text-muted-foreground">·</span>
      <Input
        type="number"
        min={1}
        max={240}
        className="h-7 w-16 text-xs"
        defaultValue={property.service_duration_min ?? 8}
        onBlur={(e) => mut.mutate({ service_duration_min: Number(e.target.value) || 8 })}
      />
      <span className="text-muted-foreground">min</span>
    </div>
  );
}

function BillingPanel({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const summaryFn = useServerFn(getClientBillingSummary);
  const genFn = useServerFn(generateInvoiceForClient);
  const checkoutFn = useServerFn(createCheckoutForInvoice);
  const voidFn = useServerFn(voidInvoice);

  const { data } = useQuery({
    queryKey: ["billing-summary", clientId],
    queryFn: () => summaryFn({ data: { clientId } }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["billing-summary", clientId] });

  const genMut = useMutation({
    mutationFn: () => {
      const through = new Date().toISOString().slice(0, 10);
      return genFn({ data: { clientId, through } });
    },
    onSuccess: (r: any) => {
      if (r?.id) {
        toast.success("Invoice generated");
        invalidate();
      } else {
        toast.info("Nothing to invoice yet");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const linkMut = useMutation({
    mutationFn: (id: string) =>
      checkoutFn({ data: { id, returnUrl: window.location.href } }),
    onSuccess: (r: { url: string }) => {
      navigator.clipboard.writeText(r.url).then(
        () => toast.success("Pay link copied to clipboard"),
        () => toast.error("Copy failed — opening in new tab"),
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const voidMut = useMutation({
    mutationFn: (id: string) => voidFn({ data: { id } }),
    onSuccess: () => { toast.success("Invoice voided"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const invoices = data?.invoices ?? [];
  const payments = data?.payments ?? [];
  const c = data?.client;

  return (
    <>
      <section className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">Payment method</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Managed by the client from their portal.
            </p>
          </div>
          <div className="text-sm">
            {c?.default_payment_method_id ? (
              <div className="text-right">
                <div className="capitalize">
                  {c.default_card_brand ?? "Card"} ····{c.default_card_last4 ?? "····"}
                </div>
                <Badge variant={c.autopay_enabled ? "default" : "outline"} className="mt-1">
                  Autopay {c.autopay_enabled ? "on" : "off"}
                </Badge>
                {(c as any).autopay_paused && (
                  <AutopayResume clientId={clientId} lastError={(c as any).autopay_last_error} onDone={invalidate} />
                )}
              </div>
            ) : (
              <span className="text-muted-foreground">No card on file</span>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium">Invoices</h2>
            {data && (
              <p className="mt-1 text-xs text-muted-foreground">
                {data.openCount} open · ${(data.openTotalCents / 100).toFixed(2)} outstanding
              </p>
            )}
          </div>
          <Button size="sm" variant="outline" disabled={genMut.isPending} onClick={() => genMut.mutate()}>
            {genMut.isPending ? "Generating…" : "Generate invoice from unbilled visits"}
          </Button>
        </div>

        {invoices.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <ul className="mt-3 divide-y text-sm">
            {invoices.map((inv: any) => (
              <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <div className="flex items-center gap-2">
                    <Link
                      to="/invoices/$invoiceId"
                      params={{ invoiceId: inv.id }}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      #{inv.id.slice(0, 8)}
                    </Link>
                    <Badge variant={inv.status === "paid" ? "default" : inv.status === "void" ? "outline" : "secondary"}>
                      {inv.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{inv.kind}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {inv.period_start ? `${inv.period_start} → ${inv.period_end}` : new Date(inv.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">${(inv.total_cents / 100).toFixed(2)}</span>
                  {inv.status === "open" && (
                    <>
                      <Button size="sm" variant="outline" disabled={linkMut.isPending}
                        onClick={() => linkMut.mutate(inv.id)}>
                        Copy pay link
                      </Button>
                      <Button size="sm" variant="ghost" disabled={voidMut.isPending}
                        onClick={() => { if (confirm("Void this invoice?")) voidMut.mutate(inv.id); }}>
                        Void
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium">Payment history</h2>
        {payments.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No payments recorded.</p>
        ) : (
          <ul className="mt-3 divide-y text-sm">
            {payments.map((p: any) => (
              <li key={p.id} className="flex items-center justify-between py-2">
                <span>
                  <span className="text-muted-foreground">
                    {new Date(p.paid_at ?? p.created_at).toLocaleDateString()}
                  </span>
                  {p.invoice_id && (
                    <Link to="/invoices/$invoiceId" params={{ invoiceId: p.invoice_id }} className="ml-2 font-mono text-xs text-primary hover:underline">
                      #{p.invoice_id.slice(0, 8)}
                    </Link>
                  )}
                  <Badge variant="outline" className="ml-2 text-[10px]">{p.status}</Badge>
                </span>
                <span className="font-medium">${(p.amount_cents / 100).toFixed(2)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function AutopayResume({ clientId, lastError, onDone }: { clientId: string; lastError?: string | null; onDone: () => void }) {
  const resumeFn = useServerFn(resumeAutopay);
  const mut = useMutation({
    mutationFn: () => resumeFn({ data: { clientId } }),
    onSuccess: () => { toast.success("Autopay resumed — next nightly run will retry"); onDone(); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="mt-2 space-y-1 text-right">
      <Badge variant="destructive" className="text-[10px]">Paused after failed charges</Badge>
      {lastError && (
        <div className="max-w-[220px] truncate text-[10px] text-muted-foreground" title={lastError}>{lastError}</div>
      )}
      <Button size="sm" variant="outline" onClick={() => mut.mutate()} disabled={mut.isPending}>
        {mut.isPending ? "Resuming…" : "Resume autopay"}
      </Button>
    </div>
  );
}
