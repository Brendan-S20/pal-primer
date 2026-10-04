// "Install app" banner. Chromium fires beforeinstallprompt only on eligible
// origins (HTTPS, valid manifest, service worker registered). We render
// nothing in preview/dev, iframes, or once the user has dismissed or
// installed. Safe to mount anywhere — it only appears when the browser
// actually offers install.
//
// Dismissal goes through src/lib/dismissible.ts (2026-10-03), which is the same
// rule as before, 14 days and then it may ask again, but with storage access
// that cannot throw: the old `localStorage.getItem` here was unguarded, and
// private-mode Safari throws on access. Installing records the same dismissal,
// so an installed app is not offered itself.

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useMyRole } from "@/hooks/useMyRole";
import { useDismissed } from "@/lib/dismissible";
import { DismissButton } from "@/components/DismissButton";

interface BIPEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Asks again a fortnight after "not now". One version: nothing about the
 *  offer changes, only how long ago it was declined. */
const SNOOZE_DAYS = 14;

function shouldSkip(): boolean {
  if (typeof window === "undefined") return true;
  if (window.self !== window.top) return true; // iframe / editor preview
  // Already installed (standalone display mode)
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  if ((window.navigator as any).standalone === true) return true;
  return false;
}

export function InstallBanner() {
  const [evt, setEvt] = useState<BIPEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const { orgId } = useMyRole();
  const { dismissed, dismiss: rememberDismissal } = useDismissed("pwa-install", "1", {
    orgId,
    snoozeDays: SNOOZE_DAYS,
  });

  useEffect(() => {
    if (shouldSkip()) return;
    const onBip = (e: Event) => {
      e.preventDefault();
      setEvt(e as BIPEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      rememberDismissal();
    };
    window.addEventListener("beforeinstallprompt", onBip);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBip);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [rememberDismissal]);

  if (!visible || !evt || dismissed) return null;

  const dismiss = () => {
    rememberDismissal();
    setVisible(false);
  };

  const install = async () => {
    try {
      await evt.prompt();
      await evt.userChoice;
    } finally {
      setVisible(false);
    }
  };

  return (
    // Below md the app shows a fixed bottom tab bar (3.5rem + safe area) —
    // sit the banner above it instead of covering the tabs.
    <div className="pointer-events-none fixed inset-x-0 bottom-2 z-40 flex justify-center px-2 max-md:bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)]">
      <div className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-lg border bg-card p-3 shadow-lg">
        <Download className="h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium">Install for faster field access</div>
          <div className="text-xs text-muted-foreground">
            Adds an app icon and works offline on your route.
          </div>
        </div>
        <button
          onClick={install}
          className="h-9 shrink-0 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground touch:h-11"
        >
          Install
        </button>
        <DismissButton
          onClick={dismiss}
          label="Not now"
          className="text-muted-foreground hover:bg-accent"
        />
      </div>
    </div>
  );
}
