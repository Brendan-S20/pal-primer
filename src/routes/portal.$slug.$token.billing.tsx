import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  portalCreateSetupIntent,
  portalFinalizeCardSetup,
  portalStartPrepaidTopup,
} from "@/lib/portal.functions";
import {
  usePortalCtx, EmptyBox, InvoiceStatusBadge, PromoRedeemCard, TopupRow,
  fmtDayShort, money,
} from "@/lib/portal-ui";

export const Route = createFileRoute("/portal/$slug/$token/billing")({
  component: PortalBilling,
});

// Cache Stripe.js per (publishable key + connected account) — Connect direct
// charges require the Payment Element scoped to the connected account.
const stripeCache = new Map<string, Promise<StripeJs | null>>();
function getStripe(pk: string, stripeAccount?: string) {
  const key = `${pk}|${stripeAccount ?? ""}`;
  let p = stripeCache.get(key);
  if (!p) { p = loadStripe(pk, stripeAccount ? { stripeAccount } : undefined); stripeCache.set(key, p); }
  return p;
}

function PortalBilling() {
  const { slug, token } = Route.useParams();
  const navigate = useNavigate();
  const {
    clientQ, invoicesQ, subsQ,
    setAutopayMut, removeCardMut, paySavedMut, promoMut,
  } = usePortalCtx();
  const c = clientQ.data as any;
  const [showCard, setShowCard] = useState(false);

  // In-app top-up: create the prepaid invoice, then pay it on the in-app pay
  // page (embedded checkout) instead of redirecting to hosted Stripe Checkout.
  const topupFn = useServerFn(portalStartPrepaidTopup);
  const topupMut = useMutation({
    mutationFn: (v: { subscriptionId: string; visitCount: number }) =>
      topupFn({ data: { token, ...v } }),
    onSuccess: (r) =>
      navigate({
        to: "/portal/$slug/$token/pay/$invoiceId",
        params: { slug, token, invoiceId: r.invoiceId },
      }),
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Billing</h2>

      {/* Payment method */}
      <div className="rounded-md border bg-card p-3 text-sm space-y-3">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Payment method</p>
        {c?.has_saved_card ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium capitalize">
                  {c.card_brand ?? "Card"} ending in {c.card_last4 ?? "····"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Autopay {c.autopay_enabled ? "on. Open invoices are charged automatically." : "off."}
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
            <Button size="sm" variant="ghost" onClick={() => setShowCard((v) => !v)}>
              {showCard ? "Cancel" : "Replace card"}
            </Button>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-muted-foreground">
              Save a card for one-tap payments, or enable autopay.
            </div>
            <Button size="sm" onClick={() => setShowCard((v) => !v)}>
              {showCard ? "Cancel" : "Add payment method"}
            </Button>
          </div>
        )}
        {showCard && (
          <CardSetup
            token={token}
            onDone={() => { setShowCard(false); clientQ.refetch(); }}
          />
        )}
        <p className="text-xs text-muted-foreground">
          We accept credit/debit cards and ACH bank transfers via Stripe. Your data never touches our servers.
        </p>
      </div>

      <PromoRedeemCard onSubmit={(code) => promoMut.mutate(code)} pending={promoMut.isPending} />

      <div>
        <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Invoices</p>
        {(invoicesQ.data ?? []).length === 0 ? (
          <EmptyBox title="No invoices yet" body="Your first invoice will appear here after service." />
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {invoicesQ.data!.map((i, idx) => {
              const invNo = `#${String((invoicesQ.data ?? []).length - idx).padStart(4, "0")}`;
              const label = i.kind === "prepaid_topup" ? "Prepaid top-up"
                : i.period_start ? `Service ${fmtDayShort(i.period_start)} - ${fmtDayShort(i.period_end)}`
                : "Service";
              return (
                <li key={i.invoice_id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div>
                    <div className="font-medium">
                      Invoice {invNo}
                      <span className="text-muted-foreground"> ({label})</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="font-semibold">{money(i.total_cents)}</span>
                      <InvoiceStatusBadge status={i.status} />
                      {i.issued_at && (
                        <span className="text-xs text-muted-foreground">Issued {fmtDayShort(i.issued_at)}</span>
                      )}
                    </div>
                  </div>
                  {i.status !== "paid" && i.status !== "void" && (
                    <div className="flex gap-2">
                      {c?.has_saved_card && (
                        <Button size="sm" variant="default"
                          disabled={paySavedMut.isPending}
                          onClick={() => paySavedMut.mutate(i.invoice_id)}>
                          Pay with saved card
                        </Button>
                      )}
                      <Button asChild size="sm" variant={c?.has_saved_card ? "outline" : "default"}>
                        <Link to="/portal/$slug/$token/pay/$invoiceId" params={{ slug, token, invoiceId: i.invoice_id }}>
                          Pay now
                        </Link>
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {(subsQ.data ?? []).length > 0 && (
        <div>
          <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Prepaid top-up</p>
          <ul className="space-y-2">
            {subsQ.data!.map((s) => (
              <TopupRow key={s.subscription_id} s={s}
                onSubmit={(count) => topupMut.mutate({ subscriptionId: s.subscription_id, visitCount: count })}
                pending={topupMut.isPending} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Inline (embedded) card save via the Stripe Payment Element on the connected
// account — replaces the old hosted-Checkout redirect.
function CardSetup({ token, onDone }: { token: string; onDone: () => void }) {
  const createFn = useServerFn(portalCreateSetupIntent);
  const q = useQuery({
    queryKey: ["portal-setup-intent", token],
    queryFn: () => createFn({ data: { token } }),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const stripePromise = useMemo(
    () => (q.data ? getStripe((q.data as any).publishableKey, (q.data as any).stripeAccount) : null),
    [(q.data as any)?.publishableKey, (q.data as any)?.stripeAccount],
  );

  if (q.isLoading) return <p className="text-xs text-muted-foreground">Loading secure card form…</p>;
  if (q.error) return <p className="text-xs text-destructive">{(q.error as Error).message}</p>;
  if (!q.data || !stripePromise) return null;

  return (
    <div className="rounded-md border bg-background p-3">
      <Elements stripe={stripePromise} options={{ clientSecret: (q.data as any).clientSecret }}>
        <CardSetupInner token={token} onDone={onDone} />
      </Elements>
    </div>
  );
}

function CardSetupInner({ token, onDone }: { token: string; onDone: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const finalizeFn = useServerFn(portalFinalizeCardSetup);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    try {
      const { error, setupIntent } = await stripe.confirmSetup({ elements, redirect: "if_required" });
      if (error) { toast.error(error.message ?? "Couldn't save the card"); return; }
      if (!setupIntent?.id) { toast.error("Card wasn't saved. Please try again."); return; }
      await finalizeFn({ data: { token, setupIntentId: setupIntent.id } });
      toast.success("Card saved");
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <PaymentElement />
      <Button type="submit" size="sm" disabled={busy || !stripe}>
        {busy ? "Saving…" : "Save card"}
      </Button>
    </form>
  );
}
