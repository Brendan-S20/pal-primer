// #638: the close-out prompt's X and Escape mean "Still working".
// See src/components/CloseOutOpenVisits.tsx.

/**
 * What the session's deferred list becomes when the dialog asks to change its
 * open state. Closing (X, Escape) defers the visit, same as "Still working";
 * anything else, or a close while an answer is still saving, changes nothing.
 */
export function deferredAfterOpenChange(
  open: boolean,
  saving: boolean,
  visitId: string,
  deferred: string[],
): string[] {
  if (open || saving || deferred.includes(visitId)) return deferred;
  return [...deferred, visitId];
}
