// Tap to Pay on iPhone in Payments, Account tab (Apple's review guide 3.5, 3.6,
// 3.8.1, 3.9.1, 4.3, 1.4): turn it on outside checkout, see whether it is on,
// reopen the merchant education. Native app only: payments.tsx loads this
// lazily behind an inline VITE_NATIVE_BUNDLE check, so the web build carries
// none of it.
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { TapToPayMark } from "@/components/tap-to-pay/TapToPayMark";
import { TapToPayProgress, useReaderSetupProgress } from "@/components/tap-to-pay/TapToPayProgress";
import { TapToPayEducation } from "@/components/tap-to-pay/TapToPayEducation";
import {
  useTapToPayDevice,
  useTapToPayEnable,
  useTapToPayStatus,
} from "@/components/tap-to-pay/useTapToPay";
import { TAP_TO_PAY_MESSAGES, tapToPayFeeLabel, tapToPayLabel } from "@/lib/tap-to-pay";

export function TapToPaySettingsCard() {
  const device = useTapToPayDevice();
  const status = useTapToPayStatus();
  const s = status.data;
  const usable = !!s?.available && !!s?.canTap && device.canTap;
  const { state, enable } = useTapToPayEnable(usable, device.platform);
  const progress = useReaderSetupProgress();
  const [educating, setEducating] = useState(false);

  if (device.platform !== "ios" && device.platform !== "android") return null;
  // A Release build is signed without Tap to Pay until Apple approves distribution.
  if (!device.entitled) return null;
  if (device.platform === "ios" && !device.canTap && device.iosUpdate !== "required") return null;
  const label = tapToPayLabel(device.platform);
  const enableLabel = `Enable ${label}`;

  let body: ReactNode;
  if (device.iosUpdate === "required") {
    body = <p className="text-sm">{TAP_TO_PAY_MESSAGES.updateIosRequired}</p>;
  } else if (status.isLoading) {
    body = <p className="text-sm text-muted-foreground">Checking…</p>;
  } else if (!s?.available) {
    body = <p className="text-sm text-muted-foreground">{TAP_TO_PAY_MESSAGES.notAvailable}</p>;
  } else if (!s.canTap) {
    body = <p className="text-sm">{TAP_TO_PAY_MESSAGES.askAdminToPay}</p>;
  } else if (state.kind === "on") {
    body = (
      <p className="text-sm">
        <span className="font-medium">On.</span> Open any invoice and press {label} to take a
        payment.
      </p>
    );
  } else if (!s.canAcceptTerms && state.kind !== "checking") {
    body = (
      <>
        <p className="text-sm">{TAP_TO_PAY_MESSAGES.askAdmin}</p>
        {state.kind === "error" && (
          <p className="mt-1.5 text-xs text-destructive">{state.message}</p>
        )}
      </>
    );
  } else {
    body = (
      <>
        <p className="text-sm text-muted-foreground">
          Take contactless cards and digital wallets on this phone, with no extra hardware.
          {device.platform === "ios" &&
            " You accept Apple's terms once for the business, then any iPhone your team signs in on can take payments."}{" "}
          Each tap costs {tapToPayFeeLabel()} on top of the card rate.
        </p>
        <Button
          className="mt-3 h-11 w-full sm:w-auto"
          disabled={state.kind === "working" || state.kind === "checking"}
          onClick={() => void enable()}
        >
          <TapToPayMark className="me-1.5 h-5 w-5" />
          {state.kind === "working" ? "Setting up…" : enableLabel}
        </Button>
        {state.kind === "working" && <TapToPayProgress progress={progress} />}
        {state.kind === "error" && (
          <p className="mt-1.5 text-xs text-destructive">{state.message}</p>
        )}
      </>
    );
  }

  return (
    <div className="rounded-lg border p-4" data-testid="tap-to-pay-settings">
      {educating && (
        <TapToPayEducation platform={device.platform} onClose={() => setEducating(false)} />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TapToPayMark className="h-5 w-5 text-primary" />
          <div className="min-w-0 truncate text-sm font-medium">{label}</div>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => setEducating(true)}>
          How it works
        </Button>
      </div>
      <div className="mt-2">{body}</div>
      {device.iosUpdate === "recommended" && (
        <p className="mt-2 text-xs text-muted-foreground">
          {TAP_TO_PAY_MESSAGES.updateIosRecommended}
        </p>
      )}
    </div>
  );
}
