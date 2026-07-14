import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import {
  ConnectComponentsProvider,
  ConnectAccountOnboarding,
  ConnectAccountManagement,
  ConnectNotificationBanner,
  ConnectPayments,
  ConnectPayouts,
  ConnectBalances,
} from "@stripe/react-connect-js";
import {
  getStripeConnectStatus,
  ensureStripeConnectAccount,
  createStripeAccountSession,
  startStripeConnect,
  refreshStripeConnect,
  disconnectStripeConnect,
  auditClientCardRefs,
} from "@/lib/stripe-connect.functions";
import { sendEmailVerification } from "@/lib/auth-entry.functions";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

function ResendVerification() {
  const sendFn = useServerFn(sendEmailVerification);
  const m = useMutation({
    mutationFn: () => sendFn(),
    onSuccess: () => toast.success("Verification email sent. Check your inbox"),
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Button variant="outline" size="sm" onClick={() => m.mutate()} disabled={m.isPending}>
      {m.isPending ? "Sending…" : "Resend verification email"}
    </Button>
  );
}

// Promoted from Settings -> Payments to the main sidebar (punch list #9): this
// is the tenant-facing money view (balances, payments, payouts), not app
// configuration.
export const Route = createFileRoute("/_authenticated/payments")({
  component: PaymentsSettings,
});

function PaymentsSettings() {
  const qc = useQueryClient();
  const statusFn = useServerFn(getStripeConnectStatus);
  const ensureFn = useServerFn(ensureStripeConnectAccount);
  const startFn = useServerFn(startStripeConnect);
  const refreshFn = useServerFn(refreshStripeConnect);
  const disconnectFn = useServerFn(disconnectStripeConnect);

  const q = useQuery({ queryKey: ["stripe-connect"], queryFn: () => statusFn() });
  const cfg = q.data as any;

  const ensure = useMutation({
    mutationFn: () => ensureFn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stripe-connect"] }),
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
  const hostedFallback = useMutation({
    mutationFn: () => startFn({ data: { origin: window.location.origin } }),
    onSuccess: (r: any) => { if (r?.url) window.location.href = r.url; },
    onError: (e: Error) => toast.error(e.message),
  });
  const auditFn = useServerFn(auditClientCardRefs);
  const auditCards = useMutation({
    mutationFn: () => auditFn(),
    onSuccess: (r: any) => {
      if (!r.cleared.length) {
        toast.success(`Checked ${r.checked} saved card${r.checked === 1 ? "" : "s"}: all valid on this Stripe account.`);
      } else {
        toast.warning(
          `Checked ${r.checked}: cleared ${r.cleared.length} stale saved card${r.cleared.length === 1 ? "" : "s"} ` +
          `(${r.cleared.slice(0, 5).join(", ")}${r.cleared.length > 5 ? "…" : ""}). Those clients will be asked to re-add a card.`,
          { duration: 12000 },
        );
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Payments</h1>
        <p className="text-sm text-muted-foreground">
          Connect your own Stripe account to charge your clients. Invoice payments, saved cards,
          autopay, and the client portal all run on your account, and funds settle directly to you.
          Your payments, payouts, and account settings appear right here.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : cfg && cfg.emailVerified === false ? (
        // Locked until the owner verifies their email (frictionless-signup gate).
        <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-5">
          <h2 className="font-semibold text-amber-900">Verify your email to unlock payments</h2>
          <p className="text-sm text-amber-800">
            You can use everything else right away, but before connecting Stripe and moving money,
            we need to confirm your email address. Check your inbox for the verification link.
          </p>
          <ResendVerification />
        </div>
      ) : !cfg?.connected ? (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            No Stripe account connected yet. Set one up to start collecting payments. You'll finish
            a short Stripe verification right here in the app.
          </p>
          <Button onClick={() => ensure.mutate()} disabled={ensure.isPending}>
            {ensure.isPending ? "Setting up…" : "Set up payments"}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3 text-sm">
            <span>
              {cfg.chargesEnabled ? (
                <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">Charges enabled</span>
              ) : (
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                  Finish the steps below to enable charges
                </span>
              )}
              <span className="ml-2 font-mono text-xs text-muted-foreground">{cfg.accountId}</span>
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>Refresh</Button>
              <Button variant="outline" size="sm" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>Disconnect</Button>
            </div>
          </div>

          <ConnectDashboard chargesEnabled={!!cfg.chargesEnabled} onOnboardingExit={() => refresh.mutate()} />

          <p className="text-xs text-muted-foreground">
            Trouble with the embedded steps?{" "}
            <button className="underline" onClick={() => hostedFallback.mutate()} disabled={hostedFallback.isPending}>
              Open Stripe-hosted onboarding
            </button>
            .
          </p>
        </>
      )}

      <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
        <p>
          <strong>Switching accounts?</strong> Saved client cards and autopay are tied to the Stripe
          account that stored them. If you connect a different Stripe account, clients will need to
          re-enter their card the next time they pay.
        </p>
        {cfg?.connected && cfg?.chargesEnabled && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => auditCards.mutate()}
            disabled={auditCards.isPending}
          >
            {auditCards.isPending ? "Checking saved cards…" : "Check saved client cards"}
          </Button>
        )}
      </div>
    </div>
  );
}

// Embedded Stripe Connect dashboard (in-app Express experience). Loads
// @stripe/connect-js on the client only; the Account Session is minted
// server-side via createStripeAccountSession.
function ConnectDashboard({ chargesEnabled, onOnboardingExit }: { chargesEnabled: boolean; onOnboardingExit: () => void }) {
  const sessionFn = useServerFn(createStripeAccountSession);
  const [instance, setInstance] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const first = await sessionFn();
        if (cancelled) return;
        const { loadConnectAndInitialize } = await import("@stripe/connect-js");
        const inst = loadConnectAndInitialize({
          publishableKey: (first as any).publishableKey,
          fetchClientSecret: async () => {
            const r = await sessionFn();
            return (r as any).clientSecret as string;
          },
        });
        if (!cancelled) setInstance(inst);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (err) return <p className="text-sm text-destructive">Couldn't load the payment dashboard: {err}</p>;
  if (!instance) return <p className="text-sm text-muted-foreground">Loading payment dashboard…</p>;

  return (
    <div className="space-y-5">
      <ConnectComponentsProvider connectInstance={instance}>
        <ConnectNotificationBanner />
        {!chargesEnabled ? (
          <div className="rounded-lg border bg-card p-4">
            <ConnectAccountOnboarding onExit={onOnboardingExit} />
          </div>
        ) : (
          <>
            <div className="rounded-lg border bg-card p-4"><ConnectBalances /></div>
            <div className="rounded-lg border bg-card p-4"><ConnectPayments /></div>
            <div className="rounded-lg border bg-card p-4"><ConnectPayouts /></div>
            <div className="rounded-lg border bg-card p-4"><ConnectAccountManagement /></div>
          </>
        )}
      </ConnectComponentsProvider>
    </div>
  );
}
