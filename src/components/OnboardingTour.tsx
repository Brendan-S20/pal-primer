import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { supabase, isImpersonationTab } from "@/integrations/supabase/client";
import { useMyRole, canAccess } from "@/hooks/useMyRole";
import { APP_NAME } from "@/lib/scoop";
import { hasSeenTourLocally, rememberTourSeen, forgetTourSeen } from "@/lib/tour-seen";
import { readLastUser } from "@/lib/offline/read-cache";

// Feature 4: one-time first-sign-in guided tour. Deliberately dependency-free
// (a spotlight overlay + positioned card) — tour libraries lag React majors
// and this needs ~6 steps, not a framework. Coexists with the "Get started"
// checklist: the tour explains what things ARE, the checklist tracks what's
// left to CONFIGURE.
//
// Persistence is per-user (auth user_metadata.tour_seen_at), not per-org, so a
// teammate added later still gets their own first-login tour, on any device.

const RESTART_EVENT = "hs:restart-tour";

/** Re-launch the tour (e.g. from the Knowledge Center). */
export function restartTour() {
  window.dispatchEvent(new CustomEvent(RESTART_EVENT));
}

type Step = {
  /** data-tour anchor. Sidebar item url on desktop; the phone tab bar carries
   *  the same values, plus "more" for everything that has no tab of its own. */
  anchor?: string;
  /** Where to actually TAKE them. The tour used to describe eight areas from a
   *  single dimmed screen, which on a phone — where the sidebar it anchored to
   *  does not exist — meant eight identical centred cards and no idea where
   *  anything was. Walking the app is the point of a guided tour. */
  route?: string;
  /** Anchor to fall back to when `anchor` is not on screen. On a phone the
   *  sections without a tab live behind More, and saying so is more useful
   *  than a card floating in the middle of nothing. */
  mobileAnchor?: string;
  title: string;
  body: string;
};

const ALL_STEPS: Array<Step & { requiresAccess?: string }> = [
  {
    title: `Welcome to ${APP_NAME}!`,
    body: "A quick 60-second orientation of the main areas. You can skip at any point, and re-run it later from the Knowledge Center.",
  },
  {
    anchor: "/dashboard",
    route: "/dashboard",
    requiresAccess: "/dashboard",
    title: "Dashboard",
    body: "Your morning glance: today's visits, revenue, alerts, and the Get-started checklist that tracks what's left to set up.",
  },
  {
    anchor: "/clients",
    route: "/clients",
    requiresAccess: "/clients",
    title: "Clients",
    body: "Every customer lives here: their properties, dogs, subscriptions, invoices, and portal link.",
  },
  {
    anchor: "/zones",
    route: "/zones",
    mobileAnchor: "more",
    requiresAccess: "/zones",
    title: "Zones",
    body: "A zone is a service area (a neighborhood or ZIP prefix). Routes, weather, and reports are all organized around zones, so set these up early.",
  },
  {
    anchor: "/routes",
    route: "/routes",
    requiresAccess: "/routes",
    title: "Routes",
    body: "Plan who goes where: assign visits to techs by zone, drag to reorder, and view the day on a map or board.",
  },
  {
    anchor: "/my-day",
    route: "/my-day",
    mobileAnchor: "more",
    requiresAccess: "/my-day",
    title: "My Day",
    body: "The field view: techs see their route in order, start and complete visits, snap photos, log skips, and bill add-ons.",
  },
  {
    anchor: "/invoices",
    route: "/invoices",
    mobileAnchor: "more",
    requiresAccess: "/invoices",
    title: "Invoices",
    body: 'Billing runs on completed visits. Generate them in a batch, or use "New invoice" to bill a client directly for one-off work.',
  },
  {
    anchor: "/settings",
    // NOT "/settings" — that route's `beforeLoad` throws a redirect to
    // /settings/preferences, so it is never a pathname anything settles on.
    // See the navigation effect below for why that used to matter enormously.
    route: "/settings/preferences",
    mobileAnchor: "more",
    requiresAccess: "/settings",
    title: "Settings",
    body: "Skip rules, blackout dates, add-on services, texting, payments. When something needs configuring, it's in here. That's the tour!",
  },
];

function rectFor(anchor?: string): DOMRect | null {
  if (!anchor) return null;
  const el = document.querySelector(`[data-tour="${anchor}"]`);
  if (!el) return null;
  const r = (el as HTMLElement).getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

/** The step's anchor, or its phone fallback when the first is not rendered.
 *  The sidebar is `hidden` below `md`, so on a phone the primary anchor for
 *  every step simply is not in the document. */
function getAnchorRect(step: Step): DOMRect | null {
  return rectFor(step.anchor) ?? rectFor(step.mobileAnchor);
}

/** Where to put the card so it neither covers the thing it is pointing at nor
 *  falls off the screen — and, on a phone, so it clears the status bar and the
 *  home indicator.
 *
 *  The old placement was `left: rect.right + 16`, i.e. always to the RIGHT of
 *  the anchor. That is correct for a left-hand sidebar and wrong for everything
 *  else: against the bottom tab bar it put the card off the side of the screen. */
function cardPosition(rect: DOMRect | null): React.CSSProperties {
  const CARD_W = 320;
  const GAP = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Keep clear of the app's own chrome, measured rather than assumed. Both bars
  // already carry the safe-area insets — the header pads by
  // env(safe-area-inset-top), the tab bar by env(safe-area-inset-bottom) — so
  // their real edges are the honest boundary on every device, and this needs no
  // knowledge of which platform it is running on.
  const header = document.querySelector("header");
  const tabBar = document.querySelector('nav[aria-label="Primary"]');
  const safeTop = header ? header.getBoundingClientRect().bottom : 0;
  const safeBottom = tabBar ? vh - tabBar.getBoundingClientRect().top : 0;

  if (!rect) {
    return { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  }

  const clampLeft = (x: number) => Math.max(GAP, Math.min(x, vw - CARD_W - GAP));

  // Anchor in the bottom third (the phone tab bar): sit above it.
  if (rect.top > vh * 0.6) {
    return {
      bottom: Math.max(vh - rect.top + GAP, safeBottom + GAP),
      left: clampLeft(rect.left + rect.width / 2 - CARD_W / 2),
    };
  }
  // Anchor on the left (the sidebar): sit beside it.
  if (rect.right < vw * 0.5) {
    return {
      top: Math.max(Math.min(rect.top, vh - 240 - safeBottom), safeTop + GAP),
      left: clampLeft(rect.right + GAP),
    };
  }
  // Anything else: below it.
  return {
    top: Math.min(rect.bottom + GAP, vh - 240 - safeBottom),
    left: clampLeft(rect.left + rect.width / 2 - CARD_W / 2),
  };
}

export function OnboardingTour() {
  const { role, loading } = useMyRole();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const [phase, setPhase] = useState<"unknown" | "hidden" | "active">("unknown");
  const [stepIdx, setStepIdx] = useState(0);
  const [, forceTick] = useState(0);
  /** Resolved once, so `finish` and the restart listener can stamp the right
   *  person without another round trip. */
  const userIdRef = useRef<string | null>(null);

  const steps = useMemo(
    () => ALL_STEPS.filter((s) => !s.requiresAccess || canAccess(role, s.requiresAccess)),
    [role],
  );

  // Decide once per session whether this user has seen the tour. Never
  // auto-fire in an impersonation tab (H3): the admin doesn't need the tour,
  // and dismissing it would consume the impersonated user's tour state.
  //
  // LOCAL RECORD FIRST, and it is not an optimisation. The old version asked
  // `supabase.auth.getUser()` — a network call — and failed OPEN: offline,
  // `data.user` is undefined, so `seen` is undefined, so the tour started. iOS
  // QA 2026-08-21 watched it do that on every offline launch, over a dashboard
  // whose figures were all dashes. Answering from the device settles it
  // instantly, and dismissing sticks even when the metadata write cannot go out.
  useEffect(() => {
    if (loading || phase !== "unknown") return;
    if (isImpersonationTab()) {
      setPhase("hidden");
      return;
    }
    // `readLastUser()` is a plain localStorage read of the id written on every
    // verified sign-in, so this branch needs nothing from the network.
    const localId = readLastUser();
    if (hasSeenTourLocally(localId)) {
      userIdRef.current = localId;
      setPhase("hidden");
      return;
    }
    let cancelled = false;
    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (cancelled) return;
        const id = data.user?.id ?? localId;
        userIdRef.current = id;
        // Only the SERVER can say "seen on another device". A failed call says
        // nothing at all, and must not be read as "not seen".
        if (data.user) {
          const seen = data.user.user_metadata?.tour_seen_at;
          if (seen) rememberTourSeen(id);
          setPhase(seen ? "hidden" : "active");
        } else {
          // Could not ask. The local record already said no, so show it — a
          // first run offline is the one case where that is right.
          setPhase("active");
        }
      })
      .catch(() => {
        if (!cancelled) setPhase("active");
      });
    return () => {
      cancelled = true;
    };
  }, [loading, phase]);

  useEffect(() => {
    const onRestart = () => {
      // Without this the local record would out-vote a deliberate "re-run the
      // tour" from the Knowledge Center for ever.
      forgetTourSeen(userIdRef.current ?? readLastUser());
      setStepIdx(0);
      setPhase("active");
    };
    window.addEventListener(RESTART_EVENT, onRestart);
    return () => window.removeEventListener(RESTART_EVENT, onRestart);
  }, []);

  // TAKE THEM THERE. This is what makes it a guided tour rather than eight
  // paragraphs over a dimmed screen: each step navigates to the area it is
  // describing, so the thing being explained is on screen behind the card.
  //
  // The welcome step has no route and stays wherever they landed.
  //
  // ONCE PER STEP, and the guard is a `useRef` rather than `pathname !==
  // step.route` on purpose. That comparison assumes the router ends up where it
  // was sent, and a route whose `beforeLoad` throws a `redirect` never does:
  // /settings lands on /settings/preferences, which still is not "/settings",
  // so the effect fired again, and again. The tour's last step navigated in a
  // loop and the app rendered a blank white screen — caught by TourWalk on
  // 2026-08-21, whose step-8 screenshot is nothing but a status bar.
  //
  // Keying on the step index also gets the behaviour people expect: browsing
  // away mid-step is not undone, and Back/Next re-navigates because the index
  // genuinely changed.
  const navigatedForStep = useRef<number | null>(null);
  useEffect(() => {
    if (phase !== "active") {
      navigatedForStep.current = null;
      return;
    }
    const step = steps[Math.min(stepIdx, steps.length - 1)];
    if (!step?.route) return;
    if (navigatedForStep.current === stepIdx) return;
    navigatedForStep.current = stepIdx;
    if (pathname === step.route) return;
    void navigate({ to: step.route });
  }, [phase, stepIdx, steps, pathname, navigate]);

  // A route change re-renders the page underneath, so the anchor this step
  // wants may not exist for a frame or two. Re-measure a few times rather than
  // reading once and settling for a centred card.
  useEffect(() => {
    if (phase !== "active") return;
    let n = 0;
    const id = setInterval(() => {
      forceTick((t) => t + 1);
      if (++n >= 8) clearInterval(id);
    }, 120);
    return () => clearInterval(id);
  }, [phase, stepIdx, pathname]);

  // Keep the spotlight glued to its anchor on resize/scroll.
  useEffect(() => {
    if (phase !== "active") return;
    const bump = () => forceTick((n) => n + 1);
    window.addEventListener("resize", bump);
    window.addEventListener("scroll", bump, true);
    return () => {
      window.removeEventListener("resize", bump);
      window.removeEventListener("scroll", bump, true);
    };
  }, [phase]);

  // Skip and Done are the same decision from the person's side, so both land
  // here. The LOCAL record is written first and unconditionally: it is the one
  // that works offline, and it is what stops the tour coming back on the next
  // launch when the metadata write cannot be sent.
  const finish = useCallback(async () => {
    setPhase("hidden");
    // An impersonating admin dismissing the tour must not stamp the
    // impersonated user's state — locally or on the server.
    if (isImpersonationTab()) return;
    rememberTourSeen(userIdRef.current ?? readLastUser());
    try {
      await supabase.auth.updateUser({
        data: { tour_seen_at: new Date().toISOString() },
      });
    } catch {
      // Offline, or the write was rejected. The device already remembers, so
      // the only thing lost is the cross-device record.
    }
  }, []);

  if (phase !== "active" || !steps.length) return null;
  const step = steps[Math.min(stepIdx, steps.length - 1)];
  const rect = getAnchorRect(step);
  const isLast = stepIdx >= steps.length - 1;

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-label="Guided tour">
      {/* Spotlight: the highlighted element stays visible through a cutout. */}
      {rect ? (
        <div
          className="absolute rounded-md transition-all duration-200"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
            pointerEvents: "none",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/55" />
      )}

      <div
        className="absolute w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-card p-4 shadow-xl"
        style={cardPosition(rect)}
      >
        <div className="text-xs text-muted-foreground">
          {stepIdx + 1} of {steps.length}
        </div>
        <h3 className="mt-1 text-base font-semibold">{step.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          {/* Skip is present on every step, per spec. */}
          <Button variant="ghost" size="sm" onClick={finish}>
            Skip tour
          </Button>
          <div className="flex gap-2">
            {stepIdx > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStepIdx((i) => i - 1)}>
                Back
              </Button>
            )}
            <Button size="sm" onClick={() => (isLast ? finish() : setStepIdx((i) => i + 1))}>
              {stepIdx === 0 ? "Start the tour" : isLast ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
