import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  usePortalCtx, EmptyBox, InvoiceStatusBadge, PromoRedeemCard, TopupRow,
  fmtDayShort, money,
} from "@/lib/portal-ui";

export const Route = createFileRoute("/portal/$slug/$token/billing")({
  component: PortalBilling,
});

function PortalBilling() {
  const { slug, token } = Route.useParams();
  const {
    clientQ, invoicesQ, subsQ,
    startSetupMut, setAutopayMut, removeCardMut, paySavedMut, topupMut, promoMut,
  } = usePortalCtx();
  const c = clientQ.data as any;

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
                  Autopay {c.autopay_enabled ? "on — open invoices are charged automatically." : "off."}
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
              Save a card or bank account for one-tap payments — or enable autopay.
            </div>
            <Button size="sm" disabled={startSetupMut.isPending}
              onClick={() => startSetupMut.mutate()}>
              Add payment method
            </Button>
          </div>
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
                : i.period_start ? `Service ${fmtDayShort(i.period_start)} – ${fmtDayShort(i.period_end)}`
                : "Service";
              return (
                <li key={i.invoice_id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                  <div>
                    <div className="font-medium">
                      Invoice {invNo}
                      <span className="text-muted-foreground"> — {label}</span>
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
