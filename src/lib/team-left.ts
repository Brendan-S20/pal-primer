// Who has LEFT the team (#938). Pure, so the rule is pinned by a test rather
// than found on a screen.
//
// A teammate who was turned off and then chose "Leave and start my own"
// (leave_business_i_was_turned_off_in, 20261111150000) gives up exactly one
// row: their user_roles row in this business. Their staff row stays, turned
// off, because the visits and history they did point at it, and the business
// gets a `staff.left` line in its own activity_log.
//
// Settings -> Users drew its list from list_org_users, which starts from
// user_roles, so the moment somebody left they vanished from the page with no
// trace: not Active, not Turned off, not anything. Nothing new has to be
// recorded to say "Left" — it is already written down, in two places:
//
//   * a staff row with a login (user_id) whose account holds no membership of
//     this business any more, and
//   * the newest staff.left line for that account, which carries the date.
//
// A staff row with no login is a person who never signed in (a crew member
// the owner keeps on the board); that is not somebody who left, and it is not
// listed here.

export type LeftStaffRow = {
  id: string;
  user_id: string | null;
  display_name: string | null;
  email: string | null;
  role: string | null;
  active: boolean | null;
  created_at: string | null;
};

export type LeftEvent = {
  created_at: string;
  meta: { user_id?: unknown } | null;
};

export type LeftTeammate = {
  user_id: string;
  staff_id: string;
  display_name: string | null;
  email: string | null;
  role: string | null;
  /** When they left, from the business's own timeline. Null when the
   *  membership is gone but no staff.left line says when (an older removal). */
  left_at: string | null;
};

export function leftTeammates(a: {
  memberUserIds: Iterable<string | null | undefined>;
  staff: LeftStaffRow[];
  leftEvents: LeftEvent[];
}): LeftTeammate[] {
  const members = new Set<string>();
  for (const id of a.memberUserIds) if (id) members.add(id);

  // Newest staff.left per account.
  const leftAt = new Map<string, string>();
  for (const e of a.leftEvents) {
    const uid = typeof e.meta?.user_id === "string" ? e.meta.user_id : null;
    if (!uid) continue;
    const prev = leftAt.get(uid);
    if (!prev || e.created_at > prev) leftAt.set(uid, e.created_at);
  }

  // One line per person: their newest staff row, the one an invitation back
  // turns on again (accept_org_invite_for_current_user, 20261109180000).
  const newest = new Map<string, LeftStaffRow>();
  for (const s of a.staff) {
    if (!s.user_id || members.has(s.user_id) || s.active) continue;
    const prev = newest.get(s.user_id);
    if (!prev || (s.created_at ?? "") > (prev.created_at ?? "")) newest.set(s.user_id, s);
  }
  // A person with an active row elsewhere in this business is not "left".
  for (const s of a.staff) if (s.user_id && s.active) newest.delete(s.user_id);

  return [...newest.values()]
    .map((s) => ({
      user_id: s.user_id as string,
      staff_id: s.id,
      display_name: s.display_name,
      email: s.email,
      role: s.role,
      left_at: leftAt.get(s.user_id as string) ?? null,
    }))
    .sort((x, y) => (y.left_at ?? "").localeCompare(x.left_at ?? ""));
}

/** "Left Nov 12, 2026", or just "Left" when no date was recorded. */
export function leftLabel(leftAt: string | null | undefined): string {
  if (!leftAt) return "Left";
  const d = new Date(leftAt);
  if (Number.isNaN(d.getTime())) return "Left";
  return `Left ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}
