import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
  portalGetClient,
  portalListUpcomingVisits,
  portalListInvoices,
  portalListPrepaidSubs,
  portalRequestSkip,
  portalStartPrepaidTopup,
  portalCreateCheckout,
  portalRescheduleVisit,
  portalChangeFrequency,
  portalListAddonCatalog,
  portalListClientAddons,
  portalSubscribeAddon,
  portalCancelAddon,
  portalStartCardSetup,
  portalSetAutopay,
  portalRemoveCard,
  portalPayInvoiceWithSavedCard,
} from "@/lib/portal.functions";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { PushToggle } from "@/components/PushToggle";

export const Route = createFileRoute("/portal/$token")({
  head: () => ({ meta: [{ title: "Your service portal" }] }),
  component: PortalPage,
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-xl font-semibold">Portal unavailable</h1>
      <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
    </div>
  ),
  notFoundComponent: () => (
    <div className="mx-auto max-w-md p-8 text-center">Portal not found.</div>
  ),
});

function money(cents: number | null | undefined, currency = "usd") {
  const v = (cents ?? 0) / 100;
  return v.toLocaleString(undefined, { style: "currency", currency: currency.toUpperCase() });
}

function PortalPage() {
  const { token } = Route.useParams();
  const qc = useQueryClient();

  const getClientFn = useServerFn(portalGetClient);
  const listVisitsFn = useServerFn(portalListUpcomingVisits);
  const listInvoicesFn = useServerFn(portalListInvoices);
  const listSubsFn = useServerFn(portalListPrepaidSubs);
  const skipFn = useServerFn(portalRequestSkip);
  const topupFn = useServerFn(portalStartPrepaidTopup);
  const checkoutFn = useServerFn(portalCreateCheckout);
  const rescheduleFn = useServerFn(portalRescheduleVisit);
  const changeFreqFn = useServerFn(portalChangeFrequency);
  const listAddonCatalogFn = useServerFn(portalListAddonCatalog);
  const listClientAddonsFn = useServerFn(portalListClientAddons);
  const subscribeAddonFn = useServerFn(portalSubscribeAddon);
  const cancelAddonFn = useServerFn(portalCancelAddon);
  const startSetupFn = useServerFn(portalStartCardSetup);
  const setAutopayFn = useServerFn(portalSetAutopay);
  const removeCardFn = useServerFn(portalRemoveCard);
  const payWithSavedFn = useServerFn(portalPayInvoiceWithSavedCard);


  const clientQ = useQuery({
    queryKey: ["portal", token, "client"],
    queryFn: () => getClientFn({ data: { token } }),
  });
  const visitsQ = useQuery({
    queryKey: ["portal", token, "visits"],
    queryFn: () => listVisitsFn({ data: { token } }),
  });
  const invoicesQ = useQuery({
    queryKey: ["portal", token, "invoices"],
    queryFn: () => listInvoicesFn({ data: { token } }),
  });
  const subsQ = useQuery({
    queryKey: ["portal", token, "subs"],
    queryFn: () => listSubsFn({ data: { token } }),
  });
  const catalogQ = useQuery({
    queryKey: ["portal", token, "catalog"],
    queryFn: () => listAddonCatalogFn({ data: { token } }),
  });
  const clientAddonsQ = useQuery({
    queryKey: ["portal", token, "clientAddons"],
    queryFn: () => listClientAddonsFn({ data: { token } }),
  });

  const skipMut = useMutation({
    mutationFn: (v: { visitId: string; reason: string }) => skipFn({ data: { token, ...v } }),
    onSuccess: () => {
      toast.success("Skip requested");
      qc.invalidateQueries({ queryKey: ["portal", token] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const topupMut = useMutation({
    mutationFn: (v: { subscriptionId: string; visitCount: number }) =>
      topupFn({ data: { token, ...v } }),
    onSuccess: async (r) => {
      const { url } = await checkoutFn({
        data: { token, invoiceId: r.invoiceId, returnUrl: window.location.href },
      });
      window.location.href = url;
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const payMut = useMutation({
    mutationFn: (invoiceId: string) =>
      checkoutFn({ data: { token, invoiceId, returnUrl: window.location.href } }),
    onSuccess: (r) => { window.location.href = r.url; },
    onError: (e) => toast.error((e as Error).message),
  });

  const invalidatePortal = () => qc.invalidateQueries({ queryKey: ["portal", token] });

  const rescheduleMut = useMutation({
    mutationFn: (v: { visitId: string; newDate: string }) =>
      rescheduleFn({ data: { token, ...v } }),
    onSuccess: () => { toast.success("Visit rescheduled"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });

  const freqMut = useMutation({
    mutationFn: (v: { subscriptionId: string; frequency: "weekly" | "biweekly" | "twice_weekly" | "monthly" }) =>
      changeFreqFn({ data: { token, ...v } }),
    onSuccess: () => { toast.success("Plan updated"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });

  const subscribeAddonMut = useMutation({
    mutationFn: (v: { addonServiceId: string; frequency: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | null; quantity: number }) =>
      subscribeAddonFn({ data: { token, ...v } }),
    onSuccess: () => { toast.success("Add-on added"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });

  const cancelAddonMut = useMutation({
    mutationFn: (addonSubscriptionId: string) =>
      cancelAddonFn({ data: { token, addonSubscriptionId } }),
    onSuccess: () => { toast.success("Add-on canceled"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });

  const startSetupMut = useMutation({
    mutationFn: () => startSetupFn({ data: { token, returnUrl: window.location.href } }),
    onSuccess: (r) => { window.location.href = r.url; },
    onError: (e) => toast.error((e as Error).message),
  });

  const setAutopayMut = useMutation({
    mutationFn: (enabled: boolean) => setAutopayFn({ data: { token, enabled } }),
    onSuccess: (r) => { toast.success(r.enabled ? "Autopay on" : "Autopay off"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });

  const removeCardMut = useMutation({
    mutationFn: () => removeCardFn({ data: { token } }),
    onSuccess: () => { toast.success("Card removed"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });

  const paySavedMut = useMutation({
    mutationFn: (invoiceId: string) => payWithSavedFn({ data: { token, invoiceId } }),
    onSuccess: () => { toast.success("Payment submitted"); invalidatePortal(); },
    onError: (e) => toast.error((e as Error).message),
  });


  if (clientQ.isLoading) {
    return <div className="mx-auto max-w-3xl p-8 text-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (clientQ.error || !clientQ.data) {
    return <div className="mx-auto max-w-md p-8 text-center">Invalid or expired portal link.</div>;
  }

  const c = clientQ.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
      <header className="border-b pb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{c.org_name}</div>
            <h1 className="mt-1 text-2xl font-semibold">Hello, {c.display_name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Prepaid balance: <span className="font-medium text-foreground">{money(c.credit_balance_cents)}</span>
            </p>
          </div>
          <PushToggle portalToken={token} />
        </div>
      </header>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Upcoming visits</h2>
        {(visitsQ.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No visits scheduled.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {visitsQ.data!.map((v) => (
              <VisitRow key={v.visit_id} v={v}
                        onSkip={(reason) => skipMut.mutate({ visitId: v.visit_id, reason })}
                        onReschedule={(newDate) => rescheduleMut.mutate({ visitId: v.visit_id, newDate })} />
            ))}
          </ul>
        )}
      </section>

      {(subsQ.data ?? []).length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Your plan</h2>
          <ul className="space-y-2">
            {subsQ.data!.map((s) => (
              <PlanRow key={`plan-${s.subscription_id}`} s={s}
                       onChange={(f) => freqMut.mutate({ subscriptionId: s.subscription_id, frequency: f })}
                       pending={freqMut.isPending} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-lg font-semibold">Your add-ons</h2>
        {(clientAddonsQ.data ?? []).filter((a) => a.status === "active").length === 0 ? (
          <p className="text-sm text-muted-foreground">No active add-ons.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {clientAddonsQ.data!.filter((a) => a.status === "active").map((a) => (
              <li key={a.addon_subscription_id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div>
                  <div className="font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {money(a.price_cents)} · {a.frequency} · next {a.next_charge_on}
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

        {(catalogQ.data ?? []).length > 0 && (
          <>
            <h3 className="mt-4 mb-2 text-sm font-semibold text-muted-foreground">Available add-ons</h3>
            <ul className="space-y-2">
              {catalogQ.data!.map((a) => (
                <AddonCatalogRow key={a.addon_service_id} a={a}
                                 onSubscribe={(freq, qty) => subscribeAddonMut.mutate({
                                   addonServiceId: a.addon_service_id, frequency: freq, quantity: qty,
                                 })}
                                 pending={subscribeAddonMut.isPending} />
              ))}
            </ul>
          </>
        )}
      </section>


      {(subsQ.data ?? []).length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Prepaid top-up</h2>
          <ul className="space-y-2">
            {subsQ.data!.map((s) => (
              <TopupRow key={s.subscription_id} s={s}
                        onSubmit={(count) => topupMut.mutate({ subscriptionId: s.subscription_id, visitCount: count })}
                        pending={topupMut.isPending} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-lg font-semibold">Payment method</h2>
        <div className="rounded-md border p-3 text-sm space-y-3">
          {c.has_saved_card ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium capitalize">
                    {c.card_brand ?? "Card"} ending in {c.card_last4 ?? "····"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Autopay {c.autopay_enabled ? "on — open invoices will be charged automatically." : "off."}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant={c.autopay_enabled ? "outline" : "default"}
                          disabled={setAutopayMut.isPending}
                          onClick={() => setAutopayMut.mutate(!c.autopay_enabled)}>
                    {c.autopay_enabled ? "Turn off autopay" : "Turn on autopay"}
                  </Button>
                  <Button size="sm" variant="outline"
                          disabled={removeCardMut.isPending}
                          onClick={() => removeCardMut.mutate()}>
                    Remove
                  </Button>
                </div>
              </div>
              <Button size="sm" variant="ghost"
                      disabled={startSetupMut.isPending}
                      onClick={() => startSetupMut.mutate()}>
                Replace card
              </Button>
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-muted-foreground">
                Save a card once and pay open invoices with a single tap — or enable autopay.
              </div>
              <Button size="sm" disabled={startSetupMut.isPending}
                      onClick={() => startSetupMut.mutate()}>
                Add card
              </Button>
            </div>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Invoices</h2>
        {(invoicesQ.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {invoicesQ.data!.map((i) => (
              <li key={i.invoice_id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <div>
                  <div className="font-mono text-xs text-muted-foreground">#{i.invoice_id.slice(0, 8)}</div>
                  <div>{money(i.total_cents)} · <Badge variant={i.status === "paid" ? "default" : i.status === "void" ? "outline" : "secondary"}>{i.status}</Badge> · <span className="text-muted-foreground">{i.kind}</span></div>
                  {i.period_start && <div className="text-xs text-muted-foreground">{i.period_start} → {i.period_end}</div>}
                </div>
                {i.status !== "paid" && i.status !== "void" && (
                  <div className="flex gap-2">
                    {c.has_saved_card && (
                      <Button size="sm" variant="default"
                              disabled={paySavedMut.isPending}
                              onClick={() => paySavedMut.mutate(i.invoice_id)}>
                        Pay with saved card
                      </Button>
                    )}
                    <Button size="sm" variant={c.has_saved_card ? "outline" : "default"}
                            disabled={payMut.isPending}
                            onClick={() => payMut.mutate(i.invoice_id)}>
                      Pay now
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

    </div>
  );
}

function VisitRow({ v, onSkip, onReschedule }: {
  v: { visit_id: string; scheduled_on: string; status: string; street: string | null; city: string | null; postal_code: string | null };
  onSkip: (reason: string) => void;
  onReschedule: (newDate: string) => void;
}) {
  const [skipOpen, setSkipOpen] = useState(false);
  const [reschedOpen, setReschedOpen] = useState(false);
  const [reason, setReason] = useState("");
  const minDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const maxDate = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const [newDate, setNewDate] = useState(minDate);
  return (
    <li className="p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">{v.scheduled_on}</div>
          <div className="text-xs text-muted-foreground">
            {[v.street, v.city, v.postal_code].filter(Boolean).join(", ") || "Address on file"}
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => { setReschedOpen((o) => !o); setSkipOpen(false); }}>
            {reschedOpen ? "Cancel" : "Reschedule"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => { setSkipOpen((o) => !o); setReschedOpen(false); }}>
            {skipOpen ? "Cancel" : "Skip"}
          </Button>
        </div>
      </div>
      {reschedOpen && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor={`d-${v.visit_id}`} className="text-xs">New date</Label>
            <Input id={`d-${v.visit_id}`} type="date" min={minDate} max={maxDate}
                   value={newDate} onChange={(e) => setNewDate(e.target.value)} className="w-40" />
          </div>
          <Button size="sm" onClick={() => { onReschedule(newDate); setReschedOpen(false); }}>
            Confirm reschedule
          </Button>
        </div>
      )}
      {skipOpen && (
        <div className="mt-3 space-y-2">
          <Label htmlFor={`r-${v.visit_id}`} className="text-xs">Reason (optional)</Label>
          <Input id={`r-${v.visit_id}`} value={reason} onChange={(e) => setReason(e.target.value)}
                 placeholder="Out of town, etc." />
          <Button size="sm" onClick={() => { onSkip(reason); setSkipOpen(false); setReason(""); }}>
            Confirm skip
          </Button>
        </div>
      )}
    </li>
  );
}

function PlanRow({ s, onChange, pending }: {
  s: { subscription_id: string; frequency: string; property_label: string | null; price_cents: number };
  onChange: (f: "weekly" | "biweekly" | "twice_weekly" | "monthly") => void;
  pending: boolean;
}) {
  const [freq, setFreq] = useState<string>(s.frequency);
  return (
    <li className="flex flex-wrap items-end gap-3 rounded-md border p-3 text-sm">
      <div className="flex-1">
        <div className="font-medium">{s.property_label ?? "Service"}</div>
        <div className="text-xs text-muted-foreground">Currently {s.frequency} · {money(s.price_cents)} / visit</div>
      </div>
      <div>
        <Label className="text-xs">Change frequency</Label>
        <Select value={freq} onValueChange={setFreq}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="weekly">Weekly</SelectItem>
            <SelectItem value="biweekly">Biweekly</SelectItem>
            <SelectItem value="twice_weekly">Twice weekly</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button size="sm" disabled={pending || freq === s.frequency}
              onClick={() => onChange(freq as "weekly" | "biweekly" | "twice_weekly" | "monthly")}>
        Update plan
      </Button>
    </li>
  );
}

function AddonCatalogRow({ a, onSubscribe, pending }: {
  a: { addon_service_id: string; name: string; description: string | null; kind: string;
       unit_price_cents: number; default_frequency: string | null };
  onSubscribe: (freq: "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | null, qty: number) => void;
  pending: boolean;
}) {
  const [qty, setQty] = useState(1);
  const [freq, setFreq] = useState<string>(a.default_frequency ?? "monthly");
  const isRecurring = a.kind === "recurring";
  return (
    <li className="flex flex-wrap items-end gap-3 rounded-md border p-3 text-sm">
      <div className="flex-1 min-w-[12rem]">
        <div className="font-medium">{a.name}</div>
        {a.description && <div className="text-xs text-muted-foreground">{a.description}</div>}
        <div className="text-xs text-muted-foreground">{money(a.unit_price_cents)} · {a.kind === "recurring" ? "recurring" : "one-time"}</div>
      </div>
      <div>
        <Label className="text-xs">Qty</Label>
        <Input type="number" min={1} max={50} value={qty}
               onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} className="w-20" />
      </div>
      {isRecurring && (
        <div>
          <Label className="text-xs">Frequency</Label>
          <Select value={freq} onValueChange={setFreq}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="biweekly">Biweekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
              <SelectItem value="yearly">Yearly</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <Button size="sm" disabled={pending}
              onClick={() => onSubscribe(isRecurring ? (freq as any) : null, qty)}>
        {isRecurring ? "Subscribe" : "Add"}
      </Button>
    </li>
  );
}

function TopupRow({ s, onSubmit, pending }: { s: { subscription_id: string; price_cents: number; frequency: string; property_label: string | null }; onSubmit: (count: number) => void; pending: boolean }) {
  const [count, setCount] = useState(4);
  return (
    <li className="flex flex-wrap items-end gap-3 rounded-md border p-3 text-sm">
      <div className="flex-1">
        <div className="font-medium">{s.property_label ?? "Service"} · {s.frequency}</div>
        <div className="text-xs text-muted-foreground">{money(s.price_cents)} per visit</div>
      </div>
      <div>
        <Label htmlFor={`n-${s.subscription_id}`} className="text-xs">Visits</Label>
        <Input id={`n-${s.subscription_id}`} type="number" min={1} max={52} value={count}
               onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))} className="w-24" />
      </div>
      <div className="text-sm font-medium">= {money(count * s.price_cents)}</div>
      <Button size="sm" disabled={pending} onClick={() => onSubmit(count)}>Pay & top up</Button>
    </li>
  );
}
