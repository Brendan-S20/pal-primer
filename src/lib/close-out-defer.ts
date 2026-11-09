// #638: the close-out prompt's X and Escape mean "Still working".
// #721: and they put off EVERY visit the prompt is holding, for this load.
// See src/components/CloseOutOpenVisits.tsx.

/**
 * What the deferred list becomes when the dialog asks to change its open
 * state. Closing (X, Escape, a tap outside) defers every visit the prompt is
 * currently holding; anything else, or a close while an answer is still
 * saving, changes nothing.
 *
 * Every visit, not the one on screen (#721). The prompt shows one visit at a
 * time from a list, and the dialog stays open while the next one swaps in, so
 * deferring only the first meant a tech with three open visits pressed X and
 * saw the same dialog come straight back with the next one in it. X, Escape
 * and outside click "did nothing". A visit that goes stale later is not in
 * this list and is still asked about.
 */
export function deferredAfterOpenChange(
  open: boolean,
  saving: boolean,
  visitIds: readonly string[],
  deferred: string[],
): string[] {
  if (open || saving) return deferred;
  const added = visitIds.filter((id) => !deferred.includes(id));
  return added.length ? [...deferred, ...added] : deferred;
}

// Kept for this page load, outside the component (#721). My Day unmounts the
// prompt behind its loading skeleton whenever it opens a day it has not
// cached, so a list kept in component state was forgotten on every date
// change and the prompt came back. A reload still starts empty, and nothing
// is written anywhere: an open visit is unresolved work and should come back.
let deferredThisLoad: string[] = [];

export function deferredSoFar(): string[] {
  return deferredThisLoad;
}

export function rememberDeferred(ids: string[]): void {
  deferredThisLoad = ids;
}
