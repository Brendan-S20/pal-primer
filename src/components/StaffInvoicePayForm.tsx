// Shared staff payment collection panel (QA round 3 B2/I3/I8): the ONE
// implementation of "take a payment on an invoice", used by both the invoice
// drawer (payment happens inside the popup, no navigation) and the full
// invoice page. Three parts, every action stating the exact instrument and
// amount — no bare "Pay $X" anywhere:
//   1. Saved card:  "Charge {brand} ····{last4} $X.XX" → chargeAutopayForInvoice
//      (credits auto-apply first server-side), behind a styled confirm.
//   2. Credit:      "Apply credit ($Y available)" → applyCreditToInvoice,
//      showing the remaining due it would leave.
//   3. New card:    the Payment Element form (createInvoicePaymentIntent +
//      Elements on the org's connected account), explicit card entry.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { toast } from "sonner";
import { CreditCard, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/client-detail/primitives";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { stripeAppearance } from "@/lib/stripe-appearance";
import {
  getInvoiceDetail,
  createInvoicePaymentIntent,
  getClientCredit,
  applyCreditToInvoice,
  chargeAutopayForInvoice,
  reconcileInvoiceNow,
} from "@/lib/invoices.functions";

// Contracts for the credit/autopay server fns (owned by invoices.functions.ts).
type ChargeAutopayResult = { appliedCreditCents: number; chargedCents: number; status: string };
type ApplyCreditResult = { appliedCents: number; remainingDueCents: number; invoiceStatus: string };

function fmtCents(c: number | null | undefined, currency = "usd") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format((c ?? 0) / 100);
}

// Connect Payment Element: stripe.js must be initialized scoped to the org's
// connected account (the intent lives there). Cached per key+account at
// module scope so repeated opens never re-download stripe.js.
const connectStripeCache = new Map<string, Promise<StripeJs | null>>();
function getConnectStripe(pk: string, stripeAccount: string) {
  const key = `${pk}|${stripeAccount}`;
  let p = connectStripeCache.get(key);
  if (!p) {
    p = loadStripe(pk, { stripeAccount });
    connectStripeCache.set(key, p);
  }
  return p;
}

export function StaffInvoicePayForm({
  invoiceId,
  onPaid,
}: {
  invoiceId: string;
  /** Called after any successful money movement (charge, credit application,
   * card payment) so the host surface can refresh its invoice data. */
  onPaid: () => void;
}) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();

  const detailFn = useServerFn(getInvoiceDetail);
  const creditFn = useServerFn(getClientCredit);
  const intentFn = useServerFn(createInvoicePaymentIntent);
  const chargeAutopayFn = useServerFn(chargeAutopayForInvoice);
  const applyCreditFn = useServerFn(applyCreditToInvoice);
  const reconcileFn = useServerFn(reconcileInvoiceNow);

  // Same query key the invoice drawer uses — opening the pay view inside the
  // drawer reuses the already-fetched detail instead of refetching.
  const detailQ = useQuery({
    queryKey: ["invoice-detail", invoiceId],
    queryFn: () => detailFn({ data: { invoiceId } }),
  });
  const inv = detailQ.data?.invoice;
  const client = detailQ.data?.client;
  const currency = inv?.currency ?? "usd";

  const creditQ = useQuery({
    queryKey: ["client-credit", client?.id],
    queryFn: () => creditFn({ data: { clientId: client!.id } }),
    enabled: !!client?.id,
  });
  const creditCents = creditQ.data?.balanceCents ?? 0;

  // Remaining due: total minus applied credit (tracked on the invoice — credit
  // applications write no payments row, payments is the cash ledger) minus
  // already-succeeded cash payments (partial ACH etc.).
  const creditAppliedCents = inv?.credit_applied_cents ?? 0;
  // `succeeded` is the only settled value payment_status has — there is no
  // "paid" member on that enum, so don't test for one.
  const paidCents = (detailQ.data?.payments ?? [])
    .filter((p) => p.status === "succeeded")
    .reduce((s, p) => s + (p.amount_cents ?? 0), 0);
  const dueCents = Math.max(0, (inv?.total_cents ?? 0) - creditAppliedCents - paidCents);

  const hasSavedCard = !!client?.default_payment_method_id;
  const cardLabel = `${client?.default_card_brand ?? "card"} ····${client?.default_card_last4 ?? ""}`;

  const refresh = () => {
    // A payment changes every money surface at once — refresh them all so the
    // result reflects everywhere without a manual reload (QA: "did not
    // reflect paid until I refreshed the session").
    qc.invalidateQueries({ queryKey: ["invoice-detail", invoiceId] });
    if (client?.id) {
      qc.invalidateQueries({ queryKey: ["client-credit", client.id] });
      // The client-detail billing tab reads its credit under ["credit", id].
      qc.invalidateQueries({ queryKey: ["credit", client.id] });
    }
    qc.invalidateQueries({ queryKey: ["invoices"] });
    // Roster balances (outstanding / credit columns) on the Clients list.
    qc.invalidateQueries({ queryKey: ["clients"] });
    qc.invalidateQueries({ queryKey: ["billing-summary"] });
    qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
    onPaid();
  };

  // 1. Saved card — credits auto-apply first, then the card is charged.
  const chargeMut = useMutation({
    mutationFn: async () =>
      (await chargeAutopayFn({ data: { invoiceId } })) as ChargeAutopayResult,
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.appliedCreditCents > 0)
        parts.push(`${fmtCents(r.appliedCreditCents, currency)} credit applied`);
      if (r.chargedCents > 0)
        parts.push(
          r.status === "processing"
            ? `${fmtCents(r.chargedCents, currency)} charge started (bank payments take a few days to clear)`
            : `${fmtCents(r.chargedCents, currency)} charged to ${cardLabel}`,
        );
      toast.success(parts.length ? `Payment collected: ${parts.join(", ")}.` : "Invoice settled.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // 2. Account credit only.
  const creditMut = useMutation({
    mutationFn: async () =>
      (await applyCreditFn({ data: { invoiceId } })) as ApplyCreditResult,
    onSuccess: (r) => {
      toast.success(
        r.remainingDueCents > 0
          ? `Applied ${fmtCents(r.appliedCents, currency)} credit. ${fmtCents(r.remainingDueCents, currency)} still due.`
          : `Applied ${fmtCents(r.appliedCents, currency)} credit. Invoice paid in full.`,
      );
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // 3. New card entry via the Payment Element.
  const [intent, setIntent] = useState<{
    clientSecret: string;
    publishableKey: string;
    stripeAccount: string;
    amountCents: number;
    currency: string;
  } | null>(null);
  const intentM = useMutation({
    mutationFn: async () => intentFn({ data: { id: invoiceId } }),
    onSuccess: (r) => setIntent(r),
    onError: (e: Error) => toast.error(e.message),
  });

  // No saved card and no credit → card entry is the only path; open it
  // without an extra click. (Intent creation is idempotent server-side.)
  const onlyCardPath =
    !!inv && detailQ.isSuccess && !hasSavedCard && creditQ.isSuccess && creditCents <= 0;
  useEffect(() => {
    if (onlyCardPath && !intent && !intentM.isPending && !intentM.isError) intentM.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyCardPath]);

  if (detailQ.isLoading || !inv) {
    return <p className="text-sm text-muted-foreground">Loading payment options…</p>;
  }
  if (inv.status !== "open") {
    return (
      <p className="text-sm text-muted-foreground">
        This invoice is {inv.status === "paid" ? "already paid" : "not payable"}.
      </p>
    );
  }

  const creditCovers = creditCents >= dueCents;
  const remainingAfterCredit = Math.max(0, dueCents - creditCents);

  return (
    <div className="space-y-4 text-sm">
      {dialog}

      <div>
        <SectionLabel>Amount due</SectionLabel>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{fmtCents(dueCents, currency)}</p>
        {client?.display_name && (
          <p className="text-xs text-muted-foreground">Billed to {client.display_name}</p>
        )}
      </div>

      {/* 1. Saved default card — exact instrument + exact amount on the button. */}
      {hasSavedCard && (
        <div className="rounded-lg border bg-card p-3">
          <SectionLabel>Saved card</SectionLabel>
          <Button
            className="mt-2 w-full"
            disabled={chargeMut.isPending || dueCents <= 0}
            onClick={async () => {
              if (
                await confirm({
                  title: `Charge ${cardLabel}?`,
                  description:
                    creditCents > 0
                      ? `${fmtCents(Math.min(creditCents, dueCents), currency)} of account credit is applied first, then ${fmtCents(remainingAfterCredit, currency)} is charged to the saved card.`
                      : `The client's saved card will be charged ${fmtCents(dueCents, currency)} now.`,
                  confirmLabel: "Charge card",
                })
              )
                chargeMut.mutate();
            }}
          >
            <CreditCard className="mr-1.5 h-4 w-4" />
            {chargeMut.isPending
              ? "Charging…"
              : `Charge ${cardLabel} ${fmtCents(dueCents, currency)}`}
          </Button>
          {creditCents > 0 && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Account credit is applied before the card is charged.
            </p>
          )}
        </div>
      )}

      {/* 2. Account credit. */}
      {creditCents > 0 && (
        <div className="rounded-lg border bg-card p-3">
          <SectionLabel>Account credit</SectionLabel>
          <Button
            variant={hasSavedCard ? "outline" : "default"}
            className="mt-2 w-full"
            disabled={creditMut.isPending || dueCents <= 0}
            onClick={() => creditMut.mutate()}
          >
            <Wallet className="mr-1.5 h-4 w-4" />
            {creditMut.isPending
              ? "Applying…"
              : `Apply credit (${fmtCents(creditCents, currency)} available)`}
          </Button>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {creditCovers
              ? "Covers the full invoice. Nothing else to collect."
              : `Leaves ${fmtCents(remainingAfterCredit, currency)} due after the credit.`}
          </p>
        </div>
      )}

      {/* 3. New card entry. */}
      <div className="rounded-lg border bg-card p-3">
        <SectionLabel>New card</SectionLabel>
        {!intent ? (
          <Button
            variant={hasSavedCard || creditCents > 0 ? "outline" : "default"}
            className="mt-2 w-full"
            disabled={intentM.isPending}
            onClick={() => intentM.mutate()}
          >
            {intentM.isPending ? "Preparing secure form…" : "Enter card or bank details"}
          </Button>
        ) : (
          <div className="mt-2">
            <Elements
              stripe={getConnectStripe(intent.publishableKey, intent.stripeAccount)}
              options={{ clientSecret: intent.clientSecret, appearance: stripeAppearance() }}
            >
              <PayElementForm
                amountCents={intent.amountCents}
                currency={intent.currency}
                onPaid={async () => {
                  setIntent(null);
                  // The Element confirmed client-side; pull the paid state
                  // from Stripe NOW instead of waiting for the webhook, so
                  // the refetch below actually sees "paid".
                  try {
                    await reconcileFn({ data: { invoiceId } });
                    toast.success("Payment received.");
                  } catch {
                    toast.success("Payment received. The invoice will update shortly.");
                  }
                  refresh();
                }}
              />
            </Elements>
            <p className="mt-2 text-xs text-muted-foreground">
              Card charges confirm right away. Bank debits show as pending until they clear.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// Inline Payment Element form: confirm on this page, no redirect for cards.
// Bank-debit methods that need a redirect come back to the current URL with
// ?paid=1, where getInvoice reconciles against Stripe on load.
function PayElementForm({
  amountCents,
  currency,
  onPaid,
}: {
  amountCents: number;
  currency: string;
  onPaid: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: submitError } = await elements.submit();
    if (submitError) {
      setError(submitError.message ?? "Please check the payment details.");
      setSubmitting(false);
      return;
    }

    const base = window.location.href.split("?")[0];
    const { error: confirmError } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${base}?paid=1` },
      redirect: "if_required",
    });

    if (confirmError) {
      setError(confirmError.message ?? "Payment failed. Please try another method.");
      setSubmitting(false);
      return;
    }

    // No redirect needed → charge succeeded (or is processing, e.g. ACH).
    onPaid();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement onReady={() => setReady(true)} />
      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button type="submit" className="w-full" disabled={!stripe || !elements || !ready || submitting}>
        {submitting ? "Processing…" : `Pay ${fmtCents(amountCents, currency)} by card or bank`}
      </Button>
    </form>
  );
}
