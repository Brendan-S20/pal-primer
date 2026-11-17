// What an EMPTY route start means, said in the box itself (#943). The hint
// used to be "123 Main St, Austin, TX 78701", which in muted grey on an empty
// field read as an address on file. An empty start makes the route start
// from the business address (staff_start_point / route-inputs.ts), so the
// hint says that, and cannot be mistaken for a saved value.
export const ROUTE_START_BLANK_HINT = "Leave blank to start from the business address";
