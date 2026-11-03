// Change sitter on a stay (gaps-r2-06). The select opens on the sitter the
// stay already has, offers only staff who run routes, and nothing moves until
// the office confirms a sentence that says which nights go to whom.
//
// Which visits move is decided by tg_stays_follow (migration
// 20261024080900): the stay's scheduled visits from the business's today on.
// A night already under way, done or canceled keeps its sitter. The sentence
// is built from the same rule (splitStayVisits) so it cannot promise more
// than the database does. Office screen, English.

import { daysBetween, splitStayVisits, type StayKind, type StayVisitRef } from "@/lib/stays";

export type SitterOption = { id: string; display_name: string | null };

type StaffRow = SitterOption & { is_field_tech?: boolean | null; active?: boolean | null };

/** The people a stay can go to: active staff who run routes, plus the stay's
 *  current sitter even when they no longer would, so the select can show who
 *  has it now instead of falling back to "Not assigned". */
export function sitterOptions(
  staff: readonly StaffRow[],
  current: { id: string | null; name: string | null },
): SitterOption[] {
  const out: SitterOption[] = staff
    .filter((s) => s.active !== false && (s.is_field_tech === true || s.id === current.id))
    .map((s) => ({ id: s.id, display_name: s.display_name }));
  if (current.id && !out.some((s) => s.id === current.id))
    out.unshift({ id: current.id, display_name: current.name });
  return out;
}

/** "3", "3–5", or "2, 4 and 5". */
function nightList(nums: readonly number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  if (sorted.length === 1) return String(sorted[0]);
  if (contiguous) return `${sorted[0]}–${sorted[sorted.length - 1]}`;
  return `${sorted.slice(0, -1).join(", ")} and ${sorted[sorted.length - 1]}`;
}

function shortDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** What the confirm says before a stay's sitter changes:
 *  "Nights 3–5 move to Jordan." / "The 4 visits from Nov 2 to Nov 3 will have
 *  no sitter." */
export function sitterChangeSentence(input: {
  kind: StayKind;
  startsOn: string;
  visits: readonly StayVisitRef[];
  today: string;
  toName: string | null;
}): string {
  const { future } = splitStayVisits(input.visits, input.today);
  const to = input.toName?.trim();
  const tail = to ? `to ${to}.` : null;
  if (future.length === 0)
    return to
      ? `No visits are still to come, so none move. ${to} becomes the stay's sitter.`
      : "No visits are still to come, so none move. The stay will have no sitter.";
  if (input.kind === "overnight") {
    const nums = future.map((v) => daysBetween(input.startsOn, v.scheduled_on) + 1);
    const single = new Set(nums).size === 1;
    const label = `${single ? "Night" : "Nights"} ${nightList(nums)}`;
    return tail ? `${label} ${single ? "moves" : "move"} ${tail}` : `${label} will have no sitter.`;
  }
  const days = future.map((v) => v.scheduled_on).sort();
  const first = shortDate(days[0]);
  const last = shortDate(days[days.length - 1]);
  const label =
    future.length === 1
      ? `The visit on ${first}`
      : `The ${future.length} visits ${first === last ? `on ${first}` : `from ${first} to ${last}`}`;
  return tail
    ? `${label} ${future.length === 1 ? "moves" : "move"} ${tail}`
    : `${label} will have no sitter.`;
}
