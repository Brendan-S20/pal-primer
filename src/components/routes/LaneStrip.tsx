/**
 * Per-tech lanes for week and month.
 *
 * The board — one draggable column per tech — only ever existed on Today,
 * because a column of cards cannot represent seven days at once. So week and
 * month showed a calendar and nothing else, and the question those views are
 * actually opened to answer ("is anybody's week lopsided", "who is out on the
 * 14th") had no surface at all.
 *
 * This is the same information as a lane, folded to one row per person and one
 * cell per day. Read-only on purpose: dragging a card here would have to mean
 * "move it to this tech AND this day", two changes from one gesture, with the
 * sequence within the day left arbitrary. Clicking a cell jumps to that day's
 * real board, where the drag means one thing.
 */
import { useMemo } from "react";

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

/** Local-noon parse. `new Date("2026-08-04")` is UTC midnight, which is the
 *  previous day west of Greenwich — the same off-by-one that made the calendar
 *  header disagree with its own cells before `calendarWindow` existed. */
const at = (d: string) => new Date(`${d}T12:00:00`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

function eachDay(from: string, to: string) {
  const out: string[] = [];
  for (let d = at(from); iso(d) <= to; d.setDate(d.getDate() + 1)) out.push(iso(d));
  return out;
}

export function LaneStrip({
  from,
  to,
  visits,
  staff,
  timeOff,
  techColors,
  hideWeekends,
  onPickDay,
  compact,
}: {
  from: string;
  to: string;
  visits: any[];
  staff: any[];
  timeOff: Array<{ staff_id: string; starts_on: string; ends_on: string }>;
  techColors: Map<string, string>;
  hideWeekends?: boolean;
  onPickDay: (day: string) => void;
  compact?: boolean;
}) {
  const days = useMemo(() => {
    const all = eachDay(from, to);
    // Matches the calendar's own weekend handling, so the two never show a
    // different number of columns for the same window.
    return hideWeekends ? all.filter((d) => ![0, 6].includes(at(d).getDay())) : all;
  }, [from, to, hideWeekends]);

  /** counts[staffId][day] — built in one pass. A nested filter per cell would
   *  be days × techs scans of the whole window on every render. */
  const counts = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const v of visits) {
      const k = v.assigned_staff_id ?? "__unassigned";
      const inner = m.get(k) ?? new Map<string, number>();
      inner.set(v.scheduled_on, (inner.get(v.scheduled_on) ?? 0) + 1);
      m.set(k, inner);
    }
    return m;
  }, [visits]);

  const offOn = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const t of timeOff) {
      const set = m.get(t.staff_id) ?? new Set<string>();
      // Inclusive both ends, matching `is_staff_off` in SQL.
      for (const d of days) if (d >= t.starts_on && d <= t.ends_on) set.add(d);
      m.set(t.staff_id, set);
    }
    return m;
  }, [timeOff, days]);

  // Field techs only, matching the board and the load panel. A dispatcher who
  // still holds a stray visit shows up in the unassigned row below rather than
  // earning a lane they should not have.
  const techs = staff.filter((s: any) => s.is_field_tech);
  const unassigned = counts.get("__unassigned");

  // The busiest single cell sets the shading scale. A fixed threshold would
  // paint every cell dark for a large org and every cell pale for a small one.
  const peak = useMemo(() => {
    let n = 0;
    for (const [, inner] of counts) for (const [, c] of inner) if (c > n) n = c;
    return Math.max(n, 1);
  }, [counts]);

  if (techs.length === 0 && !unassigned) return null;

  // MEASURED 2026-08-19: 32.0px, forty-nine of them on a week (seven
  // technicians x seven days). Every cell is a button — it opens that
  // technician's day — so the touch floor applies however chart-like the grid
  // looks. Only below `md`: the strip is a density display on a desktop and
  // taller cells there would cost the at-a-glance read it exists for.
  const cell = compact ? "h-6 max-md:h-11 text-3xs" : "h-8 max-md:h-11 text-2xs";

  return (
    <div className="relative overflow-x-auto rounded-lg border bg-card">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b">
            <th className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left font-medium">
              Lanes
            </th>
            {days.map((d) => (
              <th key={d} className="px-1 py-1.5 text-center font-normal text-muted-foreground">
                <div>{DOW[at(d).getDay()]}</div>
                <div className="text-3xs">{at(d).getDate()}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {techs.map((s: any) => {
            const inner = counts.get(s.id);
            const off = offOn.get(s.id);
            return (
              <tr key={s.id} className="border-b last:border-0">
                <td className="sticky left-0 z-10 max-w-[10rem] truncate bg-card px-3 py-1">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: techColors.get(s.id) ?? "#888" }}
                    />
                    <span className="truncate">{s.display_name}</span>
                  </span>
                </td>
                {days.map((d) => {
                  const n = inner?.get(d) ?? 0;
                  const away = off?.has(d);
                  return (
                    <td key={d} className="p-0.5">
                      <button
                        onClick={() => onPickDay(d)}
                        title={
                          away
                            ? `${s.display_name} is away on ${d}${n ? ` — ${n} visit(s) still assigned` : ""}`
                            : `${n} visit${n === 1 ? "" : "s"} on ${d}`
                        }
                        className={`flex w-full items-center justify-center rounded ${cell} ${
                          away
                            ? // Away wins the cell even when work is on it —
                              // that combination is the one worth noticing, and
                              // a count alone would read as a normal day.
                              "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                            : n === 0
                              ? "text-muted-foreground/40 hover:bg-muted"
                              : "text-foreground hover:ring-1 hover:ring-primary"
                        }`}
                        style={
                          !away && n > 0
                            ? {
                                background: `color-mix(in srgb, ${techColors.get(s.id) ?? "#888"} ${Math.round((n / peak) * 55) + 12}%, transparent)`,
                              }
                            : undefined
                        }
                      >
                        {away ? (n > 0 ? `!${n}` : "—") : n || ""}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {unassigned && (
            <tr className="border-t bg-muted/30">
              <td className="sticky left-0 z-10 bg-muted/30 px-3 py-1 font-medium">Unassigned</td>
              {days.map((d) => {
                const n = unassigned.get(d) ?? 0;
                return (
                  <td key={d} className="p-0.5">
                    <button
                      onClick={() => onPickDay(d)}
                      title={`${n} unassigned on ${d}`}
                      className={`flex w-full items-center justify-center rounded ${cell} ${
                        n > 0
                          ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                          : "text-muted-foreground/40 hover:bg-muted"
                      }`}
                    >
                      {n || ""}
                    </button>
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>
      <div className="border-t px-3 py-1.5 text-2xs text-muted-foreground">
        Click any day to open its board. <span className="text-amber-700">Amber</span> is time
        off. <strong>!3</strong> means three visits are still assigned to someone who is away.
      </div>
    </div>
  );
}
