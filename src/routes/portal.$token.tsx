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
} from "@/lib/portal.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

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
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{c.org_name}</div>
        <h1 className="mt-1 text-2xl font-semibold">Hello, {c.display_name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Prepaid balance: <span className="font-medium text-foreground">{money(c.credit_balance_cents)}</span>
        </p>
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
                  <Button size="sm" disabled={payMut.isPending} onClick={() => payMut.mutate(i.invoice_id)}>
                    Pay now
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function VisitRow({ v, onSkip }: { v: { visit_id: string; scheduled_on: string; status: string; street: string | null; city: string | null; postal_code: string | null }; onSkip: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <li className="p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">{v.scheduled_on}</div>
          <div className="text-xs text-muted-foreground">
            {[v.street, v.city, v.postal_code].filter(Boolean).join(", ") || "Address on file"}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : "Request skip"}
        </Button>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          <Label htmlFor={`r-${v.visit_id}`} className="text-xs">Reason (optional)</Label>
          <Input id={`r-${v.visit_id}`} value={reason} onChange={(e) => setReason(e.target.value)}
                 placeholder="Out of town, etc." />
          <Button size="sm" onClick={() => { onSkip(reason); setOpen(false); setReason(""); }}>
            Confirm skip
          </Button>
        </div>
      )}
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
