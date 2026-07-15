// Billing tab redesign (spec): Summary, Payment Methods, Invoices, Credits,
// Payments, Billing Settings. Add-ons intentionally live in Services now.
// Cards stay in Stripe; HoundStack never stores card numbers.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CreditCard, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getClientCredit, getClientBillingSummary } from "@/lib/invoices.functions";
import {
  listClientPaymentMethods,
  setDefaultPaymentMethod,
  removePaymentMethod,
  startCardSetupForClient,
} from "@/lib/payment-methods.functions";
import { BillingPanel, AutopayResume } from "@/components/client-detail/billing-panels";
import { useConfirmDialog } from "@/components/ConfirmDialog";

export function BillingTab({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const getCreditFn = useServerFn(getClientCredit);
  const summaryFn = useServerFn(getClientBillingSummary);

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
      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium">Billing summary</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Outstanding</dt>
            <dd
              className={`text-lg font-semibold ${(summary?.openTotalCents ?? 0) > 0 ? "text-destructive" : ""}`}
            >
              ${((summary?.openTotalCents ?? 0) / 100).toFixed(2)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Open invoices</dt>
            <dd className="text-lg font-semibold">{summary?.openCount ?? 0}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Credit</dt>
            <dd
              className={`text-lg font-semibold ${(credit?.balanceCents ?? 0) < 0 ? "text-destructive" : ""}`}
            >
              ${((credit?.balanceCents ?? 0) / 100).toFixed(2)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Autopay</dt>
            <dd className="text-lg font-semibold">
              {c?.autopay_paused ? "Paused" : c?.autopay_enabled ? "On" : "Off"}
            </dd>
          </div>
        </dl>
      </section>

      <PaymentMethodsPanel clientId={clientId} />

      {/* Invoices + Payments (existing panels) */}
      <BillingPanel clientId={clientId} />

      {/* Credits */}
      <section className="rounded-lg border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Credits</h2>
          <span
            className={`text-lg font-semibold ${(credit?.balanceCents ?? 0) < 0 ? "text-destructive" : ""}`}
          >
            ${((credit?.balanceCents ?? 0) / 100).toFixed(2)}
          </span>
        </div>
        {credit && credit.ledger.length > 0 ? (
          <ul className="mt-3 divide-y text-sm">
            {credit.ledger.map((l: any) => (
              <li key={l.id} className="flex items-center justify-between py-2">
                <span>
                  <span className="text-muted-foreground">
                    {new Date(l.created_at).toLocaleDateString()}
                  </span>
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

      {/* Billing settings */}
      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-medium">Billing settings</h2>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3 text-sm">
          <div>
            <div>
              Autopay:{" "}
              <Badge variant={c?.autopay_enabled ? "default" : "outline"}>
                {c?.autopay_paused ? "Paused" : c?.autopay_enabled ? "On" : "Off"}
              </Badge>
            </div>
            <p className="mt-2 max-w-md text-xs text-muted-foreground">
              Clients turn autopay on or off from their portal. Billing addresses are managed by
              Stripe with the card and are not stored in HoundStack.
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

// ── Payment methods (multiple cards, Stripe-backed) ────────────────────────

function PaymentMethodsPanel({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const listFn = useServerFn(listClientPaymentMethods);
  const setDefaultFn = useServerFn(setDefaultPaymentMethod);
  const removeFn = useServerFn(removePaymentMethod);
  const setupFn = useServerFn(startCardSetupForClient);

  const { data, isLoading, error } = useQuery({
    queryKey: ["payment-methods", clientId],
    queryFn: () => listFn({ data: { clientId } }),
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["payment-methods", clientId] });
    qc.invalidateQueries({ queryKey: ["billing-summary", clientId] });
  };

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
  const setupMut = useMutation({
    mutationFn: () => setupFn({ data: { clientId, returnUrl: window.location.href } }),
    onSuccess: (r: any) => {
      // Same-tab navigation: window.open after an await is popup-blocked in
      // Safari. Stripe's cancel/success URLs bring staff straight back here.
      window.location.assign(r.url);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const methods = data?.methods ?? [];

  return (
    <section className="rounded-lg border bg-card p-5">
      {dialog}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">Payment methods</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Stored securely in Stripe. Autopay charges the default card.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setupMut.mutate()} disabled={setupMut.isPending}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add card
        </Button>
      </div>

      {isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="mt-3 text-sm text-destructive">{(error as Error).message}</p>
      ) : methods.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No cards on file{data?.hasCustomer === false ? " (no Stripe customer yet)" : ""}. Add one
          here or let the client add it from their portal.
        </p>
      ) : (
        <ul className="mt-3 divide-y text-sm">
          {methods.map((m: any) => {
            const expired =
              m.expYear < new Date().getFullYear() ||
              (m.expYear === new Date().getFullYear() && m.expMonth < new Date().getMonth() + 1);
            return (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span className="flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-muted-foreground" />
                  <span className="capitalize">{m.brand}</span>
                  <span className="font-mono">····{m.last4}</span>
                  <span className={`text-xs ${expired ? "font-medium text-destructive" : "text-muted-foreground"}`}>
                    {String(m.expMonth).padStart(2, "0")}/{String(m.expYear).slice(-2)}
                    {expired ? " expired" : ""}
                  </span>
                  {m.isDefault && <Badge variant="default">Default</Badge>}
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
