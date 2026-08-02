import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, isImpersonationTab } from "@/integrations/supabase/client";
import { endImpersonationSession } from "@/lib/platform.functions";
import { IMPERSONATION_EXPIRED_EVENT } from "@/lib/impersonation-expiry";
import { ShieldAlert, Clock } from "lucide-react";

// Persistent, page-independent banner shown on EVERY page of an impersonation
// tab (QA finding #5 / H2), with a one-click exit that ends only this tab's
// sessionStorage-scoped session — never the admin's own — and closes the audit
// loop with a stop event + duration.
//
// BUG-2: the session is now bounded. The banner counts down to the window the
// server enforces, and when it closes the tab stops pretending to work: the
// impersonated session is signed out and a blocking notice takes over, with
// one click to start a fresh session. It never silently falls back to another
// identity — signing out is what guarantees the next request cannot be served
// as anyone else.

type Info = {
  email: string;
  orgName: string;
  grantId?: string;
  startedAt?: string;
  sessionExpiresAt?: string;
  organizationId?: string;
  targetUserId?: string;
};

/** Message the expired tab sends to the admin console that opened it, asking
 *  for a fresh grant. The console mints it and opens a new impersonation tab
 *  through its normal path — this tab never handles admin credentials. */
export const REIMPERSONATE_MESSAGE = "hs:reimpersonate";

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins >= 1) return `${mins}m left`;
  return `${secs}s left`;
}

export function ImpersonationBanner() {
  const [info, setInfo] = useState<Info | null>(null);
  const [exiting, setExiting] = useState(false);
  const [expired, setExpired] = useState(false);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const infoRef = useRef<Info | null>(null);
  const [reimpersonateState, setReimpersonateState] = useState<"idle" | "asked" | "unavailable">(
    "idle",
  );
  const expiredRef = useRef(false);

  useEffect(() => {
    if (!isImpersonationTab()) return;
    try {
      const raw = window.sessionStorage.getItem("hs_impersonation");
      if (raw) {
        const parsed = JSON.parse(raw);
        infoRef.current = parsed;
        setInfo(parsed);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Tear the session down the moment we decide it is over, so no later request
  // can be served under the impersonated identity.
  const expire = useCallback(async () => {
    if (expiredRef.current) return;
    expiredRef.current = true;
    setExpired(true);
    // BUG-14: close the audit loop here too, not only on the Exit button.
    // Reaching the deadline with the tab open is an OBSERVED end, so this is
    // the one chance to record a real, measured duration — the nightly sweep
    // can only ever record the window bound. Order matters: signing out first
    // would leave nothing to authorize this call. Still safe after the window
    // has closed, because endImpersonationSession authorizes on the caller
    // owning the grant and does not run through the expiry gate.
    const grantId = infoRef.current?.grantId;
    if (grantId) {
      try {
        await endImpersonationSession({ data: { grantId } });
      } catch {
        /* the sweep is the backstop — never block the sign-out */
      }
    }
    try {
      await supabase.auth.signOut();
    } catch {
      /* the blocking notice stands regardless */
    }
  }, []);

  // The server is authoritative (it also covers a grant ended early from the
  // console, and a tab whose clock can't be trusted); this listener is how its
  // rejection reaches the UI.
  useEffect(() => {
    if (!isImpersonationTab()) return;
    const onExpired = () => void expire();
    window.addEventListener(IMPERSONATION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(IMPERSONATION_EXPIRED_EVENT, onExpired);
  }, [expire]);

  // Local countdown: shows the operator how long they have and trips at the
  // deadline even if the tab is sitting idle making no requests — the exact
  // case the finding describes. Re-checks on focus because timers in a
  // backgrounded tab are throttled.
  useEffect(() => {
    if (!info?.sessionExpiresAt) return;
    const deadline = Date.parse(info.sessionExpiresAt);
    if (!Number.isFinite(deadline)) return;

    const tick = () => {
      const left = deadline - Date.now();
      setRemainingMs(left);
      if (left <= 0) void expire();
    };
    tick();
    const id = window.setInterval(tick, 15_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [info?.sessionExpiresAt, expire]);

  if (!info) return null;

  const exit = async () => {
    setExiting(true);
    // Record the stop event + duration BEFORE we sign out, while the grant id
    // is still to hand. Authorized by grant-id possession (server-side), so it
    // works even though this tab holds only the impersonated user's session.
    if (info.grantId) {
      try {
        await endImpersonationSession({ data: { grantId: info.grantId } });
      } catch {
        /* audit is best-effort — never block the exit */
      }
    }
    try {
      await supabase.auth.signOut();
      window.sessionStorage.removeItem("hs_impersonation");
    } catch {
      /* best effort */
    }
    // The tab was opened by the admin console; closing it returns them cleanly
    // to their own still-intact session. Fall back to a blank page if the
    // browser refuses to close a script-opened tab.
    window.close();
    window.location.replace("about:blank");
  };

  const reimpersonate = () => {
    // Minting a grant requires platform-admin rights, which this tab does not
    // have (by design). Ask the opener — the console that started us — to do
    // it. If the opener is gone there is nothing to ask, so say so plainly
    // rather than offering a button that does nothing (guardrail 10.9).
    const opener = window.opener as Window | null;
    if (!opener || opener.closed || !info.organizationId || !info.targetUserId) {
      setReimpersonateState("unavailable");
      return;
    }
    try {
      opener.postMessage(
        {
          type: REIMPERSONATE_MESSAGE,
          organizationId: info.organizationId,
          targetUserId: info.targetUserId,
        },
        window.location.origin,
      );
      opener.focus();
      setReimpersonateState("asked");
      try {
        window.sessionStorage.removeItem("hs_impersonation");
      } catch {
        /* non-fatal */
      }
      window.close();
    } catch {
      setReimpersonateState("unavailable");
    }
  };

  if (expired) {
    return (
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Impersonation session ended"
        className="fixed inset-0 z-[200] flex items-center justify-center bg-background/95 p-6 backdrop-blur"
      >
        <div className="w-full max-w-sm rounded-lg border bg-card p-6 text-center shadow-lg">
          <Clock className="mx-auto h-8 w-8 text-amber-600" />
          <h1 className="mt-3 text-lg font-semibold">Impersonation session ended</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your session viewing as <strong className="text-foreground">{info.email}</strong> (
            {info.orgName}) reached its time limit and has been signed out. Nothing on this page is
            live any more.
          </p>
          {reimpersonateState === "unavailable" && (
            <p className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
              The admin console tab that started this session is closed. Open the tenant in the
              platform console and start impersonation again from there.
            </p>
          )}
          <div className="mt-5 flex flex-col gap-2">
            {reimpersonateState !== "unavailable" && (
              <button
                onClick={reimpersonate}
                disabled={reimpersonateState === "asked"}
                className="rounded bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {reimpersonateState === "asked" ? "Starting…" : "Re-impersonate"}
              </button>
            )}
            <button
              onClick={() => {
                try {
                  window.sessionStorage.removeItem("hs_impersonation");
                } catch {
                  /* non-fatal */
                }
                window.close();
                window.location.replace("about:blank");
              }}
              className="rounded border px-3 py-2 text-sm font-medium hover:bg-muted"
            >
              Close this tab
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Surface the countdown only once it is close enough to matter, so the
  // banner doesn't read as a stopwatch for the whole session.
  const showCountdown = remainingMs !== null && remainingMs <= 10 * 60_000;

  return (
    <div
      role="alert"
      className="sticky top-0 z-[100] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-4 py-2 text-center text-sm font-medium text-amber-950"
    >
      <ShieldAlert className="h-4 w-4 shrink-0" />
      <span>
        Viewing as <strong>{info.email}</strong> ({info.orgName}), platform-admin impersonation
      </span>
      {showCountdown && (
        <span className="inline-flex items-center gap-1 rounded bg-amber-950/15 px-1.5 py-0.5 text-xs">
          <Clock className="h-3 w-3" />
          {formatRemaining(remainingMs!)}
        </span>
      )}
      <button
        onClick={exit}
        disabled={exiting}
        className="rounded bg-amber-950 px-2 py-0.5 text-xs font-semibold text-amber-50 hover:bg-amber-900 disabled:opacity-60"
      >
        {exiting ? "Exiting…" : "Exit impersonation"}
      </button>
    </div>
  );
}
