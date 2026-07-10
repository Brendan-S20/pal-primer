import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getStripeConnectStatus,
  startStripeConnect,
  refreshStripeConnect,
  disconnectStripeConnect,
} from "@/lib/stripe-connect.functions";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/payments")({
  component: PaymentsSettings,
});

function PaymentsSettings() {
  const qc = useQueryClient();
  const statusFn = useServerFn(getStripeConnectStatus);
  const startFn = useServerFn(startStripeConnect);
  const refreshFn = useServerFn(refreshStripeConnect);
  const disconnectFn = useServerFn(disconnectStripeConnect);

  const q = useQuery({ queryKey: ["stripe-connect"], queryFn: () => statusFn() });
  const cfg = q.data as any;

  const start = useMutation({
    mutationFn: () => startFn({ data: { origin: window.location.origin } }),
    onSuccess: (r: any) => { if (r?.url) window.location.href = r.url; },
    onError: (e: Error) => toast.error(e.message),
  });
  const refresh = useMutation({
    mutationFn: () => refreshFn(),
    onSuccess: () => { toast.success("Status refreshed"); qc.invalidateQueries({ queryKey: ["stripe-connect"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const disconnect = useMutation({
    mutationFn: () => disconnectFn(),
    onSuccess: () => { toast.success("Stripe disconnected"); qc.invalidateQueries({ queryKey: ["stripe-connect"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Payments</h1>
        <p className="text-sm text-muted-foreground">
          Connect your own Stripe account to charge your clients — invoice payments, saved cards,
          autopay, and the client portal all run on your account, and funds settle directly to you.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : cfg?.connected ? (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <span className="font-medium">Connected</span>
              <span className="text-muted-foreground"> · <span className="font-mono text-xs">{cfg.accountId}</span></span>
              <div className="mt-1">
                {cfg.chargesEnabled ? (
                  <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">Charges enabled</span>
                ) : (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                    Onboarding not finished — {cfg.status ?? "pending"}
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
                Refresh status
              </Button>
              <Button variant="outline" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
                Disconnect
              </Button>
            </div>
          </div>
          {!cfg.chargesEnabled && (
            <p className="text-xs text-muted-foreground">
              Finish onboarding in your Stripe dashboard, then click <em>Refresh status</em>. Charges
              won't succeed until Stripe enables them.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            No Stripe account connected yet. Until you connect one, client-payment features are unavailable.
          </p>
          <Button onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? "Redirecting…" : "Connect with Stripe"}
          </Button>
        </div>
      )}

      <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
        <strong>Switching accounts?</strong> Saved client cards and autopay are tied to the Stripe
        account that stored them. If you connect a different Stripe account, clients will need to
        re-enter their card the next time they pay.
      </p>
    </div>
  );
}
