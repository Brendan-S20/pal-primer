// Tap to Pay on an open invoice (#579): the phone becomes the card reader.
//
// Native app only. StaffInvoicePayForm renders this behind IS_NATIVE_BUNDLE, a
// build-time constant, so the web build drops the component and never loads
// the Stripe Terminal plugin. Inside the app, `tapToPayGate` (src/lib/tap-to-pay.ts)
// decides which form it takes.
//
// Apple's Tap to Pay on iPhone review guide (v1.8), as this screen meets it:
//
//   5.2  first in the payment options (StaffInvoicePayForm puts it there),
//        with no scrolling past other options to reach it.
//   5.4  the label is "Tap to Pay on iPhone" (Android: "Tap to Pay"), never
//        with the amount in it; the amount is the form's "Amount due" above.
//   5.5  the icon is wave.3.right.circle (TapToPayMark). No Apple logo.
//   3.8.1 a role that cannot take the payment is told who can.
//   1.4  an iPhone below iOS 16.4 is told to update to the latest iOS
//        instead of seeing nothing; 16.4 to 17.5 can tap and is told too.
//   3.9.1, 5.7  the reader setup shows a progress meter.
//   5.8  a processing state of its own while the card is approved.
//   5.10 a receipt the merchant can send, after an approval AND a decline.
//   5.12 a tap interrupted by the app closing is reported (tap-to-pay-terminal).
//   4.3  "How it works" reopens the education screens.
//
// The money path is Take payment's: a direct charge on the business's
// connected account (tap-to-pay.server.ts), credited by the existing
// payment_intent.succeeded webhook. After the SDK confirms, the invoice is
// reconciled against Stripe at once, exactly as the card form does.
import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/client-detail/primitives";
import { TapToPayMark } from "@/components/tap-to-pay/TapToPayMark";
import { TapToPayProgress, useReaderSetupProgress } from "@/components/tap-to-pay/TapToPayProgress";
import { TapToPayEducation } from "@/components/tap-to-pay/TapToPayEducation";
import { usePermissions } from "@/hooks/useMyRole";
import { IS_NATIVE_BUNDLE } from "@/lib/native-build";
import {
  canAcceptTapToPayTerms,
  classifyTapToPayError,
  describeTapToPayError,
  iosUpdateAdvice,
  tapToPayFeeLabel,
  tapToPayGate,
  tapToPayLabel,
  tapToPayReceiptText,
  TAP_TO_PAY_MESSAGES,
  type TapToPayOutcome,
} from "@/lib/tap-to-pay";
import { createTapToPayPaymentIntent, prepareTapToPay } from "@/lib/tap-to-pay.functions";
import {
  clearTapInFlight,
  connectTapToPayReader,
  ensureTerminal,
  markTapInFlight,
  TapToPayNeedsAdminError,
} from "@/lib/tap-to-pay-terminal";
import { reconcileInvoiceNow } from "@/lib/invoices.functions";

type Phase =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "collecting" }
  | { kind: "processing" }
  | { kind: "result"; outcome: TapToPayOutcome; at: Date };

async function shareReceipt(text: string) {
  try {
    const { Share } = await import("@capacitor/share");
    await Share.share({ title: "Receipt", text, dialogTitle: "Send receipt" });
    return;
  } catch {
    /* fall through: no share sheet, or the person closed it */
  }
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Receipt copied. Paste it into a text or email.");
  } catch {
    toast.error("Couldn't open the share sheet.");
  }
}

export function TapToPayButton({
  invoiceId,
  invoiceStatus,
  dueCents,
  currencyLabel,
  cardPaymentsReady,
  invoiceLabel,
  onPaid,
}: {
  invoiceId: string;
  invoiceStatus: string | null | undefined;
  dueCents: number;
  /** The amount as the rest of the pay form prints it, e.g. "$45.00". */
  currencyLabel: string;
  cardPaymentsReady: boolean;
  /** The invoice number, for the receipt. */
  invoiceLabel?: string | null;
  onPaid: () => void;
}) {
  const { role } = usePermissions();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [businessName, setBusinessName] = useState("");
  const [educating, setEducating] = useState(false);
  const progress = useReaderSetupProgress();

  const platform = Capacitor.getPlatform();
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const gate = tapToPayGate({
    isNativeBundle: IS_NATIVE_BUNDLE,
    platform,
    userAgent,
    role,
    cardPaymentsReady,
    invoiceStatus,
    dueCents,
  });
  if (!gate.show) return null;
  const label = tapToPayLabel(platform);

  if (gate.mode !== "ready") {
    return (
      <div className="rounded-lg border bg-card p-3" data-testid="tap-to-pay">
        <SectionLabel>{label}</SectionLabel>
        <p className="mt-1.5 flex items-start gap-2 text-sm">
          <TapToPayMark className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <span className="min-w-0">
            {gate.mode === "update_ios"
              ? TAP_TO_PAY_MESSAGES.updateIosRequired
              : TAP_TO_PAY_MESSAGES.askAdminToPay}
          </span>
        </p>
      </div>
    );
  }

  const online = () => (typeof navigator === "undefined" ? true : navigator.onLine);

  const run = async () => {
    setError(null);
    if (!online()) {
      setError(TAP_TO_PAY_MESSAGES.offline);
      return;
    }
    let termsLinked: boolean | null = null;
    let collected = false;
    try {
      setPhase({ kind: "preparing" });
      const prep = await prepareTapToPay({ data: { invoiceId } });
      setBusinessName(prep.merchantDisplayName);
      // Apple's terms are read from Apple each time (1.6). Only the owner may
      // accept them (3.8); anyone else is told to ask (3.8.1), and Apple's
      // sheet is never raised for them.
      ({ termsLinked } = await connectTapToPayReader(prep, {
        platform,
        allowTerms: canAcceptTapToPayTerms(role),
      }));
      const { StripeTerminal } = await ensureTerminal(prep.isTest);

      const intent = await createTapToPayPaymentIntent({ data: { invoiceId } });
      markTapInFlight({ invoiceId, amountLabel: currencyLabel, at: Date.now() });
      setPhase({ kind: "collecting" });
      await StripeTerminal.collectPaymentMethod({ paymentIntent: intent.clientSecret });
      collected = true;
      setPhase({ kind: "processing" });
      await StripeTerminal.confirmPaymentIntent();
      clearTapInFlight();

      try {
        await reconcileInvoiceNow({ data: { invoiceId } });
        toast.success(`Payment received: ${currencyLabel} by tap.`);
      } catch {
        toast.success("Payment received. The invoice will update shortly.");
      }
      setPhase({ kind: "result", outcome: "approved", at: new Date() });
    } catch (e) {
      clearTapInFlight();
      if (e instanceof TapToPayNeedsAdminError) {
        setError(TAP_TO_PAY_MESSAGES.askAdmin);
        setPhase({ kind: "idle" });
        return;
      }
      const ctx = { online: online(), termsLinked };
      const { kind } = classifyTapToPayError(e, ctx);
      const message = describeTapToPayError(e, ctx);
      if (kind === "declined" || (collected && kind === "generic")) {
        // A card that was read and then not approved gets a receipt too (5.10).
        setError(message);
        setPhase({ kind: "result", outcome: "declined", at: new Date() });
        return;
      }
      setError(message);
      toast.error(message);
      setPhase({ kind: "idle" });
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

  const recommendUpdate = iosUpdateAdvice(platform, userAgent) === "recommended";

  return (
    <div className="rounded-lg border bg-card p-3" data-testid="tap-to-pay">
      {educating && <TapToPayEducation platform={platform} onClose={() => setEducating(false)} />}
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>{label}</SectionLabel>
        <Button
          variant="link"
          size="sm"
          className="h-auto shrink-0 px-0 text-xs touch:min-h-11"
          onClick={() => setEducating(true)}
        >
          How it works
        </Button>
      </div>

      {phase.kind === "result" ? (
        <div className="mt-2" data-testid="tap-to-pay-result" aria-live="polite">
          <p
            className={`text-base font-semibold ${phase.outcome === "approved" ? "" : "text-destructive"}`}
          >
            {phase.outcome === "approved"
              ? `Payment approved: ${currencyLabel}`
              : `Payment declined: ${currencyLabel}`}
          </p>
          {phase.outcome === "declined" && error && (
            <p className="mt-1 text-xs text-muted-foreground">{error}</p>
          )}
          <Button
            variant="outline"
            className="mt-3 h-11 w-full"
            onClick={() =>
              void shareReceipt(
                tapToPayReceiptText({
                  businessName,
                  amountLabel: currencyLabel,
                  outcome: phase.outcome,
                  invoiceLabel,
                  at: phase.at,
                }),
              )
            }
          >
            Send receipt
          </Button>
          {phase.outcome === "approved" ? (
            <Button className="mt-2 h-11 w-full" onClick={onPaid}>
              Done
            </Button>
          ) : (
            <Button
              className="mt-2 h-11 w-full"
              onClick={() => {
                setError(null);
                setPhase({ kind: "idle" });
              }}
            >
              Try another card
            </Button>
          )}
        </div>
      ) : phase.kind === "processing" ? (
        <div
          className="mt-2 flex items-center gap-3 rounded-md bg-muted p-3"
          role="status"
          aria-live="polite"
          data-testid="tap-to-pay-processing"
        >
          <Loader2 className="h-6 w-6 shrink-0 animate-spin text-primary" />
          <div className="min-w-0">
            <p className="font-medium">Processing payment</p>
            <p className="text-xs text-muted-foreground">
              Approving {currencyLabel} with the card's bank. Keep the app open.
            </p>
          </div>
        </div>
      ) : (
        <>
          <Button className="mt-2 h-11 w-full" disabled={phase.kind !== "idle"} onClick={run}>
            <TapToPayMark className="me-1.5 h-5 w-5" />
            {label}
          </Button>
          {phase.kind === "preparing" && <TapToPayProgress progress={progress} />}
          {phase.kind === "collecting" && (
            <>
              <p className="mt-2 text-sm font-medium" role="status">
                Ask the customer to hold their card near the top of the phone.
              </p>
              <Button variant="outline" className="mt-2 h-11 w-full" onClick={cancel}>
                Cancel
              </Button>
            </>
          )}
          {error ? (
            <p className="mt-1.5 text-xs text-destructive">{error}</p>
          ) : (
            <p className="mt-1.5 text-xs text-muted-foreground">
              The client taps their card or phone on this phone. Nothing is saved. Each tap costs
              your business {tapToPayFeeLabel()} on top of the card rate, taken out of the payout
              and shown in Stripe.
            </p>
          )}
          {recommendUpdate && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {TAP_TO_PAY_MESSAGES.updateIosRecommended}
            </p>
          )}
        </>
      )}
    </div>
  );
}
