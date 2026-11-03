import { useLaunchCopy } from "@/lib/launch-copy";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
// The /pure entry adds js.stripe.com only when loadStripe() runs, on a
// payment screen. The bare entry adds it the moment this module is imported,
// which put Stripe on every page, /auth included (R2-52).
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe as StripeJs } from "@stripe/stripe-js";
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
import { taxLineLabel } from "@/lib/sales-tax";
import { DownloadPdfButton } from "@/components/DownloadPdfButton";
import { portalDownloadInvoicePdf } from "@/lib/document-pdf.functions";

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
  //
  // `card=update` is the deep link from the declined-card email and text and
  // from the invoice emails (buildPortalCardLink): the client lands with the
  // card form already open, so putting a card on file never needs somebody
  // in the office to start a Take payment. Optional for the same reason.
  validateSearch: (
    search: Record<string, unknown>,
  ): { paid?: "succeeded" | "processing"; card?: "update" } => ({
    ...(search.paid === "succeeded" || search.paid === "processing" ? { paid: search.paid } : {}),
    ...(search.card === "update" ? { card: "update" as const } : {}),
  }),
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
  const copy = useLaunchCopy();
  const { slug, token } = Route.useParams();
  const { paid, card } = Route.useSearch();
  const navigate = useNavigate();
  const { clientQ, invoicesQ, subsQ, setAutopayMut, removeCardMut, paySavedMut, promoMut } =
    usePortalCtx();
  const c = clientQ.data as any;
  const [showCard, setShowCard] = useState(card === "update");
  const cardBoxRef = useRef<HTMLDivElement>(null);
  // Arriving from an email link: the card form is the reason they came, so
  // bring it into view rather than leave it below the fold on a phone.
  useEffect(() => {
    if (card === "update") cardBoxRef.current?.scrollIntoView({ block: "start" });
  }, [card]);
  // Once the card is saved (or the form is closed) the link has done its
  // job; drop it from the address so a refresh does not reopen the form.
  const clearCardParam = () => {
    if (card !== "update") return;
    navigate({
      to: "/portal/$slug/$token/billing",
      params: { slug, token },
      search: (prev: Record<string, unknown>) => ({ ...prev, card: undefined }) as never,
      replace: true,
    });
  };
  const toggleCard = () => {
    if (showCard) clearCardParam();
    setShowCard((v) => !v);
  };
  const pdfFn = useServerFn(portalDownloadInvoicePdf);

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
                : "Thanks. Your invoice below is marked paid. A receipt is on its way to your email."}
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
            <X className="h-4 w-4 shrink-0" />
          </button>
        </div>
      )}

      {/* Payment method */}
      <div
        ref={cardBoxRef}
        id="payment-method"
        className="scroll-mt-4 rounded-md border bg-card p-3 text-sm space-y-3"
      >
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Payment method</p>
        {card === "update" && (
          <p className="text-sm">
            {c?.has_saved_card
              ? "Enter your new card below. It replaces the one on file."
              : "Enter your card below to keep it on file. Then pay invoices in one tap, or turn on autopay."}
          </p>
        )}
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
            <Button size="sm" variant="ghost" onClick={toggleCard}>
              {showCard ? "Cancel" : "Replace card"}
            </Button>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-muted-foreground">
              Save a card for one-tap payments, or enable autopay.
            </div>
            <Button size="sm" onClick={toggleCard}>
              {showCard ? "Cancel" : "Add payment method"}
            </Button>
          </div>
        )}
        {showCard && (
          <CardSetup
            token={token}
            onDone={() => {
              setShowCard(false);
              clearCardParam();
              clientQ.refetch();
            }}
          />
        )}
        <p className="text-xs text-muted-foreground">
          {copy("We accept credit and debit cards. Your card details never touch our servers.")}
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
            {invoicesQ.data!.invoices.map((i) => {
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
                      Invoice <span dir="ltr">{i.number_label}</span>
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
                      {/* Partly paid: the amount above is what is left. */}
                      {i.status === "open" && (i.amount_paid_cents ?? 0) > 0 && (
                        <span className="text-xs text-muted-foreground">
                          left of {money(i.total_cents)}, {money(i.amount_paid_cents)} paid
                        </span>
                      )}
                      {/* Sales tax inside the total, only when there is some. */}
                      {(i.tax_cents ?? 0) > 0 && (
                        <span className="text-xs text-muted-foreground">
                          includes {money(i.tax_cents)} {taxLineLabel(i.tax_label, i.tax_rate_bps)}
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
                  <div className="flex flex-wrap gap-2">
                    {/* Every invoice, paid ones included: a paid invoice's PDF
                        is the receipt the customer files. */}
                    <DownloadPdfButton
                      size="sm"
                      label="PDF"
                      load={() => pdfFn({ data: { token, invoiceId: i.invoice_id } })}
                    />
                    {i.status !== "paid" && i.status !== "void" && (
                      <>
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
                        <Button
                          asChild
                          size="sm"
                          variant={c?.has_saved_card ? "outline" : "default"}
                        >
                          <Link
                            to="/portal/$slug/$token/pay/$invoiceId"
                            params={{ slug, token, invoiceId: i.invoice_id }}
                          >
                            Pay now
                          </Link>
                        </Button>
                      </>
                    )}
                  </div>
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
