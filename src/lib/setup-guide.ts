// The guided setup: whether it is open for this person, and where they were.
//
// ── WHAT THIS REPLACED, AND WHY ───────────────────────────────────────────
//
// The first-run experience was a spotlight tour (OnboardingTour.tsx): a
// full-screen `fixed inset-0 z-[100]` overlay that walked eight areas of the
// app and described each one. Two things were wrong with it, and the owner
// named both: "the walk through tour isn't too productive and isn't allowed
// to continue through all the way."
//
//   * NOT PRODUCTIVE. It narrated buttons. At the end of it the business had
//     no address, no price, no client and nobody to run a route; the
//     checklist on the dashboard asked for all of that separately, so the
//     product had two first-run flows that did not know about each other.
//   * NOT COMPLETABLE. The overlay was its own layer over a live page, and
//     any page that put a modal up underneath it took the controls away: a
//     Radix dialog sets `pointer-events: none` on <body>, the tour card
//     inherited it, and Next stopped answering. See
//     tests/the-tour-that-would-not-finish.test.ts for the measured case.
//
// The replacement is not a layer. It is a page, /setup, that walks the
// SAME six steps the dashboard checklist lists (getOnboardingStatus is the
// single source of what the steps are and whether each is done) and does
// each one in place. Off that page, a one-line banner in the page flow says
// where they were and takes them back. Nothing floats over anything, so no
// page can trap the controls, and every control is an ordinary button in the
// document at every width.
//
// ── WHAT IS REMEMBERED, AND WHERE ─────────────────────────────────────────
//
//   * CLOSED (finished, or "not now"): the same per-user record the tour used,
//     `hs:tour-seen:<user>` on the device and `user_metadata.tour_seen_at` on
//     the account, so a person who dismissed the tour is not greeted again,
//     and the E2E seed's stamp keeps meaning what it meant.
//   * WHERE THEY WERE: `hs:setup-step:<user>` on the device, and the `step`
//     search param on /setup itself, so a reload lands on the same step and
//     so does leaving for /clients/new and coming back.
//
// Re-opening from the checklist or the Knowledge Center clears the closed
// record on both sides, and resumes at the first step still open.

import { useEffect, useSyncExternalStore } from "react";
import { supabase, isImpersonationTab } from "@/integrations/supabase/client";
import { readLastUser } from "@/lib/offline/read-cache";
import { hasSeenTourLocally, rememberTourSeen, forgetTourSeen } from "@/lib/tour-seen";
import { canAccess, type AppRole } from "@/hooks/useMyRole";
import type { OnboardingStep, OnboardingStepId } from "@/lib/onboarding.functions";

export const SETUP_PATH = "/setup";

/** The roles the guide is FOR: the people who can set a business up. A
 *  technician's first session is My Day, and a dispatcher cannot change the
 *  address, the price or the team, so neither is offered a flow of steps that
 *  would refuse them. */
export function canRunSetup(role: AppRole | null): boolean {
  return canAccess(role, SETUP_PATH);
}

/** The steps this person can actually do, in the server's order. */
export function stepsFor<T extends { gate?: string }>(
  steps: readonly T[],
  role: AppRole | null,
): T[] {
  // No gate means no restriction beyond being able to run setup at all: a
  // step from an older server (a deploy straddling this change) still shows.
  return steps.filter((s) => !s.gate || canAccess(role, s.gate));
}

/** Where to (re)start: the remembered step if it is still one of theirs,
 *  otherwise the first one not yet done, otherwise the first. */
export function startingStep(
  steps: readonly Pick<OnboardingStep, "id" | "done">[],
  remembered: string | null | undefined,
): OnboardingStepId | null {
  if (!steps.length) return null;
  const hit = steps.find((s) => s.id === remembered);
  if (hit) return hit.id;
  return (steps.find((s) => !s.done) ?? steps[0]).id;
}

/** The first step still open after `from`, wrapping to any open one before it,
 *  or null when every step is done. */
export function nextOpenStep(
  steps: readonly Pick<OnboardingStep, "id" | "done">[],
  from: string | null,
): OnboardingStepId | null {
  const i = steps.findIndex((s) => s.id === from);
  const after = steps.slice(i + 1).find((s) => !s.done);
  if (after) return after.id;
  const before = steps.slice(0, Math.max(i, 0)).find((s) => !s.done);
  return before?.id ?? null;
}

// ── The device record of where they were ──────────────────────────────────

const STEP_KEY = "hs:setup-step:";

function store(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readRememberedStep(userId: string | null): string | null {
  if (!userId) return null;
  try {
    return store()?.getItem(STEP_KEY + userId) ?? null;
  } catch {
    return null;
  }
}

export function rememberStep(userId: string | null, step: string): void {
  if (!userId) return;
  try {
    store()?.setItem(STEP_KEY + userId, step);
  } catch {
    /* blocked storage: the URL still carries the step */
  }
}

function forgetStep(userId: string | null): void {
  if (!userId) return;
  try {
    store()?.removeItem(STEP_KEY + userId);
  } catch {
    /* nothing worth failing on */
  }
}

// ── Open or closed, shared by the banner, the page, the checklist and Help ─

type Phase = "unknown" | "open" | "closed";
type State = { phase: Phase; userId: string | null };

let state: State = { phase: "unknown", userId: null };
let resolving = false;
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const SERVER_STATE: State = { phase: "unknown", userId: null };

/** Decide, once per session, whether the guide is open for this person.
 *
 *  LOCAL RECORD FIRST, for the reason tour-seen.ts gives: the server read
 *  fails offline, and a failure must not be read as "never seen". An
 *  impersonating admin never gets it and never consumes it. */
function resolvePhase() {
  if (resolving || state.phase !== "unknown") return;
  resolving = true;
  if (isImpersonationTab()) {
    set({ phase: "closed" });
    return;
  }
  const localId = readLastUser();
  if (hasSeenTourLocally(localId)) {
    set({ phase: "closed", userId: localId });
    return;
  }
  supabase.auth
    .getUser()
    .then(({ data }) => {
      const id = data.user?.id ?? localId;
      if (data.user) {
        const seen = data.user.user_metadata?.tour_seen_at;
        if (seen) rememberTourSeen(id);
        set({ phase: seen ? "closed" : "open", userId: id });
      } else {
        set({ phase: "open", userId: id });
      }
    })
    .catch(() => set({ phase: "open", userId: localId }));
}

/** Finished, or "not now". Same decision from the person's side. */
export function closeSetupGuide(): void {
  set({ phase: "closed" });
  if (isImpersonationTab()) return;
  const id = state.userId ?? readLastUser();
  rememberTourSeen(id);
  forgetStep(id);
  void supabase.auth.updateUser({ data: { tour_seen_at: new Date().toISOString() } }).catch(() => {
    // Offline or refused: the device remembers, which is what stops it
    // coming back on the next launch.
  });
}

/** Re-open it: from the checklist's "Guide me", or the Knowledge Center. */
export function openSetupGuide(): void {
  const id = state.userId ?? readLastUser();
  forgetTourSeen(id);
  set({ phase: "open", userId: id });
  if (isImpersonationTab()) return;
  void supabase.auth.updateUser({ data: { tour_seen_at: null } }).catch(() => {});
}

export function useSetupGuide(): State {
  useEffect(() => {
    resolvePhase();
  }, []);
  return useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
}

/** Test seam: start every test from "unknown". */
export function __resetSetupGuideForTests(): void {
  state = { phase: "unknown", userId: null };
  resolving = false;
}
