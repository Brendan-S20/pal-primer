// The week/month calendar on /routes.
//
// ── WHAT IT REPLACES ──────────────────────────────────────────────────────
//
// `WeekOverview` rendered one cell per day containing a COUNT — "12 visits ·
// 3 unassigned" — shaded by how busy the day was, with the detail in a native
// `title` tooltip. You could see that Tuesday was heavy. You could not see a
// single customer's name, or who was running any of it, without clicking into
// the day and losing the week.
//
// It also ran its own `getVisitRangeSummary` query while the page had already
// fetched every visit in the window for the map. Two queries over the same
// rows, which is the shape that lets a total disagree with the thing it totals.
// The counts here are `length` on the array being rendered, so they cannot.
//
// ── WHY CHIPS ARE COLOURED BY TECH ────────────────────────────────────────
//
// The colour comes from `techColorMap`, which delegates to the same
// `buildTechGroups` the map uses. A chip and that visit's pin are therefore
// always the same colour, and "who is doing this route" is answerable by
// glancing between the two panes rather than by reading either.

import { useState } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

export type CalendarVisit = {
  id: string;
  scheduled_on: string;
  status: string;
  sequence: number | null;
  assigned_staff_id: string | null;
  clients?: { display_name?: string | null } | null;
  properties?: { street?: string | null; city?: string | null } | null;
  staff?: { display_name?: string | null } | null;
  zones?: { name?: string | null } | null;
  eta_start?: string | null;
};

/** How many chips a day shows before collapsing into "+N more".
 *
 *  A busy month is ~600 visits; rendering all of them produces a page that
 *  scrolls for minutes and a day cell whose height depends on its own volume,
 *  so the grid stops being a grid. Four is what fits a month cell without the
 *  row growing. */
const CHIPS_PER_DAY = 4;

function iso(d: Date) {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

/** The days the grid shows, and how many leading blanks the month needs.
 *
 *  Exported because the PAGE has to fetch exactly this window. The old code
 *  computed the fetch window as "selected day + 6 / + 29" while the grid drew
 *  from the Monday of that week or the 1st of that month — so with a day
 *  mid-week or mid-month the earlier cells were outside the query and rendered
 *  as empty days that were not empty. With counts that read as a quiet Monday;
 *  with chips it would read as a Monday nobody is working. */
export function calendarWindow(day: string, range: "week" | "month") {
  const base = new Date(`${day}T00:00:00`);
  const days: string[] = [];
  let leadingBlanks = 0;
  if (range === "month") {
    const first = new Date(base.getFullYear(), base.getMonth(), 1);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    leadingBlanks = (first.getDay() + 6) % 7; // 0 = Monday
    for (let i = 1; i <= last.getDate(); i++) {
      days.push(iso(new Date(base.getFullYear(), base.getMonth(), i)));
    }
  } else {
    const dow = (base.getDay() + 6) % 7;
    const start = new Date(base);
    start.setDate(base.getDate() - dow);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(iso(d));
    }
  }
  return { days, leadingBlanks, from: days[0], to: days[days.length - 1] };
}

function statusTone(status: string) {
  if (status === "completed") return "line-through opacity-60";
  if (status === "skipped") return "line-through opacity-50 italic";
  return "";
}

function prettyStatus(status: string) {
  if (status === "in_progress") return "In progress";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function VisitChip({
  visit,
  color,
  onOpen,
  hovered,
  onHover,
}: {
  visit: CalendarVisit;
  color: string | undefined;
  onOpen: (id: string) => void;
  /** The MAP is pointing at this one. */
  hovered?: boolean;
  onHover?: (id: string | null) => void;
}) {
  const name = visit.clients?.display_name ?? "Unnamed customer";
  const who = visit.staff?.display_name ?? null;
  const street = visit.properties?.street ?? null;
  const city = visit.properties?.city ?? null;
  const dayLabel = new Date(`${visit.scheduled_on}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  return (
    <HoverCard openDelay={120} closeDelay={60}>
      <HoverCardTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen(visit.id);
          }}
          onMouseEnter={() => onHover?.(visit.id)}
          onMouseLeave={() => onHover?.(null)}
          onFocus={() => onHover?.(visit.id)}
          onBlur={() => onHover?.(null)}
          className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] transition hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary ${
            hovered ? "bg-primary/15 ring-1 ring-primary/50" : ""
          }`}
        >
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            // Unassigned has no tech and therefore no tech colour. A hollow
            // marker rather than a grey dot: grey is a colour, and on a board
            // where colour means "whose route", a grey dot reads as a tenth
            // technician.
            style={color ? { background: color } : { boxShadow: "inset 0 0 0 1px currentColor" }}
          />
          <span className={`truncate ${statusTone(visit.status)}`}>{name}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 text-xs" side="top" align="start">
        <div className="font-medium text-sm">{name}</div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">When</dt>
          <dd>{dayLabel}</dd>
          <dt className="text-muted-foreground">Who</dt>
          <dd>
            {who ?? <span className="text-amber-700">Nobody assigned yet</span>}
            {visit.sequence != null && who ? (
              <span className="text-muted-foreground"> · stop #{visit.sequence}</span>
            ) : null}
          </dd>
          {(street || city) && (
            <>
              <dt className="text-muted-foreground">Where</dt>
              <dd>{[street, city].filter(Boolean).join(", ")}</dd>
            </>
          )}
          {visit.zones?.name && (
            <>
              <dt className="text-muted-foreground">Zone</dt>
              <dd>{visit.zones.name}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Status</dt>
          <dd>{prettyStatus(visit.status)}</dd>
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}

export function ScheduleCalendar({
  day,
  range,
  visits,
  techColors,
  hoveredVisitId,
  onHoverVisit,
  hideWeekends = false,
  onPickDay,
  onOpenVisit,
}: {
  day: string;
  range: "week" | "month";
  visits: CalendarVisit[];
  /** staffId → colour, from RouteMap's `techColorMap`. */
  techColors: Map<string, string>;
  /** Kept in step with the map: hovering a chip lights its pin and hovering a
   *  pin lights the chip. Two panes over the same visits are only useful if
   *  they can point at the same one. */
  hoveredVisitId?: string | null;
  onHoverVisit?: (id: string | null) => void;
  hideWeekends?: boolean;
  onPickDay: (d: string) => void;
  onOpenVisit: (visitId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { days, leadingBlanks } = calendarWindow(day, range);

  const byDay = new Map<string, CalendarVisit[]>();
  for (const v of visits) {
    if (!byDay.has(v.scheduled_on)) byDay.set(v.scheduled_on, []);
    byDay.get(v.scheduled_on)!.push(v);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => (a.sequence ?? 9999) - (b.sequence ?? 9999));
  }

  const isWeekend = (d: string) => {
    const dow = new Date(`${d}T00:00:00`).getDay();
    return dow === 0 || dow === 6;
  };
  const cols = hideWeekends ? 5 : 7;
  const monthBlanks = range === "month" ? Math.min(leadingBlanks, cols - 1) : 0;
  const visibleDays = hideWeekends ? days.filter((d) => !isWeekend(d)) : days;
  const todayIso = iso(new Date());

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className={`grid gap-2 ${cols === 5 ? "grid-cols-5" : "grid-cols-7"}`}>
        {Array.from({ length: monthBlanks }).map((_, i) => (
          <div key={`blank-${i}`} />
        ))}
        {visibleDays.map((d) => {
          const list = byDay.get(d) ?? [];
          const dt = new Date(`${d}T00:00:00`);
          const isOpen = expanded.has(d);
          const shown = isOpen ? list : list.slice(0, CHIPS_PER_DAY);
          const unassigned = list.filter((v) => !v.assigned_staff_id).length;
          return (
            <div
              key={d}
              className={`flex min-h-[7rem] flex-col rounded-md border p-1.5 text-xs ${
                d === todayIso ? "ring-1 ring-primary" : ""
              } ${d === day ? "bg-muted/40" : ""}`}
            >
              {/* The date is the control that opens the day. The chips are their
                  own controls, so the whole cell is deliberately NOT a button —
                  nesting one inside another is invalid and swallows the chip's
                  own click. */}
              <button
                onClick={() => onPickDay(d)}
                className="mb-1 flex items-baseline gap-1.5 rounded px-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                title={`Open ${dt.toLocaleDateString()} on the board`}
              >
                <span className="text-[10px] uppercase text-muted-foreground">
                  {dt.toLocaleDateString(undefined, { weekday: "short" })}
                </span>
                <span className="font-medium">{dt.getDate()}</span>
                {list.length > 0 && (
                  <span className="ml-auto text-[10px] text-muted-foreground">{list.length}</span>
                )}
              </button>

              <div className="flex flex-col gap-0.5">
                {shown.map((v) => (
                  <VisitChip
                    key={v.id}
                    visit={v}
                    color={v.assigned_staff_id ? techColors.get(v.assigned_staff_id) : undefined}
                    onOpen={onOpenVisit}
                    hovered={hoveredVisitId === v.id}
                    onHover={onHoverVisit}
                  />
                ))}
              </div>

              {list.length > CHIPS_PER_DAY && (
                <button
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(d)) next.delete(d);
                      else next.add(d);
                      return next;
                    })
                  }
                  className="mt-0.5 px-1 text-left text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {isOpen ? "Show less" : `+${list.length - CHIPS_PER_DAY} more`}
                </button>
              )}

              {unassigned > 0 && (
                <span className="mt-auto px-1 pt-1 text-[10px] text-amber-700">
                  {unassigned} unassigned
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Colours match the map — each technician keeps the same colour in both. Hover a visit for
        who and where; click the date to open that day&apos;s board.
      </p>
    </div>
  );
}
