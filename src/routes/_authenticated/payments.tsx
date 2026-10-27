import { useLaunchCopy } from "@/lib/launch-copy";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
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
  getStripeBalanceSummary,
  ensureStripeConnectAccount,
  createStripeAccountSession,
  startStripeConnect,
  refreshStripeConnect,
  disconnectStripeConnect,
  auditClientCardRefs,
} from "@/lib/stripe-connect.functions";
import {
  getProcessingFeeSettings,
  setProcessingFeePassThrough,
  attestCardSurcharge,
} from "@/lib/processing-fee.functions";
import { describeStripeRates } from "@/lib/processing-fee";
import { getTipSettings, setTipsEnabled } from "@/lib/tips.functions";
import { Switch } from "@/components/ui/switch";
import { getPlatformFeeSentence } from "@/lib/platform-fee.functions";
import { sendEmailVerification } from "@/lib/auth-entry.functions";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { toast } from "sonner";
import { formatDay } from "@/lib/format";
import { titleHead } from "@/lib/page-title";
import { connectAppearanceFor } from "@/lib/connect-appearance";
import { isDarkApplied, watchDarkTheme } from "@/lib/theme";
import { ConnectCard } from "@/components/payments/ConnectCard";
import {
  PAYMENTS_FETCH_TIMEOUT_MS,
  STRIPE_DID_NOT_ANSWER,
  balanceSummaryState,
  withTimeout,
  type BalanceSummaryData,
} from "@/lib/payments-load";

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
  head: () => titleHead("Payments"),
  component: PaymentsSettings,
});

function PaymentsSettings() {
  const copy = useLaunchCopy();
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
    onSuccess: () => {
      toast.success("Status refreshed");
      qc.invalidateQueries({ queryKey: ["stripe-connect"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const { confirm, dialog } = useConfirmDialog();
  const disconnect = useMutation({
    mutationFn: () => disconnectFn(),
    onSuccess: () => {
      toast.success("Stripe disconnected");
      qc.invalidateQueries({ queryKey: ["stripe-connect"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const hostedFallback = useMutation({
    mutationFn: () => startFn({ data: { origin: window.location.origin } }),
    onSuccess: (r: any) => {
      if (r?.url) window.location.href = r.url;
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const auditFn = useServerFn(auditClientCardRefs);
  const auditCards = useMutation({
    mutationFn: () => auditFn(),
    onSuccess: (r: any) => {
      if (!r.cleared.length) {
        toast.success(
          `Checked ${r.checked} saved card${r.checked === 1 ? "" : "s"}: all valid on this Stripe account.`,
        );
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

  // FETCHED, NOT IMPORTED, and that is the whole point of the round trip.
  //
  // This used to call describePlatformFee() directly. That import pulled
  // PLATFORM_FEE_BPS into the client bundle, and a JS chunk is a static asset
  // served to anyone who asks. With the rate at 0 nothing shipped -- the
  // function returns null on its first line and the bundler folded it away --
  // so the exposure was invisible right up until the day somebody set the rate,
  // which would have published it with nothing in the diff to say so. See
  // platform-fee.functions.ts.
  //
  // Still null while the rate is 0, which is why the sentence below is built
  // with a conditional rather than a ternary picking between two wordings.
  const platformFeeFn = useServerFn(getPlatformFeeSentence);
  const { data: platformFeeData } = useQuery({
    queryKey: ["platform-fee-sentence"],
    queryFn: () => platformFeeFn(),
    // A published pricing term, identical for every tenant and changed by a
    // deploy rather than by anything on this screen.
    staleTime: Infinity,
  });
  const platformFee = platformFeeData?.sentence ?? null;

  return (
    // Wider than the old max-w-3xl: the Payments tab is a transaction table
    // inside an iframe, and 768px forced it to scroll horizontally at every
    // window size.
    <>
      {dialog}
      {/* The three-sentence explanation that used to live here is onboarding
          copy: true, and re-read by a returning owner on every single visit.
          It now shows only before an account is connected, which is the one
          moment it answers a question somebody has. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Payments</h1>
          <p className="text-sm text-muted-foreground">
            {cfg?.connected
              ? "Your Stripe account. Money in, money out, and the settings behind both."
              : copy("Get paid by card, straight to your own bank account.")}
          </p>
        </div>
        {cfg?.connected && (
          <div className="flex items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-xs ${
                cfg.chargesEnabled
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-amber-100 text-amber-800"
              }`}
            >
              {cfg.chargesEnabled ? "Charges enabled" : "Setup unfinished"}
            </span>
            <span className="text-xs text-muted-foreground" title={cfg.accountId}>
              {maskAccountId(cfg.accountId)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
            >
              {refresh.isPending ? "…" : "Refresh"}
            </Button>
          </div>
        )}
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : q.isError ? (
        // Its own branch, ahead of `!cfg?.connected` (#436). A failed status
        // read used to fall through to the not-connected branch and its setup
        // button, telling an owner whose account is live that they had none.
        <div role="alert" className="rounded-lg border bg-card p-4">
          <p className="text-sm text-destructive">
            Couldn't check your Stripe account: {(q.error as Error)?.message || "unknown error"}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            {q.isFetching ? "Retrying…" : "Try again"}
          </Button>
        </div>
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
          {/* WHAT IT COSTS, ON THE SCREEN WHERE THE DECISION IS MADE.
              The rate used to appear only inside the processing-fee card, which
              renders under `cfg.chargesEnabled` -- so a tenant could read the
              price only AFTER onboarding, having already decided. The site
              quotes this number to get them here; the app owed it to them at
              the same moment.

              Both sentences are derived, not written: describeStripeRates()
              from the rate constants, describePlatformFee() from
              PLATFORM_FEE_BPS, which is 0 today and renders nothing at all. If
              the platform fee comes back, this line grows a clause on its own
              rather than waiting for somebody to remember this screen. */}
          <p className="text-sm text-muted-foreground">
            Stripe charges {describeStripeRates()}, billed to your own account.
            {platformFee ? ` HoundStack adds ${platformFee}.` : ""} Payouts settle to you directly.
          </p>
          <Button onClick={() => ensure.mutate()} disabled={ensure.isPending}>
            {ensure.isPending ? "Setting up…" : "Set up payments"}
          </Button>
        </div>
      ) : (
        <>
          {/* The status bar that sat here duplicated the header's chip and
              account id. Disconnect also used to live in it, beside Refresh at
              identical weight (outline/sm), firing on one click with no
              confirmation — a misclick took payment collection down for the
              whole organization. It is in the Account tab now, destructive and
              behind a confirm that names what breaks. */}
          <ConnectDashboard
            chargesEnabled={!!cfg.chargesEnabled}
            onOnboardingExit={() => refresh.mutate()}
            settings={
              cfg.chargesEnabled ? (
                <div className="space-y-4">
                  <ProcessingFeeCard />
                  <TipsCard />
                </div>
              ) : null
            }
            accountExtras={
              <>
                {/* Was a permanently-visible amber box at the foot of the page,
                    warning about a hypothetical ("if you connect a different
                    account") whether or not anybody was switching. A warning
                    that is always on screen is one nobody reads. It lives next
                    to Disconnect now, where switching accounts is the thing you
                    are actually contemplating. */}
                <div className="rounded-lg border p-4">
                  <div className="text-sm font-medium">Saved client cards</div>
                  <p className="mt-1 text-2xs text-muted-foreground">
                    Saved cards and autopay belong to the Stripe account that stored them. Connect a
                    different account and clients will have to re-enter their card. This check finds
                    cards that no longer resolve on the current account.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => auditCards.mutate()}
                    disabled={auditCards.isPending}
                  >
                    {auditCards.isPending ? "Checking…" : "Check saved client cards"}
                  </Button>
                </div>

                <div className="rounded-lg border border-destructive/40 p-4">
                  <div className="text-sm font-medium">Disconnect this Stripe account</div>
                  <p className="mt-1 text-2xs text-muted-foreground">
                    Stops all card payments immediately: invoices, autopay, and the client portal.
                    Saved client cards belong to this Stripe account and will not work on a
                    different one.
                  </p>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="mt-3"
                    disabled={disconnect.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Disconnect Stripe?",
                        description: (
                          <>
                            Clients will not be able to pay you through HoundStack until another
                            account is connected. Autopay stops. Saved cards are tied to this
                            account and will need re-entering if you connect a different one.
                          </>
                        ),
                        confirmLabel: "Disconnect",
                        destructive: true,
                      });
                      if (ok) disconnect.mutate();
                    }}
                  >
                    {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
                  </Button>
                </div>
              </>
            }
          />

          {/* Only while setup is unfinished. "Trouble with the embedded steps?"
              under a completed onboarding is an offer to fix a problem that
              cannot exist, and it invited people back into a flow they had
              already finished. */}
          {!cfg.chargesEnabled && (
            <p className="text-xs text-muted-foreground">
              Trouble with the embedded steps?{" "}
              <button
                className="underline"
                onClick={() => hostedFallback.mutate()}
                disabled={hostedFallback.isPending}
              >
                Open Stripe-hosted onboarding
              </button>
              .
            </p>
          )}
        </>
      )}
    </>
  );
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Whether customers are offered a tip when they pay.
 *
 * Says where the choices appear and what they are, because the owner is
 * deciding what their customers will be asked, and says where the money goes
 * in the books, because "is this income" is the first question after "can I".
 */
function TipsCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getTipSettings);
  const setFn = useServerFn(setTipsEnabled);
  const q = useQuery({ queryKey: ["tip-settings"], queryFn: () => getFn() });
  const set = useMutation({
    mutationFn: (enabled: boolean) => setFn({ data: { enabled } }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["tip-settings"] });
      toast.success(r.tipsEnabled ? "Clients can now add a tip" : "Tips turned off");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading tip settings…</p>;
  if (!q.data) return null;

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <label htmlFor="tips-enabled" className="min-w-0 text-sm">
          <span className="block font-medium">Let clients add a tip</span>
          <span className="block text-muted-foreground">
            On the payment link and the client portal, clients can choose No tip, 10%, 15%, 20% or
            their own amount. No tip is selected until they pick one.
          </span>
        </label>
        <Switch
          id="tips-enabled"
          className="mt-1"
          checked={q.data.tipsEnabled}
          disabled={set.isPending}
          onCheckedChange={(v) => set.mutate(v)}
        />
      </div>
      <p className="border-t pt-2 text-xs text-muted-foreground">
        A tip is paid to you with the invoice but kept apart from it: it never counts toward
        revenue, royalties or the platform fee, and no card fee is added to it. It is credited to
        the technician on the most recent completed visit on that invoice and shows on Timesheets
        and in the Tips received report.
      </p>
    </div>
  );
}

/**
 * Who pays Stripe's cost of acceptance.
 *
 * The screen leads with the number the tenant will actually keep absorbing,
 * because the honest version of this feature is "you recover most of it", not
 * "you recover it". Visa caps a surcharge at 3%, Stripe charges 2.9% + 30¢, and
 * the fee lands on the surcharged total — so on a $60 job the tenant is still
 * out ~29¢ however this is configured. Stating that here is cheaper than a
 * support ticket after the first statement.
 */
function ProcessingFeeCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getProcessingFeeSettings);
  const setFn = useServerFn(setProcessingFeePassThrough);
  const attestFn = useServerFn(attestCardSurcharge);

  const q = useQuery({ queryKey: ["processing-fee"], queryFn: () => getFn() });
  const s = q.data as any;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["processing-fee"] });
  const setPassThrough = useMutation({
    mutationFn: (enabled: boolean) => setFn({ data: { enabled } }),
    onSuccess: () => {
      invalidate();
      toast.success("Saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const attest = useMutation({
    mutationFn: (attested: boolean) => attestFn({ data: { attested } }),
    onSuccess: (_r, attested) => {
      invalidate();
      toast.success(attested ? "Card surcharging enabled" : "Card surcharging turned off");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading fee settings…</p>;
  if (!s) return null;

  const ex = s.example;
  const bannedHere = s.regionAllowsCardSurcharge === false;

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div>
        <div className="text-sm font-medium">Processing fees</div>
        <p className="mt-1 text-sm text-muted-foreground">
          Stripe charges you {describeStripeRates()}. You can absorb that or pass it to the client
          as a separate line at checkout.
        </p>
      </div>

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={!!s.passThroughEnabled}
          disabled={setPassThrough.isPending}
          onChange={(e) => setPassThrough.mutate(e.target.checked)}
        />
        <span className="text-sm">
          <span className="font-medium">Pass processing fees to the client</span>
          <span className="block text-muted-foreground">
            Applies to automatic payments and saved cards. Cards also need the confirmation below.
          </span>
        </span>
      </label>

      {s.passThroughEnabled && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          {/* Which payments this actually reaches. The three paths that quote a
              fee all charge a SAVED payment method — autopay, staff "charge
              saved card", and the portal's saved card — and the rail is known
              before the charge is built. On the four customer-present paths the
              payer chooses card or bank inside Stripe's Payment Element AFTER
              the intent exists, so its amount is already fixed and no fee can
              be added. Saying "applies to ACH straight away" while every ACH-
              capable path absorbed the fee was the wrong half of that. */}
          <div className="font-medium">On a {money(ex.baseCents)} invoice</div>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li>
              Card:{" "}
              {ex.card.suppressed
                ? "no fee added"
                : `client pays ${money(ex.card.totalCents)}, you recover ${money(ex.card.surchargeCents)}`}
              {ex.card.shortfallCents > 0 && (
                <span> and still absorb {money(ex.card.shortfallCents)}</span>
              )}
            </li>
          </ul>
          <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">
            These apply to automatic payments and saved cards. When a client pays from a link or the
            portal and picks their own method at checkout, you absorb the fee, because the amount is
            fixed before they choose.
          </p>
          {ex.card.shortfallCents > 0 && !ex.card.suppressed && (
            <p className="mt-2 text-xs text-muted-foreground">
              Card networks cap a surcharge at 3% and at your actual cost, so a card fee never
              recovers the full amount on smaller charges.
            </p>
          )}
        </div>
      )}

      <div className="space-y-2 border-t pt-3">
        <div className="text-sm font-medium">Card surcharging</div>
        {bannedHere ? (
          <p className="text-sm text-muted-foreground">
            Surcharging a card is prohibited in {s.merchantRegion}, so card fees stay with your
            business.
          </p>
        ) : !s.merchantRegion ? (
          <p className="text-sm text-muted-foreground">
            We don't have your business's state from Stripe yet, so card surcharging stays off.
            Finish Stripe onboarding and it will appear here.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Visa and Mastercard require <strong>you</strong> (not HoundStack) to notify the card
              networks and your payment processor at least 30 days before you start surcharging. We
              can't file that for you, because your business is the merchant of record on every
              client payment. Debit and prepaid cards are never surcharged.
            </p>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={!!s.attestedAt}
                disabled={attest.isPending}
                onChange={(e) => attest.mutate(e.target.checked)}
              />
              <span className="text-sm">
                I've given the card networks and my processor the required notice.
                {s.attestedAt && (
                  <span className="block text-xs text-muted-foreground">
                    Confirmed {formatDay(s.attestedAt)}.
                  </span>
                )}
              </span>
            </label>
          </>
        )}
      </div>
    </div>
  );
}

// Embedded Stripe Connect dashboard (in-app Express experience). Loads
// @stripe/connect-js on the client only; the Account Session is minted
// server-side via createStripeAccountSession.
/**
 * Stripe's Connect dashboards, or what a narrow screen gets instead of them.
 *
 * ── THE RULE: A WIDTH, NOT A FINGER ──────────────────────────────────────
 *
 * Below 1024px the Balance, Payouts, Payments and Business details panels are
 * replaced by NeedsAWiderScreen. At 1024px and wider they render, touch or
 * mouse, and so does Stripe's notification banner.
 *
 * Until 2026-10-18 the gate was `(pointer: coarse)`, which took the dashboards
 * away from every iPad, including a 1032px landscape iPad with plenty of room
 * for them, and told its owner to "open this page on a computer" (#494). A
 * tablet turned sideways is the computer for a lot of the people using this.
 *
 * ── WHY ANYTHING IS GATED AT ALL ─────────────────────────────────────────
 *
 * Stripe's embedded components are iframes on Stripe's own origin. Their
 * internals cannot be restyled from here: no class, no CSS variable and no
 * amount of care on our side changes a control inside them. The appearance
 * variables in connectAppearance() are the only lever, and they set fonts and
 * padding, not heights.
 *
 * Measured on an iPad, 2026-08-23: "Edit Amount" 60x10pt (eight of them),
 * "Add Status" 66x10pt, "Update" 56x24pt, "Send email" and "See details"
 * 93x30pt, "Export" 63x30pt. Against a 44pt floor, on the page where the
 * organization's money lives. That is still true inside the iframe at any
 * width. What changed is the judgment: on a wide screen Stripe lays those
 * panels out as the dashboard it designed, and the touch appearance makes
 * the controls bigger where it can. On a phone the same panels are cramped
 * tables of ten point links, and mis-tapping "Edit Amount" there is a worse
 * outcome than not having the control at all.
 *
 * So below the width they are replaced rather than shrunk. What stays is what
 * we render ourselves and can size properly: the balance summary above, and a
 * route to the day-to-day view people actually want, which is our own invoice
 * list (where refunds now live too).
 *
 * ── WHAT IS DELIBERATELY *NOT* GATED ──────────────────────────────────────
 *
 * Onboarding. Connecting Stripe at all goes through
 * `ConnectAccountOnboarding`, and hiding it would strand a tenant who only has
 * a phone, unable to start taking money with no alternative inside the app.
 * Stripe designs that flow for mobile; the dashboards are the part that is not.
 * It renders at every width.
 *
 * This is a usability decision, not an App Review one. This is the tenant's own
 * money, which src/lib/app-store-billing.ts is explicit about never gating.
 */
function MaybeConnectProvider({
  instance,
  skip,
  children,
}: {
  instance: any;
  skip: boolean;
  children: ReactNode;
}) {
  if (skip) return <>{children}</>;
  return (
    <ConnectComponentsProvider connectInstance={instance}>{children}</ConnectComponentsProvider>
  );
}

function NeedsAWiderScreen({ what, refunds }: { what: string; refunds?: boolean }) {
  return (
    <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
      <p className="font-medium text-foreground">{what} needs a wider screen</p>
      <p className="mt-1">
        Stripe&rsquo;s {what.toLowerCase()} view needs a wider screen than this one, and we cannot
        resize its controls. Open this page on a larger screen, or turn a tablet sideways, for the
        full view.
      </p>
      <p className="mt-2">
        For day-to-day work,{" "}
        <Link
          to="/invoices"
          className="inline-flex items-center font-medium text-primary hover:underline touch:min-h-11"
        >
          Invoices
        </Link>{" "}
        shows every charge with controls built for touch.
      </p>
      {/* Said outright on the Activity tab, because Stripe's panel used to be
          the ONLY place a refund could be made, and "open this on a larger
          screen" read as "you cannot refund anyone from here". You can: from
          the invoice (refundInvoicePayment). */}
      {refunds && (
        <p className="mt-2">
          To refund a client, open their invoice and press{" "}
          <span className="font-medium text-foreground">Refund</span> on the payment.
        </p>
      )}
    </div>
  );
}

/**
 * Stripe appearance for this device, from two facts that combine:
 *
 *   A finger (coarse pointer): bigger type and more padding inside the
 *   iframes. A mouse keeps Stripe's sizes.
 *   Dark mode (the "dark" class theme.ts puts on <html>): the app's dark
 *   palette, so the panels are not white boxes on a dark page. Light mode
 *   keeps Stripe's colours, which is the look the light page was reviewed in.
 *
 * The values, and their source in styles.css, are in src/lib/connect-appearance.ts.
 *
 * What Stripe lets us change (AppearanceVariables in @stripe/connect-js):
 * fontSizeBase, spacingUnit, button and input padding, button label size,
 * table row padding, colours, radii and the overlay type. What it does not:
 * anything else inside the iframe. There is no height, min-height or hit-area
 * variable, links styled as actions ("Edit Amount") take no padding variable
 * at all, and no CSS of ours reaches across the origin. So this makes the
 * controls larger, not 44pt; the width gate is what keeps them off a phone.
 *
 * Read when the instance is created, and again whenever the theme changes
 * while the page is open (ConnectDashboard watches the class and calls
 * instance.update()), so switching to dark in Preferences or a phone going
 * dark at sunset repaints the panels without a reload. The pointer a device
 * has does not change while the page is open, so nothing watches that.
 */
function connectAppearance() {
  if (typeof window === "undefined") return undefined;
  return connectAppearanceFor({
    dark: isDarkApplied(),
    coarse: window.matchMedia("(pointer: coarse)").matches,
  });
}

function ConnectDashboard({
  settings,
  accountExtras,
  chargesEnabled,
  onOnboardingExit,
}: {
  /** Rendered at the foot of the Account tab. Passed in rather than built here
   *  so the disconnect mutation stays with the other account mutations. */
  /** Who pays the card fee. A setting, not a dashboard — it belongs behind its
   *  own tab rather than stacked under three iframes where it was the last
   *  thing on a long page. */
  settings?: ReactNode;
  /** Account-tab content between the Stripe panel and the danger zone. */
  accountExtras?: ReactNode;
  chargesEnabled: boolean;
  onOnboardingExit: () => void;
}) {
  // A width, not a pointer. 1024px is a landscape iPad (1024 to 1366) and every
  // laptop; below it is a phone or a portrait tablet, where Stripe's panels
  // are cramped tables of controls we cannot resize. The reasoning, and why it
  // used to be `(pointer: coarse)`, is in the comment above MaybeConnectProvider.
  const isWide = useMediaQuery("(min-width: 1024px)");
  const narrow = !isWide;
  // useMediaQuery answers false on the server and on the first client render,
  // and only learns the real width in an effect. Deciding before then would
  // draw NeedsAWiderScreen for a frame on every wide screen, and skip the
  // session it then has to start a render later. So nothing is decided until
  // `measured`: its effect runs right after useMediaQuery's, in the same
  // flush, so both updates land in the same re-render.
  const [measured, setMeasured] = useState(false);
  useEffect(() => setMeasured(true), []);
  // The dashboards are replaced, and the instance is not needed, only once the
  // account is live. Before that the one Connect surface is onboarding, which
  // renders at every width.
  const replaced = narrow && chargesEnabled;
  const sessionFn = useServerFn(createStripeAccountSession);
  const [instance, setInstance] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!measured) return;
    // NOTHING TO LOAD ON A NARROW SCREEN. The panels this instance exists to
    // render are replaced by NeedsAWiderScreen there, so creating an account
    // session and pulling in @stripe/connect-js would be work done for iframes
    // that never appear, and a failure in it would blank a page whose narrow
    // content does not depend on Stripe at all. That is not theoretical: it is
    // exactly what happened while testing the first version of this, and the
    // dashboard showed "Couldn't load the payment dashboard" over content that
    // needed no Stripe.
    // Only when there is a dashboard to skip. Onboarding is the one Connect
    // surface a phone must keep: it is how an account gets connected at all,
    // and Stripe designs that flow for mobile. Gating it would strand a tenant
    // who only has a phone, unable to start taking money with no alternative
    // in the app. So the instance is still created while `chargesEnabled` is
    // false, and only skipped once the account is live and the dashboards are
    // what would have rendered.
    if (replaced) return;
    let cancelled = false;
    setErr(null);
    setInstance(null);
    (async () => {
      try {
        // Deadlines on both waits (#436): an Account Session that never comes
        // back held "Loading payment dashboard…" for as long as the tab was
        // open, and Stripe's own refetch of it is the same call.
        const first = await withTimeout(
          sessionFn(),
          PAYMENTS_FETCH_TIMEOUT_MS,
          STRIPE_DID_NOT_ANSWER,
        );
        if (cancelled) return;
        const { loadConnectAndInitialize } = await import("@stripe/connect-js");
        const inst = loadConnectAndInitialize({
          publishableKey: (first as any).publishableKey,
          fetchClientSecret: async () => {
            const r = await withTimeout(
              sessionFn(),
              PAYMENTS_FETCH_TIMEOUT_MS,
              STRIPE_DID_NOT_ANSWER,
            );
            return (r as any).clientSecret as string;
          },
          appearance: connectAppearance(),
        });
        if (!cancelled) setInstance(inst);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, measured, replaced]);

  // The theme can change under an open page (Preferences, or a phone on
  // "System" going dark). The iframes cannot see our CSS, so tell Stripe.
  useEffect(() => {
    if (!instance) return;
    return watchDarkTheme(() => {
      instance.update({ appearance: connectAppearance() });
    });
  }, [instance]);

  if (!measured) return <p className="text-sm text-muted-foreground">Loading payment dashboard…</p>;

  // Both guards below are about the Stripe instance, which a narrow screen
  // with a live account does not have and does not need.
  if (err && !replaced)
    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm text-destructive">Couldn't load the payment dashboard: {err}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => setReloadKey((k) => k + 1)}
        >
          Try again
        </Button>
      </div>
    );
  if (!instance && !replaced)
    return <p className="text-sm text-muted-foreground">Loading payment dashboard…</p>;

  return (
    <div className="min-w-0 space-y-5">
      {/* No provider below 1024px once the account is live: every Connect
          component beneath is replaced by NeedsAWiderScreen there, and the
          provider requires an instance this branch deliberately never
          creates. */}
      <MaybeConnectProvider instance={instance} skip={replaced}>
        {/* Stripe's own alerting. Above the tabs, because "your account is
            restricted" is true on whichever tab you are looking at, and
            hiding it inside one of them means the tab you are NOT on is where
            the warning lives. */}
        {!replaced && <ConnectNotificationBanner />}
        {!chargesEnabled ? (
          <ConnectCard title="Account setup">
            {(h) => <ConnectAccountOnboarding onExit={onOnboardingExit} {...h} />}
          </ConnectCard>
        ) : (
          /* Three jobs, not four boxes.
           *
           * The four components were stacked and all mounted at once. Each is
           * an iframe that fetches independently, so opening this page paid
           * for four of them whatever you came to do, and the page was a long
           * scroll in which the thing you wanted was rarely on screen.
           *
           * Grouped by the question being asked:
           *   Money:    "how much do I have, and when does it reach my bank"
           *              (balances and payouts answer that together; splitting
           *              them made you scroll between two halves of one answer)
           *   Activity: "what did clients actually pay"
           *   Account:  "my business details, and disconnecting"
           *
           * Tabs unmount their content, so exactly one iframe is live.
           *
           * The tab row is one line at every width. Four short labels fit
           * with room to spare at 1024px, but the primitive only scrolls
           * below `md`, so from `md` up it is told to start at the left and
           * scroll sideways rather than push the page wider if it ever
           * cannot fit. `h-auto` because a scroller clips vertically too, and
           * on a touch iPad the 44px triggers are taller than the fixed `h-9`
           * the primitive gives a desktop row. */
          <Tabs defaultValue="money">
            <TabsList className="h-auto max-w-full justify-start overflow-x-auto">
              <TabsTrigger value="money">Money</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              {settings && <TabsTrigger value="fees">Fees &amp; tips</TabsTrigger>}
              <TabsTrigger value="account">Account</TabsTrigger>
            </TabsList>

            <TabsContent value="money" className="mt-4 space-y-4">
              <BalanceSummary />
              {narrow ? (
                <NeedsAWiderScreen what="Balance" />
              ) : (
                <ConnectCard title="Balance">{(h) => <ConnectBalances {...h} />}</ConnectCard>
              )}
              {narrow ? (
                <NeedsAWiderScreen what="Payouts" />
              ) : (
                <ConnectCard
                  title="Payouts"
                  hint="When money leaves Stripe for your bank. Change the schedule or send one now."
                >
                  {(h) => <ConnectPayouts {...h} />}
                </ConnectCard>
              )}
            </TabsContent>

            <TabsContent value="activity" className="mt-4">
              {narrow ? (
                <NeedsAWiderScreen what="Payments" refunds />
              ) : (
                <ConnectCard
                  title="Payments"
                  hint="Every charge, refund and dispute on your account."
                >
                  {(h) => <ConnectPayments {...h} />}
                </ConnectCard>
              )}
            </TabsContent>

            {settings && (
              <TabsContent value="fees" className="mt-4">
                {settings}
              </TabsContent>
            )}

            <TabsContent value="account" className="mt-4 space-y-4">
              {narrow ? (
                <NeedsAWiderScreen what="Business details" />
              ) : (
                <ConnectCard
                  title="Business details"
                  hint="Legal entity, bank account, and the information Stripe needs to keep you paid out."
                >
                  {(h) => <ConnectAccountManagement {...h} />}
                </ConnectCard>
              )}
              {accountExtras}
            </TabsContent>
          </Tabs>
        )}
      </MaybeConnectProvider>
    </div>
  );
}

// Show only a friendly, masked form of the Stripe account id (acct_…1234) so
// the raw connected-account id never sits bare in the UI (B5). Full id is kept
// in the title attribute for support.
function maskAccountId(id: string | null | undefined): string {
  if (!id) return "connected";
  const tail = id.slice(-4);
  return `acct_…${tail}`;
}

/**
 * The headline the Money tab exists to give: how much is available now, how
 * much is still clearing, and when the last payout lands.
 *
 * Rendered above the embedded components rather than instead of them. They own
 * the detail — per-currency breakdown, the payout history, changing the
 * schedule — but each is an iframe that fetches on its own, so the one number
 * an owner opens this page for arrived last and moved the layout when it did.
 */
function BalanceSummary() {
  const fn = useServerFn(getStripeBalanceSummary);
  const q = useQuery({
    queryKey: ["stripe-balance"],
    // A deadline, and one retry rather than React Query's three with backoff:
    // "Loading balance…" is never the last thing this card says (#436).
    queryFn: () =>
      withTimeout(
        fn() as Promise<BalanceSummaryData>,
        PAYMENTS_FETCH_TIMEOUT_MS,
        STRIPE_DID_NOT_ANSWER,
      ),
    retry: 1,
  });
  const d = q.data as any;
  const view = balanceSummaryState(q);

  if (view.kind === "loading") {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Loading balance…
      </div>
    );
  }
  // Said, not swallowed. This used to return null on an error, reasoning that
  // the embedded panels below were the real view. Below 1024px there are no
  // panels below, and when connect-js is what failed there are none at any
  // width, so the tab was blank with no reason given (#436). Muted rather
  // than red: it is one figure we could not fetch, not money gone wrong.
  if (view.kind === "error") {
    return (
      <div role="alert" className="rounded-lg border bg-card p-4 text-sm">
        <p className="text-muted-foreground">Couldn't load your balance. {view.message}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
        >
          {q.isFetching ? "Retrying…" : "Try again"}
        </Button>
      </div>
    );
  }
  if (view.kind === "not-connected") return null;

  const fmt = (amount: number, currency: string) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);

  const avail: Array<{ amount: number; currency: string }> = d.available ?? [];
  const pending: Array<{ amount: number; currency: string }> = d.pending ?? [];

  return (
    <div className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3">
      <div>
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">Available now</div>
        <div className="text-xl font-semibold">
          {avail.length ? avail.map((b) => fmt(b.amount, b.currency)).join(" · ") : "—"}
        </div>
      </div>
      <div>
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">Still clearing</div>
        {/* Kept separate from "available" rather than summed. A single total
            overstates what can actually be drawn today, which is the number
            somebody opens this page to find. */}
        <div className="text-xl font-semibold text-muted-foreground">
          {pending.length ? pending.map((b) => fmt(b.amount, b.currency)).join(" · ") : "—"}
        </div>
      </div>
      <div>
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">Latest payout</div>
        {d.lastPayout ? (
          <div className="text-sm">
            <span className="font-semibold">{fmt(d.lastPayout.amount, d.lastPayout.currency)}</span>
            <span className="ml-1.5 text-muted-foreground">{d.lastPayout.status}</span>
            {d.lastPayout.arrivalDate && (
              // "Expected" because arrival_date is Stripe's estimate, not a
              // commitment from the bank. Presenting it flat would make us
              // answerable for a date we do not control.
              <div className="text-2xs text-muted-foreground">
                Expected {formatDay(new Date(d.lastPayout.arrivalDate).toISOString())}
              </div>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">None yet</div>
        )}
      </div>
    </div>
  );
}
