// Billing tab redesign (spec): Summary, Payment Methods, Invoices, Credits,
// Payments, Billing Settings. Add-ons intentionally live in Services now.
// Cards stay in Stripe; HoundStack never stores card numbers.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CreditCard, Plus } from "lucide-react";
// The /pure entry adds js.stripe.com only when loadStripe() runs, on a
// payment screen. The bare entry adds it the moment this module is imported,
// which put Stripe on every page, /auth included (R2-52).
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@tanstack/react-router";
import {
  EmptyState,
  MetaChip,
  SectionLabel,
  StatusChip,
} from "@/components/client-detail/primitives";
import { formatDay } from "@/lib/format";
import { stripeAppearance } from "@/lib/stripe-appearance";
import { withDeadline, ActionTimeout } from "@/lib/offline/run-or-queue";
import { IS_NATIVE_BUNDLE } from "@/lib/native-build";
import {
  getClientCredit,
  getClientBillingSummary,
  addClientCredit,
} from "@/lib/invoices.functions";
import {
  listClientPaymentMethods,
  setDefaultPaymentMethod,
  removePaymentMethod,
  createSetupIntentForClient,
  finalizeCardSetupForClient,
} from "@/lib/payment-methods.functions";
import { BillingPanel, AutopayResume } from "@/components/client-detail/billing-panels";
import { useConfirmDialog } from "@/components/ConfirmDialog";

/** Autopay with no card on file charges nothing, and "On" beside "No cards
 *  on file" told the office the opposite. */
function autopayLabel(c: any): string {
  if (c?.autopay_paused) return "Paused";
  if (!c?.autopay_enabled) return "Off";
  return c?.default_payment_method_id ? "On" : "On, no card";
}

export function BillingTab({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const getCreditFn = useServerFn(getClientCredit);
  const summaryFn = useServerFn(getClientBillingSummary);
  const [addingCredit, setAddingCredit] = useState(false);

  const { data: credit } = useQuery({
    queryKey: ["credit", clientId],
    queryFn: () => getCreditFn({ data: { clientId } }),
  });
  const { data: summary } = useQuery({
    queryKey: ["billing-summary", clientId],
    queryFn: () => summaryFn({ data: { clientId } }),
  });
  const c = summary?.client as any;

  return (
    <div className="space-y-6">
      {/* Summary */}
      <section className="rounded-lg border bg-card shadow-sm p-5">
        <h2 className="text-sm font-medium">Billing summary</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt>
              <SectionLabel>Outstanding</SectionLabel>
            </dt>
            <dd
              className={`text-lg font-semibold ${(summary?.openTotalCents ?? 0) > 0 ? "text-destructive" : ""}`}
            >
              ${((summary?.openTotalCents ?? 0) / 100).toFixed(2)}
            </dd>
          </div>
          <div>
            <dt>
              <SectionLabel>Open invoices</SectionLabel>
            </dt>
            <dd className="text-lg font-semibold">{summary?.openCount ?? 0}</dd>
          </div>
          <div>
            <dt>
              <SectionLabel>Credit</SectionLabel>
            </dt>
            <dd
              className={`text-lg font-semibold ${(credit?.balanceCents ?? 0) < 0 ? "text-destructive" : ""}`}
            >
              ${((credit?.balanceCents ?? 0) / 100).toFixed(2)}
            </dd>
          </div>
          <div>
            <dt>
              <SectionLabel>Autopay</SectionLabel>
            </dt>
            <dd className="text-lg font-semibold">{autopayLabel(c)}</dd>
          </div>
        </dl>
      </section>

      <PaymentMethodsPanel clientId={clientId} />

      {/* Invoices + Payments (existing panels) */}
      <BillingPanel clientId={clientId} />

      {/* Credits */}
      <section className="rounded-lg border bg-card shadow-sm p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Credits</h2>
          <div className="flex items-center gap-3">
            <span
              className={`text-lg font-semibold ${(credit?.balanceCents ?? 0) < 0 ? "text-destructive" : ""}`}
            >
              ${((credit?.balanceCents ?? 0) / 100).toFixed(2)}
            </span>
            {!addingCredit && (
              <Button size="sm" variant="outline" onClick={() => setAddingCredit(true)}>
                <Plus className="mr-1 h-3.5 w-3.5 shrink-0" /> Add credit
              </Button>
            )}
          </div>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Promo and gift codes are managed in{" "}
          <Link
            to="/settings/promotions"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Settings, Promotions
          </Link>
          .
        </p>
        {addingCredit && (
          <AddCreditForm clientId={clientId} onDone={() => setAddingCredit(false)} />
        )}
        {credit && credit.ledger.length > 0 ? (
          <ul className="mt-3 divide-y text-sm">
            {credit.ledger.map((l: any) => (
              <li key={l.id} className="flex items-center justify-between py-2">
                <span>
                  <span className="text-muted-foreground">{formatDay(l.created_at)}</span>
                  <span className="ml-2">{l.note ?? l.kind}</span>
                </span>
                <span className={l.delta_cents < 0 ? "text-destructive" : "text-primary"}>
                  {l.delta_cents < 0 ? "−" : "+"}${Math.abs(l.delta_cents / 100).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3">
            <EmptyState
              compact
              icon={CreditCard}
              title="No credit activity yet"
              description="Prepaid purchases and referral rewards appear here."
            />
          </div>
        )}
      </section>

      {/* Billing settings */}
      <section className="rounded-lg border bg-card shadow-sm p-5">
        <h2 className="text-sm font-medium">Billing settings</h2>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3 text-sm">
          <div>
            <div>
              Autopay:{" "}
              <StatusChip
                status={
                  c?.autopay_paused || (c?.autopay_enabled && !c?.default_payment_method_id)
                    ? "paused"
                    : c?.autopay_enabled
                      ? "enabled"
                      : "inactive"
                }
                label={autopayLabel(c)}
              />
            </div>
            <p className="mt-2 max-w-md text-xs text-muted-foreground">
              Clients turn autopay on or off from their portal. Billing addresses are kept with the
              card by our payment processor and are not stored in HoundStack.
            </p>
          </div>
          {c?.autopay_paused && (
            <AutopayResume
              clientId={clientId}
              lastError={c?.autopay_last_error}
              onDone={() => qc.invalidateQueries({ queryKey: ["billing-summary", clientId] })}
            />
          )}
        </div>
      </section>
    </div>
  );
}

// ── Add credit (QA round 8) ─────────────────────────────────────────────────

// Staff-issued credit adjustment: amount + reason, both required. Posts to
// the credit ledger (so the balance and history stay in lockstep) and to the
// activity timeline with the actor.
function AddCreditForm({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const addFn = useServerFn(addClientCredit);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const mut = useMutation({
    mutationFn: () => {
      const cents = Math.round(parseFloat(amount) * 100);
      if (!Number.isFinite(cents) || cents === 0) throw new Error("Enter a non-zero amount");
      if (!reason.trim()) throw new Error("A reason is required");
      return addFn({ data: { clientId, amountCents: cents, reason: reason.trim() } });
    },
    onSuccess: (r: any) => {
      toast.success(`Credit updated. New balance $${((r.balanceCents ?? 0) / 100).toFixed(2)}`);
      setAmount("");
      setReason("");
      qc.invalidateQueries({ queryKey: ["credit", clientId] });
      qc.invalidateQueries({ queryKey: ["billing-summary", clientId] });
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <form
      className="mt-3 grid grid-cols-6 items-end gap-2 rounded-md border bg-muted/20 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        mut.mutate();
      }}
    >
      <div className="col-span-6 sm:col-span-1">
        <Label htmlFor="credit-amount" className="text-xs">
          Amount ($)
        </Label>
        <Input
          id="credit-amount"
          className="mt-0.5 h-9"
          type="number"
          step="0.01"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="25.00"
        />
      </div>
      <div className="col-span-6 sm:col-span-3">
        <Label htmlFor="credit-reason" className="text-xs">
          Reason
        </Label>
        <Input
          id="credit-reason"
          className="mt-0.5 h-9"
          required
          maxLength={300}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Missed visit goodwill"
        />
      </div>
      <div className="col-span-6 flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={mut.isPending}>
          {mut.isPending ? "Adding…" : "Add credit"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <p className="col-span-6 text-xs text-muted-foreground">
        Use a negative amount to correct an over-grant. Credit is applied to prepaid balances and
        visible to the client in their portal.
      </p>
    </form>
  );
}

// ── Payment methods (multiple cards, Stripe-backed) ────────────────────────

// Cache Stripe.js per (publishable key + connected account) — Connect setup
// requires the Payment Element scoped to the connected account.
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

function PaymentMethodsPanel({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const listFn = useServerFn(listClientPaymentMethods);
  const setDefaultFn = useServerFn(setDefaultPaymentMethod);
  const removeFn = useServerFn(removePaymentMethod);
  const finalizeFn = useServerFn(finalizeCardSetupForClient);
  const [addOpen, setAddOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["payment-methods", clientId],
    queryFn: () => listFn({ data: { clientId } }),
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["payment-methods", clientId] });
    qc.invalidateQueries({ queryKey: ["billing-summary", clientId] });
  };

  // Redirect-return path: if the card needed a redirect (e.g. 3DS), Stripe
  // sends staff back here with ?setup_intent=…&redirect_status=…. Finalize
  // the save server-side, then scrub the params from the URL.
  const handledRedirect = useRef(false);
  useEffect(() => {
    if (handledRedirect.current || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const setupIntentId = url.searchParams.get("setup_intent");
    const status = url.searchParams.get("redirect_status");
    if (!setupIntentId) return;
    handledRedirect.current = true;
    ["setup_intent", "setup_intent_client_secret", "redirect_status"].forEach((k) =>
      url.searchParams.delete(k),
    );
    window.history.replaceState({}, "", url.toString());
    if (status === "succeeded") {
      finalizeFn({ data: { clientId, setupIntentId } })
        .then((r: any) => {
          toast.success(`Added ${r.brand ?? "card"} ····${r.last4 ?? ""}`);
          invalidate();
        })
        .catch((e) => toast.error((e as Error).message));
    } else {
      toast.error("The card wasn't saved. Please try again.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const defaultMut = useMutation({
    mutationFn: (paymentMethodId: string) => setDefaultFn({ data: { clientId, paymentMethodId } }),
    onSuccess: () => {
      toast.success("Default card updated");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const removeMut = useMutation({
    mutationFn: (paymentMethodId: string) => removeFn({ data: { clientId, paymentMethodId } }),
    onSuccess: () => {
      toast.success("Card removed");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const methods = data?.methods ?? [];

  return (
    <section className="rounded-lg border bg-card shadow-sm p-5">
      {dialog}
      {/* Wraps, like every other title-and-action header in src/: beside a
          two-line description the button goes underneath on a phone rather
          than being squeezed. See tests/a-width-floor-is-not-a-shrink-floor. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">Payment methods</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Card details are stored with our payment processor, never on HoundStack. Autopay charges
            the default card.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAddOpen((v) => !v)}>
          <Plus className="mr-1 h-3.5 w-3.5 shrink-0" /> {addOpen ? "Cancel" : "Add card"}
        </Button>
      </div>

      {addOpen && (
        <div className="mt-3">
          <StaffCardSetup
            clientId={clientId}
            onDone={() => {
              setAddOpen(false);
              qc.removeQueries({ queryKey: ["staff-setup-intent", clientId] });
              invalidate();
            }}
          />
        </div>
      )}

      {isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="mt-3 text-sm text-destructive">{(error as Error).message}</p>
      ) : methods.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            compact
            icon={CreditCard}
            title={`No cards on file${data?.hasCustomer === false ? " (no billing profile yet)" : ""}`}
            description="Add one here or let the client add it from their portal."
            actionLabel="Add card"
            onAction={() => setAddOpen(true)}
          />
        </div>
      ) : (
        <ul className="mt-3 divide-y text-sm">
          {methods.map((m: any) => {
            const expired =
              m.expYear < new Date().getFullYear() ||
              (m.expYear === new Date().getFullYear() && m.expMonth < new Date().getMonth() + 1);
            return (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="capitalize">{m.brand}</span>
                  <span className="font-mono">····{m.last4}</span>
                  <span
                    className={`text-xs ${expired ? "font-medium text-destructive" : "text-muted-foreground"}`}
                  >
                    {String(m.expMonth).padStart(2, "0")}/{String(m.expYear).slice(-2)}
                    {expired ? " expired" : ""}
                  </span>
                  {m.isDefault && <MetaChip>Default</MetaChip>}
                </span>
                <span className="flex items-center gap-1.5">
                  {!m.isDefault && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => defaultMut.mutate(m.id)}
                      disabled={defaultMut.isPending}
                    >
                      Set default
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Remove ${m.brand} ····${m.last4}?`,
                          destructive: true,
                          confirmLabel: "Remove card",
                        })
                      )
                        removeMut.mutate(m.id);
                    }}
                    disabled={removeMut.isPending}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Same budget as the invoice pay form's PAYMENT_INTENT_DEADLINE_MS: several
 *  Stripe round trips on the connected account, but finite. */
const SETUP_INTENT_DEADLINE_MS = 25_000;

// Inline card save via the Stripe Payment Element on the connected account —
// replaces the old hosted-Checkout redirect (mirrors the portal save-card flow).
function StaffCardSetup({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const createFn = useServerFn(createSetupIntentForClient);
  const q = useQuery({
    queryKey: ["staff-setup-intent", clientId],
    // Bounded for the same reason the invoice pay form is (see
    // StaffInvoicePayForm): `isLoading` drives the only thing on screen, so a
    // call that never settles leaves "Loading secure card form…" up for ever
    // with no error and nothing to press. Minting a SetupIntent moves no money
    // and the handler reuses the client's Stripe customer, so a retry is safe.
    queryFn: async () => {
      // NATIVE ONLY — the web build keeps the plain await it has always had.
      if (!IS_NATIVE_BUNDLE) return createFn({ data: { clientId } });
      try {
        return await withDeadline(
          createFn({ data: { clientId } }),
          SETUP_INTENT_DEADLINE_MS,
          "card form",
        );
      } catch (e) {
        if (e instanceof ActionTimeout) {
          throw new Error(
            "The secure card form is taking longer than expected to load. Check your connection and try again.",
          );
        }
        throw e;
      }
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const stripePromise = useMemo(
    () => (q.data ? getStripe(q.data.publishableKey, q.data.stripeAccount) : null),
    [q.data?.publishableKey, q.data?.stripeAccount],
  );

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading secure card form…</p>;
  if (q.error) return <p className="text-sm text-destructive">{(q.error as Error).message}</p>;
  if (!q.data || !stripePromise) return null;

  return (
    <div className="rounded-md border bg-background p-4">
      <Elements
        stripe={stripePromise}
        options={{ clientSecret: q.data.clientSecret, appearance: stripeAppearance() }}
      >
        <StaffCardSetupInner clientId={clientId} onDone={onDone} />
      </Elements>
    </div>
  );
}

function StaffCardSetupInner({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const finalizeFn = useServerFn(finalizeCardSetupForClient);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    try {
      const { error, setupIntent } = await stripe.confirmSetup({
        elements,
        confirmParams: { return_url: window.location.href },
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
      const r: any = await finalizeFn({ data: { clientId, setupIntentId: setupIntent.id } });
      toast.success(`Added ${r.brand ?? "card"} ····${r.last4 ?? ""}`);
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
