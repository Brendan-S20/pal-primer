// The Tap to Pay on iPhone announcement (Apple's review guide 3.1, 3.3, 6.2):
// one full-screen moment, shown once per person on this phone, to an
// eligible merchant whose business has Tap to Pay available. The owner can
// enable it right here (3.5); anyone else who can take payments is told to ask
// the owner (3.8.1). "Not now" closes it for good on this phone; Payments
// settings keeps the same action (3.6).
//
// The hero: Apple's Marketing Toolkit "Hero in-app banner" goes at
// public/tap-to-pay/hero-in-app-banner.png (TAP_TO_PAY_HERO_SRC). Until that
// file is dropped in, the image fails to load and the drawn symbol shows in
// its place, so the screen is complete either way.
//
// Native only: the _authenticated layout loads this lazily behind an inline
// VITE_NATIVE_BUNDLE check.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { TapToPayFullScreen } from "@/components/tap-to-pay/TapToPayFullScreen";
import { TapToPayMark } from "@/components/tap-to-pay/TapToPayMark";
import { TapToPayProgress, useReaderSetupProgress } from "@/components/tap-to-pay/TapToPayProgress";
import { TapToPayEducation } from "@/components/tap-to-pay/TapToPayEducation";
import {
  useTapToPayDevice,
  useTapToPayEnable,
  useTapToPayStatus,
} from "@/components/tap-to-pay/useTapToPay";
import { TAP_TO_PAY_MESSAGES, TAP_TO_PAY_ON_IPHONE } from "@/lib/tap-to-pay";

export const TAP_TO_PAY_HERO_SRC = "/tap-to-pay/hero-in-app-banner.png";
export const TAP_TO_PAY_ANNOUNCEMENT_SEEN_KEY = "hs.tap-to-pay.announcement.seen";

function seen(): boolean {
  try {
    return localStorage.getItem(TAP_TO_PAY_ANNOUNCEMENT_SEEN_KEY) === "1";
  } catch {
    return true; // cannot remember a "Not now": better never than every launch
  }
}
function markSeen() {
  try {
    localStorage.setItem(TAP_TO_PAY_ANNOUNCEMENT_SEEN_KEY, "1");
  } catch {
    /* nothing to remember with */
  }
}

/** Whether the announcement should open. Exported for tests. */
export function shouldAnnounce(input: {
  platform: string;
  deviceCanTap: boolean;
  status: { available: boolean; canTap: boolean } | undefined;
  alreadySeen: boolean;
}): boolean {
  return (
    input.platform === "ios" &&
    input.deviceCanTap &&
    !input.alreadySeen &&
    !!input.status?.available &&
    input.status.canTap
  );
}

export function TapToPayAnnouncement() {
  const device = useTapToPayDevice();
  const status = useTapToPayStatus();
  const [open, setOpen] = useState(false);
  const [heroFailed, setHeroFailed] = useState(false);
  const [educating, setEducating] = useState(false);
  const s = status.data;
  const { state, enable } = useTapToPayEnable(open && !!s?.canTap, device.platform);
  const progress = useReaderSetupProgress();

  useEffect(() => {
    if (
      shouldAnnounce({
        platform: device.platform,
        deviceCanTap: device.canTap,
        status: s,
        alreadySeen: seen(),
      })
    ) {
      setOpen(true);
    }
  }, [device.platform, device.canTap, s]);

  // Already on for this business: nothing to announce.
  useEffect(() => {
    if (open && state.kind === "on") {
      markSeen();
      setOpen(false);
    }
  }, [open, state.kind]);

  if (!open || !s) return null;
  const close = () => {
    markSeen();
    setOpen(false);
  };

  return (
    <TapToPayFullScreen label={`Introducing ${TAP_TO_PAY_ON_IPHONE}`} onClose={close}>
      {educating && (
        <TapToPayEducation platform={device.platform} onClose={() => setEducating(false)} />
      )}
      <div className="flex flex-1 flex-col" data-testid="tap-to-pay-announcement">
        <div className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl bg-muted">
          {heroFailed ? (
            <TapToPayMark className="h-24 w-24 text-primary" />
          ) : (
            <img
              src={TAP_TO_PAY_HERO_SRC}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setHeroFailed(true)}
            />
          )}
        </div>
        <h2 className="mt-6 text-2xl font-semibold">Accept payments with {TAP_TO_PAY_ON_IPHONE}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Take contactless credit and debit cards, Apple Pay and other digital wallets right on your
          iPhone. No extra hardware, no card reader to carry. The customer taps, and the invoice is
          paid.
        </p>
        {!s.canAcceptTerms && <p className="mt-4 text-sm">{TAP_TO_PAY_MESSAGES.askAdmin}</p>}
        {state.kind === "working" && <TapToPayProgress progress={progress} />}
        {state.kind === "error" && <p className="mt-3 text-sm text-destructive">{state.message}</p>}
        <div className="mt-auto space-y-2 pt-8">
          {s.canAcceptTerms ? (
            <Button
              className="h-11 w-full"
              disabled={state.kind === "working" || state.kind === "checking"}
              onClick={() => void enable()}
            >
              <TapToPayMark className="me-1.5 h-5 w-5" />
              {state.kind === "working" ? "Setting up…" : `Enable ${TAP_TO_PAY_ON_IPHONE}`}
            </Button>
          ) : (
            <Button className="h-11 w-full" onClick={close}>
              OK
            </Button>
          )}
          <Button variant="outline" className="h-11 w-full" onClick={() => setEducating(true)}>
            How it works
          </Button>
          {s.canAcceptTerms && (
            <Button variant="ghost" className="h-11 w-full" onClick={close}>
              Not now
            </Button>
          )}
        </div>
      </div>
    </TapToPayFullScreen>
  );
}
