// One source of truth for "how far along is the setup".
//
// ── WHY THIS IS ITS OWN HOOK (onboarding audit, 2026-11-09, D5 + D9) ─────
//
// The setup banner, the dashboard checklist and /setup each declared their
// own `useQuery(["onboarding-status"])`, with their own staleTime (30s, 30s
// and the default), and each decided "started" for itself. Two things went
// wrong in the pilot walkthrough:
//
//   * D5: on a fresh device the banner read "Set up your business in 6 short
//     steps ... Start setup" above a checklist reading "Setup: 5 of 6 steps
//     done". The banner decided "started" from a localStorage key that only
//     the device the owner had used /setup on carries. Progress lives on the
//     server, so that is where "started" is read from now: see setupBanner().
//   * D9: back on the client page right after saving the first client, the
//     banner still read "2 of 6 done. Next: Add or import clients". The new
//     client form never invalidated this query, and the banner (mounted once,
//     in the layout) held a 30-second-fresh copy that nothing told it was
//     wrong. Every mutation that can complete a step now calls
//     invalidateOnboardingStatus(), and the query is never "fresh" for long
//     enough to outlive a step.

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getOnboardingStatus } from "@/lib/onboarding.functions";

export const ONBOARDING_STATUS_KEY = ["onboarding-status"] as const;

export type OnboardingStatus = Awaited<ReturnType<typeof getOnboardingStatus>>;

/** The status, shared by every surface that shows setup progress. */
export function useOnboardingStatus({ enabled = true }: { enabled?: boolean } = {}) {
  const statusFn = useServerFn(getOnboardingStatus);
  return useQuery({
    queryKey: ONBOARDING_STATUS_KEY,
    queryFn: () => statusFn(),
    enabled,
    // Short, not zero: three surfaces mounting together share one request,
    // and anything that changes a step invalidates it outright.
    staleTime: 5_000,
  });
}

/** Call after any mutation that can complete a setup step. Returns the
 *  refetch so a caller that needs the fresh answer can await it. */
export function invalidateOnboardingStatus(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: ONBOARDING_STATUS_KEY });
}
