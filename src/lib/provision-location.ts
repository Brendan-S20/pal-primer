// BUILD-6 — the rules for opening a franchise location, in one place.
//
// The same four rules exist in three layers: this module (so the form can say
// what is wrong before a round trip), the zod validator on the server function,
// and provision_franchise_location itself. The SQL is the authority — it is the
// only one a caller cannot skip — but a form that submits, waits, and comes
// back with "name someone as the owner" is a worse way to say the same thing
// than a form that says it while you are looking at the field.
//
// Keeping them in a module rather than inline in the component is what makes
// that survivable: three copies of a rule drift, three call sites of one
// function do not.

export const LOCATION_MEMBER_ROLES = ["owner", "office_manager", "dispatcher", "tech"] as const;
export type LocationMemberRole = (typeof LOCATION_MEMBER_ROLES)[number];

export const ROLE_LABEL: Record<LocationMemberRole, string> = {
  owner: "Owner",
  office_manager: "Office manager",
  dispatcher: "Dispatcher",
  tech: "Technician",
};

/** Deliberately not in LOCATION_MEMBER_ROLES, and the SQL refuses it too: a
 *  tenant cannot mint platform access by naming it in a staff list. */
export const FORBIDDEN_LOCATION_ROLE = "platform_admin";

/** A "who works here on day one" list, not a staff directory — the location
 *  invites the rest itself. Unbounded, this is a send-mail-to-anyone button. */
export const MAX_LOCATION_MEMBERS = 25;

export type LocationMemberInput = { email: string; role: LocationMemberRole };

// Intentionally permissive. The point is to catch "bob@" and "bob at example",
// not to adjudicate RFC 5322 — anything subtler is decided by whether the mail
// arrives, and rejecting a valid address here is worse than accepting an
// invalid one.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Drops rows the user left blank — an unused row in a form is not a mistake. */
export function filledMembers(rows: readonly LocationMemberInput[]): LocationMemberInput[] {
  return rows
    .filter((r) => r.email.trim() !== "")
    .map((r) => ({ email: normalizeEmail(r.email), role: r.role }));
}

/**
 * The first reason this location cannot be opened, phrased for the person
 * filling in the form, or null if it can.
 *
 * Mirrors provision_franchise_location's guards in the order the SQL checks
 * them, so the message a user sees is the message they would have got anyway.
 */
export function locationProblem(
  name: string,
  rows: readonly LocationMemberInput[],
): string | null {
  if (!name.trim()) return "Give the location a name.";

  const members = filledMembers(rows);
  if (members.length === 0) return "Add at least the person who runs this location.";
  if (members.length > MAX_LOCATION_MEMBERS) {
    return `That's more than ${MAX_LOCATION_MEMBERS} people. Name whoever is there on day one — the location's owner can invite the rest.`;
  }

  const bad = members.find((m) => !EMAIL_RE.test(m.email));
  if (bad) return `${bad.email} doesn't look like an email address.`;

  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m.email)) {
      // Refused rather than collapsed, matching the SQL: listing someone as
      // owner and again as tech would otherwise silently pick one.
      return `${m.email} is listed more than once. Each person gets one row, with the one role they hold here.`;
    }
    seen.add(m.email);
  }

  if (!members.some((m) => m.role === "owner")) {
    // The parent is not a member of its own child, so an ownerless location is
    // an organization nobody in the product can reach — including the franchise
    // that just created it.
    return "Name someone as the owner of this location.";
  }

  return null;
}
