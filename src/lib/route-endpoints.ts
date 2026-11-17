// What an EMPTY route start or route end means, said in the box itself, and
// what a save actually stored, said in the toast.
//
// #943: the route start box's hint used to be "123 Main St, Austin, TX 78701".
// In muted grey on an empty field it read as an address on file, so an owner
// who had cleared the field, saved and reloaded saw "the old address come
// back" and reported a save that did not persist. It had persisted; the box
// was empty and the hint looked like data. #951 changed it to "Street, city,
// state and ZIP", which no longer looks like an address but still says
// nothing about the case that confused the owner: what an empty box DOES.
//
// The rule is the solver's, not this file's:
//   start  staff_start_point / route-inputs.ts: the person's own start, then
//          the business address.
//   end    staff_end_point: the person's own end, then the nearest active
//          dump site (pet waste only has those), then nowhere -- the route
//          ends at its last stop.

/** The hint in an empty Route start box. Cannot be read as an address. */
export const ROUTE_START_BLANK_HINT = "Leave blank to start from the business address";

/** The hint in an empty Route end box. A business that does not run pet
 *  waste has no dump sites, so it is not told about one. */
export function routeEndBlankHint(petWaste: boolean): string {
  return petWaste
    ? "Leave blank to end at the dump site or last stop"
    : "Leave blank to end at the last stop";
}

/**
 * The toast after a save, built from what the server says it STORED rather
 * than from what was typed, so an emptied field is never reported with the
 * generic "saved" that #943 read as a false success.
 */
export function routeEndpointsSavedMessage(
  stored: { startAddress: string | null; endAddress: string | null },
  petWaste: boolean,
): string {
  const start = stored.startAddress?.trim() || null;
  const end = stored.endAddress?.trim() || null;
  if (start && end) return "Route start and end saved.";
  const parts = ["Saved."];
  if (!start) parts.push("No route start: routes start from the business address.");
  if (!end)
    parts.push(
      petWaste
        ? "No route end: routes end at the dump site, or the last stop if there is none."
        : "No route end: routes end at the last stop.",
    );
  return parts.join(" ");
}
