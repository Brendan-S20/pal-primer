// The words around auto-routing's Undo (#435). Kept apart from the panel so
// they can be tested without rendering it.

import type { RoutingRunUndoState } from "@/lib/routing-runs.functions";

/** "Moved 14 visits across 3 techs." Moved means a different technician or a
 *  different place in the order. */
export function undoSummaryLine(moved: number, techs: number): string {
  const v = moved === 1 ? "1 visit" : `${moved} visits`;
  if (techs <= 0) return `Moved ${v}.`;
  return `Moved ${v} across ${techs === 1 ? "1 tech" : `${techs} techs`}.`;
}

/** Why Undo is not on offer, for the one case a person asked for it. */
export function undoUnavailableLine(reason: RoutingRunUndoState["reason"]): string {
  switch (reason) {
    case "expired":
      return "Undo is no longer available: it lasts 15 minutes after auto-routing saves.";
    case "changed_since":
      return "Undo is no longer available: the schedule has changed since.";
    case "later_run":
      return "Undo is no longer available: auto-routing has run again since.";
    case "nothing_changed":
      return "Auto-routing did not change anything to undo.";
    default:
      return "There is nothing to undo for this run.";
  }
}

/** How long the Undo toast stays: a minute, or less if the server's window
 *  closes sooner. Never under ten seconds, so it can be read. */
export function undoToastMs(expiresAt: string | null, now: number): number {
  const left = expiresAt ? Date.parse(expiresAt) - now : 60_000;
  return Math.max(10_000, Math.min(60_000, Number.isFinite(left) ? left : 60_000));
}
