/**
 * Which dates Cover moves (#619).
 *
 * Cover used to hand on every open visit a tech held from today onward, so a
 * four-day absence quietly reassigned work for weeks after they were back.
 * It now moves only the dates they are away, and later work moves only when
 * the office ticks "also move later work".
 *
 * Dates are `YYYY-MM-DD` strings, compared as strings, inclusive at both
 * ends, the same as `is_staff_off` and the board's `offToday`.
 */

export type TimeOffRow = { starts_on: string; ends_on: string; reason?: string | null };

export type CoverWindow = {
  from: string;
  to: string;
  /** "time_off" when it came from a recorded absence, "day" when there was
   *  none and Cover falls back to the day on screen. */
  source: "time_off" | "day";
  reason: string | null;
};

/**
 * The absence that covers `day`, else the next one after it, clipped so it
 * never starts before `today` (a visit already in the past is not Cover's to
 * move). With no absence on record the window is `day` alone.
 */
export function pickCoverWindow(rows: TimeOffRow[], day: string, today: string): CoverWindow {
  const start = day < today ? today : day;
  const sorted = [...rows]
    .filter((r) => r.ends_on >= start)
    .sort((a, b) => (a.starts_on < b.starts_on ? -1 : a.starts_on > b.starts_on ? 1 : 0));
  const hit = sorted.find((r) => r.starts_on <= day && r.ends_on >= day) ?? sorted[0];
  if (!hit) return { from: start, to: start, source: "day", reason: null };
  return {
    from: hit.starts_on < today ? today : hit.starts_on,
    to: hit.ends_on,
    source: "time_off",
    reason: hit.reason ?? null,
  };
}

/** Split a by-day load into the days inside the window and the days after it. */
export function splitLoad<T extends { scheduled_on: string; visits: number }>(
  days: T[],
  win: { from: string; to: string },
) {
  const inside = days.filter((d) => d.scheduled_on >= win.from && d.scheduled_on <= win.to);
  const later = days.filter((d) => d.scheduled_on > win.to);
  const sum = (xs: T[]) => xs.reduce((s, d) => s + Number(d.visits ?? 0), 0);
  return { inside, later, insideTotal: sum(inside), laterTotal: sum(later) };
}

export type CoverVisit = { id: string; scheduled_on: string };

/**
 * Hand each visit to the other techs round-robin within its day, the same
 * order `redistribute_staff_work` uses, trying the next tech when one is
 * refused (a groom clash, or that tech is off that day). A visit nobody can
 * take stays where it was. Returns the ids that moved.
 */
export async function spreadVisits(
  visits: CoverVisit[],
  others: string[],
  assign: (visitId: string, staffId: string) => Promise<"ok" | "refused">,
): Promise<string[]> {
  const moved: string[] = [];
  if (others.length === 0) return moved;
  let lastDay: string | null = null;
  let rn = 0;
  for (const v of visits) {
    rn = v.scheduled_on === lastDay ? rn + 1 : 0;
    lastDay = v.scheduled_on;
    for (let t = 0; t < others.length; t++) {
      const staffId = others[(rn + t) % others.length];
      if ((await assign(v.id, staffId)) === "ok") {
        moved.push(v.id);
        break;
      }
    }
  }
  return moved;
}
