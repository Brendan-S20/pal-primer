/**
 * Is the client search still working on what was typed (#1011-6)?
 *
 * True from the first keystroke (the box waits 250 ms for a pause before it
 * asks the server) until the page for that text has arrived. During that time
 * the list shows the PREVIOUS results, so without a sign it looks stuck, or
 * worse, shows "No clients match" for text it has not searched yet.
 */
export function isSearching(args: {
  typed: string;
  searched: string;
  fetching: boolean;
  showingPreviousResults: boolean;
}): boolean {
  if (args.typed.trim() !== args.searched) return true;
  return args.fetching && args.showingPreviousResults;
}
