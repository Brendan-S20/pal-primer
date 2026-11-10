// "Tap to pay" on an open invoice (#579): the phone becomes the card reader.
//
// Native app only. StaffInvoicePayForm renders this behind IS_NATIVE_BUNDLE, a
// build-time constant, so the web build drops the component and never loads
// the Stripe Terminal plugin. Inside the app, `tapToPayGate` (src/lib/tap-to-pay.ts)
// decides whether it is drawn at all: iPhone or Android 13+, a role that can
// already Take payment, card payments ready, an open invoice with money due.
//
// The money path is Take payment's: a direct charge on the business's
// connected account (tap-to-pay.server.ts), credited by the existing
// payment_intent.succeeded webhook. After the SDK confirms, the invoice is
// reconciled against Stripe at once, exactly as the card form does, so the
// screen shows "paid" without waiting for the webhook.
import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";
import { SmartphoneNfc } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/client-detail/primitives";
import { usePermissions } from "@/hooks/useMyRole";
import { IS_NATIVE_BUNDLE } from "@/lib/native-build";
import {
  describeTapToPayError,
  tapToPayFeeLabel,
  tapToPayGate,
  TAP_TO_PAY_MESSAGES,
} from "@/lib/tap-to-pay";
import {
  createTapToPayConnectionToken,
  createTapToPayPaymentIntent,
  prepareTapToPay,
} from "@/lib/tap-to-pay.functions";
import { reconcileInvoiceNow } from "@/lib/invoices.functions";

type Plugin = typeof import("@capacitor-community/stripe-terminal");

// The SDK is initialised once per app launch. Its connection-token listener
// asks the server for a fresh token on the business's connected account each
// time the SDK wants one; a token is single-use, so it is never cached here.
let terminalReady: Promise<Plugin> | null = null;
function ensureTerminal(isTest: boolean): Promise<Plugin> {
  if (!terminalReady) {
    terminalReady = (async () => {
      const mod = await import("@capacitor-community/stripe-terminal");
      await mod.StripeTerminal.addListener(
        mod.TerminalEventsEnum.RequestedConnectionToken,
        async () => {
          try {
            const { secret } = await createTapToPayConnectionToken();
            await mod.StripeTerminal.setConnectionToken({ token: secret });
          } catch (e) {
            // The SDK call that asked for the token fails with its own error,
            // which describeTapToPayError turns into a sentence.
            console.warn("Tap to Pay: connection token failed", e);
          }
        },
      );
      await mod.StripeTerminal.initialize({ isTest });
      return mod;
    })().catch((e) => {
      terminalReady = null;
      throw e;
    });
  }
  return terminalReady;
}

type Phase = "idle" | "connecting" | "collecting" | "finishing";

export function TapToPayButton({
  invoiceId,
  invoiceStatus,
  dueCents,
  currencyLabel,
  cardPaymentsReady,
  onPaid,
}: {
  invoiceId: string;
  invoiceStatus: string | null | undefined;
  dueCents: number;
  /** The amount as the rest of the pay form prints it, e.g. "$45.00". */
  currencyLabel: string;
  cardPaymentsReady: boolean;
  onPaid: () => void;
}) {
  const { role } = usePermissions();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  const gate = tapToPayGate({
    isNativeBundle: IS_NATIVE_BUNDLE,
    platform: Capacitor.getPlatform(),
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    role,
    cardPaymentsReady,
    invoiceStatus,
    dueCents,
  });
  if (!gate.show) return null;

  const run = async () => {
    setError(null);
    const online = () => (typeof navigator === "undefined" ? true : navigator.onLine);
    if (!online()) {
      setError(TAP_TO_PAY_MESSAGES.offline);
      return;
    }
    let termsLinked: boolean | null = null;
    try {
      setPhase("connecting");
      const prep = await prepareTapToPay({ data: { invoiceId } });
      const { StripeTerminal, TerminalConnectTypes } = await ensureTerminal(prep.isTest);

      // Apple requires the answer to come from Apple each time, not a cache.
      // No onBehalfOf: direct charges run on the connected account the
      // connection token was minted for.
      if (Capacitor.getPlatform() === "ios") {
        try {
          termsLinked = (await StripeTerminal.isTapToPayAccountLinked()).isLinked;
        } catch {
          termsLinked = null; // older iOS: connectReader still presents the terms
        }
      }

      const { reader } = await StripeTerminal.getConnectedReader();
      if (!reader) {
        const { readers } = await StripeTerminal.discoverReaders({
          type: TerminalConnectTypes.TapToPay,
          locationId: prep.locationId,
        });
        if (!readers.length) throw new Error("unsupported device");
        // On an iPhone whose business has not accepted Apple's terms, this is
        // where Apple shows them; a refusal comes back as an error.
        await StripeTerminal.connectReader({
          reader: readers[0],
          merchantDisplayName: prep.merchantDisplayName,
          autoReconnectOnUnexpectedDisconnect: true,
        });
      }

      const intent = await createTapToPayPaymentIntent({ data: { invoiceId } });
      setPhase("collecting");
      await StripeTerminal.collectPaymentMethod({ paymentIntent: intent.clientSecret });
      setPhase("finishing");
      await StripeTerminal.confirmPaymentIntent();

      try {
        await reconcileInvoiceNow({ data: { invoiceId } });
        toast.success(`Payment received: ${currencyLabel} by tap.`);
      } catch {
        toast.success("Payment received. The invoice will update shortly.");
      }
      setPhase("idle");
      onPaid();
    } catch (e) {
      const message = describeTapToPayError(e, { online: online(), termsLinked });
      setError(message);
      toast.error(message);
      setPhase("idle");
    }
  };

  const cancel = async () => {
    try {
      const { StripeTerminal } = await import("@capacitor-community/stripe-terminal");
      await StripeTerminal.cancelCollectPaymentMethod();
    } catch {
      // Already finished or never started; the run() catch reports the state.
    }
  };

  const busy = phase !== "idle";
  return (
    <div className="rounded-lg border bg-card p-3">
      <SectionLabel>Tap to pay</SectionLabel>
      <Button className="mt-2 w-full" disabled={busy} onClick={run}>
        <SmartphoneNfc className="mr-1.5 h-4 w-4 shrink-0" />
        {phase === "connecting"
          ? "Getting the phone ready…"
          : phase === "collecting"
            ? "Hold the card near the top of the phone"
            : phase === "finishing"
              ? "Approving…"
              : `Tap to pay ${currencyLabel}`}
      </Button>
      {phase === "collecting" && (
        <Button variant="outline" className="mt-2 w-full" onClick={cancel}>
          Cancel
        </Button>
      )}
      {error ? (
        <p className="mt-1.5 text-xs text-destructive">{error}</p>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          The client taps their card or phone on this phone. Nothing is saved. Each tap costs your
          business {tapToPayFeeLabel()} on top of the card rate, shown in your Stripe fees.
        </p>
      )}
    </div>
  );
}
