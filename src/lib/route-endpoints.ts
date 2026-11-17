// What an EMPTY route start means, said in the box itself (#943). The hint
// used to be "123 Main St, Austin, TX 78701", which in muted grey on an empty
// field read as an address on file. An empty start makes the route start
// from the business address (staff_start_point / route-inputs.ts), so the
// hint says that, short enough to fit the box at 390px, and cannot be
// mistaken for a saved value.
export const ROUTE_START_BLANK_HINT = "Leave blank for business address";

// What an EMPTY route end means, for a business that does not run pet waste
// (#768). Not the business address: staff_end_point (20260831150000) tries
// the person's own end, then the nearest active dump site, then nothing, and
// route-inputs.ts adds an end node only when one came back, so with no dump
// site the day is an open path that stops at its last visit. A pet-waste
// business keeps "Landfill or home address": its empty end is the dump site.
export const ROUTE_END_BLANK_HINT = "Leave blank to end at the last visit";
