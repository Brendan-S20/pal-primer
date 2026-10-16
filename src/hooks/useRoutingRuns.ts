// The auto-routing run(s) this person is waiting on, shared by the panel on
// /routes and the indicator in the app header.
//
// The source of truth is the server's row (routing_runs), polled while a run
// is in progress -- not this tab's memory -- so a reload, a second tab, or
// reopening the app all find the same run. What IS local is small and lives
// in the store below: whether the panel is open (so exactly one of the two
// announces a finished run), the id of a run this tab has just started (so
// polling starts before the row's first heartbeat), and runs this tab
// attached to that somebody else started.

import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useRouterState } from "@tanstack/react-router";
import { listMyRoutingRuns } from "@/lib/routing-runs.functions";
import { POLL_MS, isActive, type RoutingRunRow } from "@/lib/routing-run";

export const ROUTING_RUNS_KEY = ["routing-runs", "mine"] as const;

type UiState = {
  panelOpen: boolean;
  /** Run ids this tab started and has not yet seen a row for. */
  starting: string[];
  /** Somebody else's runs this tab attached to. */
  attached: string[];
};

let ui: UiState = { panelOpen: false, starting: [], attached: [] };
const listeners = new Set<() => void>();
const set = (next: Partial<UiState>) => {
  ui = { ...ui, ...next };
  listeners.forEach((l) => l());
};

/** Each finished run is announced once per tab, by whichever of the panel
 *  and the indicator gets there first. */
const claimed = new Set<string>();

export const routingUi = {
  get: () => ui,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setPanelOpen: (panelOpen: boolean) => set({ panelOpen }),
  starting: (id: string) => set({ starting: [...ui.starting, id] }),
  started: (id: string) => set({ starting: ui.starting.filter((x) => x !== id) }),
  attach: (id: string) =>
    ui.attached.includes(id) ? undefined : set({ attached: [...ui.attached, id].slice(-5) }),
  detach: (id: string) => set({ attached: ui.attached.filter((x) => x !== id) }),
  /** True the first time it is asked about `key` in this tab. */
  claim(key: string): boolean {
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  },
};

export function useRoutingUi(): UiState {
  return useSyncExternalStore(routingUi.subscribe, routingUi.get, routingUi.get);
}

/**
 * Poll the runs. Fast (POLL_MS) while one is in progress or about to be,
 * otherwise only on mount and focus: a person with nothing running pays one
 * small request per page load.
 *
 * `enabled` is false for a role that cannot route, so a technician's phone
 * never asks.
 */
export function useRoutingRuns(enabled = true) {
  const listFn = useServerFn(listMyRoutingRuns);
  const state = useRoutingUi();
  const onRoutes = useRouterState({ select: (s) => s.location.pathname === "/routes" });
  const q = useQuery({
    queryKey: ROUTING_RUNS_KEY,
    // On /routes every mount asks again, so the server hears watching: true.
    staleTime: onRoutes ? 0 : 30_000,
    enabled,
    queryFn: () =>
      listFn({
        data: {
          // "Looking at it": on /routes with the page in front of them. The
          // server stamps watched_at, and skips the push for that person.
          watching:
            onRoutes && typeof document !== "undefined" && document.visibilityState === "visible",
          also: routingUi.get().attached,
        },
      }),
    refetchInterval: (query) => {
      const runs = query.state.data?.runs ?? [];
      return runs.some((r) => isActive(r.status)) || routingUi.get().starting.length > 0
        ? POLL_MS
        : false;
    },
    refetchOnWindowFocus: true,
    retry: 1,
  });
  const runs: RoutingRunRow[] = q.data?.runs ?? [];
  // The server's clock, so "has this heartbeat stopped" is not a question
  // about whether the phone's clock is right.
  const serverNow = q.data?.serverNow ?? Date.now();
  return { runs, serverNow, starting: state.starting, refetch: q.refetch };
}
