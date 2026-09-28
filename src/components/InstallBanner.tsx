// "Install app" banner. Chromium fires beforeinstallprompt only on eligible
// origins (HTTPS, valid manifest, service worker registered). We render
// nothing in preview/dev, iframes, or once the user has dismissed or
// installed. Safe to mount anywhere — it only appears when the browser
// actually offers install.

import { useEffect, useState } from "react";
import { X, Download } from "lucide-react";

interface BIPEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "pwa-install-dismissed-at";
const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function shouldSkip(): boolean {
  if (typeof window === "undefined") return true;
  if (window.self !== window.top) return true; // iframe / editor preview
  // Already installed (standalone display mode)
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  if ((window.navigator as any).standalone === true) return true;
  const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
  if (dismissedAt && Date.now() - dismissedAt < COOLDOWN_MS) return true;
  return false;
}

export function InstallBanner() {
  const [evt, setEvt] = useState<BIPEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (shouldSkip()) return;
    const onBip = (e: Event) => {
      e.preventDefault();
      setEvt(e as BIPEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    };
    window.addEventListener("beforeinstallprompt", onBip);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBip);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!visible || !evt) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
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
          className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
        >
          Install
        </button>
        <button
          onClick={dismiss}
          className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-accent"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4 shrink-0" />
        </button>
      </div>
    </div>
  );
}
