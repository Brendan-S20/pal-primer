import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { toast } from "sonner";
import {
  portalCreateSetupIntent,
  portalFinalizeCardSetup,
  portalStartPrepaidTopup,
} from "@/lib/portal.functions";
import {
  usePortalCtx,
  EmptyBox,
  InvoiceStatusBadge,
  PromoRedeemCard,
  TopupRow,
  fmtDayShort,
  money,
} from "@/lib/portal-ui";
import { invoiceKindLabel } from "@/lib/invoice-labels";

export const Route = createFileRoute("/portal/$slug/$token/billing")({
  component: PortalBilling,
  // The pay page has always navigated here with `?paid=…` after a successful
  // charge — from the embedded flow and from the ACH redirect return — and
  // nothing on this route read it. Somebody who had just handed over money
  // landed on a list of invoices with no acknowledgement that anything had
  // happened. Declaring it is what makes it readable at all.
  //
  // `paid` is OPTIONAL in the return type, and the key is omitted rather than
  // set to undefined when absent. A validator that always returns the key
  // makes `search` a required prop on every <Link> to this route, and there
  // are three of them that have no business knowing about payment status.
  validateSearch: (search: Record<string, unknown>): { paid?: "succeeded" | "processing" } =>
    search.paid === "succeeded" || search.paid === "processing" ? { paid: search.paid } : {},
});

// Cache Stripe.js per (publishable key + connected account) — Connect direct
// charges require the Payment Element scoped to the connected account.
const stripeCache = new Map<string, Promise<StripeJs | null>>();
function getStripe(pk: string, stripeAccount?: string) {
  const key = `${pk}|${stripeAccount ?? ""}`;
  let p = stripeCache.get(key);
  if (!p) {
    p = loadStripe(pk, stripeAccount ? { stripeAccount } : undefined);
    stripeCache.set(key, p);
  }
  return p;
}

function PortalBilling() {
  const { slug, token } = Route.useParams();
  const { paid } = Route.useSearch();
  const navigate = useNavigate();
  const { clientQ, invoicesQ, subsQ, setAutopayMut, removeCardMut, paySavedMut, promoMut } =
    usePortalCtx();
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

      {paid && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm"
        >
          <div>
            <div className="font-medium">
              {paid === "processing" ? "Payment started" : "Payment received"}
            </div>
            <p className="mt-0.5 text-muted-foreground">
              {paid === "processing"
                ? // ACH takes days to settle. Saying "received" here is the
                  // reassurance a customer acts on — and then the invoice
                  // still reads open tomorrow and they call.
                  "Bank payments take a few business days to clear. We'll email you when it does, and the invoice below stays open until then."
                : "Thanks — your invoice below is marked paid. A receipt is on its way to your email."}
            </p>
          </div>
          <button
            onClick={() =>
              navigate({
                to: "/portal/$slug/$token/billing",
                params: { slug, token },
                search: {} as never,
                replace: true,
              })
            }
            className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

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
                  Autopay{" "}
                  {c.autopay_enabled ? "on. Open invoices are charged automatically." : "off."}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={c.autopay_enabled ? "outline" : "default"}
                  disabled={setAutopayMut.isPending}
                  onClick={() => setAutopayMut.mutate(!c.autopay_enabled)}
                >
                  {c.autopay_enabled ? "Turn off autopay" : "Turn on autopay"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={removeCardMut.isPending}
                  onClick={() => removeCardMut.mutate()}
                >
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
            onDone={() => {
              setShowCard(false);
              clientQ.refetch();
            }}
          />
        )}
        <p className="text-xs text-muted-foreground">
          We accept credit and debit cards plus ACH bank transfers. Your card details never touch
          our servers.
        </p>
      </div>

      <PromoRedeemCard onSubmit={(code) => promoMut.mutate(code)} pending={promoMut.isPending} />

      <div>
        <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Invoices</p>
        {/* G1: surface the real debt — open count, total, due dates, overdue. */}
        {(invoicesQ.data?.openCount ?? 0) > 0 && (
          <p className="mb-2 text-sm">
            <span className="font-medium">
              {invoicesQ.data!.openCount} open invoice{invoicesQ.data!.openCount === 1 ? "" : "s"} ·{" "}
              {money(invoicesQ.data!.openTotalCents)}
            </span>
            {(invoicesQ.data!.overdueCount ?? 0) > 0 && (
              <span className="font-medium text-destructive">
                {" "}
                · {invoicesQ.data!.overdueCount} overdue
              </span>
            )}
          </p>
        )}
        {(invoicesQ.data?.invoices ?? []).length === 0 ? (
          <EmptyBox
            title="No invoices yet"
            body="Your first invoice will appear here after service."
          />
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {invoicesQ.data!.invoices.map((i, idx) => {
              const invNo = `#${String(invoicesQ.data!.invoices.length - idx).padStart(4, "0")}`;
              const label =
                i.kind === "prepaid_topup"
                  ? invoiceKindLabel(i.kind)
                  : i.period_start
                    ? `Service ${fmtDayShort(i.period_start)} - ${fmtDayShort(i.period_end)}`
                    : "Service";
              return (
                <li
                  key={i.invoice_id}
                  className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
                >
                  <div>
                    <div className="font-medium">
                      Invoice {invNo}
                      <span className="text-muted-foreground"> ({label})</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <span className="font-semibold">
                        {money(i.status === "open" ? i.amount_due_cents : i.total_cents)}
                      </span>
                      {i.status === "open" && (i.credit_applied_cents ?? 0) > 0 && (
                        <span className="text-xs text-muted-foreground">
                          after {money(i.credit_applied_cents)} credit
                        </span>
                      )}
                      <InvoiceStatusBadge status={i.status} />
                      {i.overdue && (
                        <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                          Overdue
                        </span>
                      )}
                      {i.due_on && i.status === "open" && (
                        <span
                          className={`text-xs ${i.overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}
                        >
                          Due {fmtDayShort(i.due_on)}
                        </span>
                      )}
                      {i.issued_at && (
                        <span className="text-xs text-muted-foreground">
                          Issued {fmtDayShort(i.issued_at)}
                        </span>
                      )}
                    </div>
                  </div>
                  {i.status !== "paid" && i.status !== "void" && (
                    <div className="flex gap-2">
                      {c?.has_saved_card && (
                        <Button
                          size="sm"
                          variant="default"
                          disabled={paySavedMut.isPending}
                          onClick={() => paySavedMut.mutate(i.invoice_id)}
                        >
                          Pay with saved card
                        </Button>
                      )}
                      <Button asChild size="sm" variant={c?.has_saved_card ? "outline" : "default"}>
                        <Link
                          to="/portal/$slug/$token/pay/$invoiceId"
                          params={{ slug, token, invoiceId: i.invoice_id }}
                        >
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
          <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
            Prepaid top-up
          </p>
          <ul className="space-y-2">
            {subsQ.data!.map((s) => (
              <TopupRow
                key={s.subscription_id}
                s={s}
                onSubmit={(count) =>
                  topupMut.mutate({ subscriptionId: s.subscription_id, visitCount: count })
                }
                pending={topupMut.isPending}
              />
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
    () =>
      q.data ? getStripe((q.data as any).publishableKey, (q.data as any).stripeAccount) : null,
    [(q.data as any)?.publishableKey, (q.data as any)?.stripeAccount],
  );

  if (q.isLoading)
    return <p className="text-xs text-muted-foreground">Loading secure card form…</p>;
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
      const { error, setupIntent } = await stripe.confirmSetup({
        elements,
        redirect: "if_required",
      });
      if (error) {
        toast.error(error.message ?? "Couldn't save the card");
        return;
      }
      if (!setupIntent?.id) {
        toast.error("Card wasn't saved. Please try again.");
        return;
      }
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
