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
//
// ── WHAT THE WEEK LOOKS LIKE NOW, AND WHY ─────────────────────────────────
//
// "When going to the week view, it should somewhat look how Jobber is laid
// out, utilizing the icons assigned per names. I also feel I am still not
// receiving the fullness to the windows that Jobber provides."
//
// Three separate complaints, and they had three separate causes:
//
//   WHO. The technician was an 8px dot. On a column of twenty chips that is
//   twenty specks, and the name behind the colour lived in a hover card, which
//   is a gesture a phone cannot make. It is now an initialled badge —
//   `TechAvatar` — in the same colour, so the badge answers "who" on its own
//   and the colour still answers "same route as that one".
//
//   FULLNESS. A day cell was `min-h-[7rem]` and showed four chips before
//   collapsing into "+3 more". A week with twenty visits a day therefore
//   displayed 28 of 140 and left most of the card empty. The week's columns
//   are now a fixed height and scroll INSIDE themselves, so a column shows as
//   many visits as it has room for, every column is the same height whatever
//   its volume, and the page does not grow — which is the same rule that keeps
//   the month's cells uniform, applied to a range that has the room to use it.
//
//   WIDTH. Seven columns inside the 3fr half of the map split come to about
//   74px each on a 1024px laptop, which is a client name of three characters.
//   The week grid keeps a floor on its own width and scrolls sideways INSIDE
//   its container when it cannot have it — never the page body, which is the
//   first rule in CLAUDE.md.
//
// The month is deliberately untouched by all of this. Its cells are small
// because thirty of them have to fit; there is no fullness to be had there,
// and a scrolling month cell would be a 34px-wide scroll container.

import { Fragment, useState } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { TechAvatar } from "@/components/schedule/TechAvatar";
import { orgLocalMinutes } from "@/lib/org-day";
import { useOrgTimezone } from "@/hooks/useOrgToday";
import { servicesVary, type VisitServiceRef } from "@/lib/visit-service";
import { formatWeekdaySet } from "@/lib/weekday-set";
import { useIntlLocale } from "@/lib/i18n";
import { visitStayDates, type VisitStayRef } from "@/lib/stays";

export type CalendarVisit = {
  id: string;
  scheduled_on: string;
  status: string;
  sequence: number | null;
  assigned_staff_id: string | null;
  clients?: { display_name?: string | null } | null;
  properties?: {
    street?: string | null;
    city?: string | null;
    earliest_service_time?: string | null;
    latest_service_time?: string | null;
  } | null;
  staff?: { display_name?: string | null } | null;
  zones?: { name?: string | null } | null;
  subscriptions?: {
    earliest_time?: string | null;
    latest_time?: string | null;
    /** The cadence, which the hover card shows beside the service name. */
    account_type?: string | null;
    frequency?: string | null;
    /** A set-days plan's days (0 = Sunday), migration 20261010010000. */
    weekdays?: number[] | null;
    /** A sitter's stay this visit belongs to (#411). */
    stay_id?: string | null;
    stays?: VisitStayRef;
  } | null;
  /** What the visit is (services, phase 2). */
  service_id?: string | null;
  services?: VisitServiceRef;
  eta_start?: string | null;
};

/** What kind of work this visit is.
 *
 *  Owner QA, 2026-08-19, asked for the week view to read like Jobber's, whose
 *  chip carries the SERVICE on its second line. Until the service catalog
 *  (2026-10-09) there was no service to carry, so this was the plan's cadence
 *  and account type. Now a visit has a service, and the hover card names it
 *  beside the cadence.
 *
 *  Where it goes is still decided by whether it VARIES. A business that sells
 *  one service would read the same words on every chip and learn nothing, so
 *  the chip's second line carries the service name only when the visits on
 *  screen are not all one service (servicesVary). Cadence is a property of the
 *  customer, not of the day, so it stays in the hover card, except a ONE-TIME
 *  job sitting in a week of recurring ones: that earns the chip's second line. */
const FREQUENCY_LABEL: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Bi-weekly",
  twice_weekly: "Twice weekly",
  monthly: "Monthly",
  one_time: "One-time",
};

const cadenceLabel = (v: CalendarVisit, locale?: string) => {
  const freq = v.subscriptions?.frequency;
  if (!freq) return null;
  // A set-days plan is stored as weekly; its days are the cadence.
  const days = v.subscriptions?.weekdays;
  const cadence = days?.length ? formatWeekdaySet(days, locale) : (FREQUENCY_LABEL[freq] ?? freq);
  const kind = v.subscriptions?.account_type;
  return kind ? `${cadence} ${kind}` : cadence;
};

/** How many chips a day shows before collapsing into "+N more".
 *
 *  A busy month is ~600 visits; rendering all of them produces a page that
 *  scrolls for minutes and a day cell whose height depends on its own volume,
 *  so the grid stops being a grid. Four is what fits a month cell without the
 *  row growing.
 *
 *  It is also what a WEEK shows on a phone, where the seven columns have
 *  reflowed into seven stacked rows and "all of it" would be a hundred and
 *  forty chips between Monday and Sunday. Above `md` the week ignores this
 *  entirely: the column scrolls, so there is nothing to collapse. */
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

/** Mon…Sun in the viewer's locale, for the month grid's column header.
 *
 *  1 Jan 2024 was a Monday, which is where the grid's week starts — see the
 *  `(getDay() + 6) % 7` in `calendarWindow`. Deriving the labels from a known
 *  Monday rather than from `days` matters because a month's first cell is the
 *  1st, which is any weekday at all. */
const WEEKDAY_LABELS = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }),
);

function statusTone(status: string) {
  if (status === "completed") return "line-through opacity-60";
  if (status === "skipped") return "line-through opacity-50 italic";
  return "";
}

function prettyStatus(status: string) {
  if (status === "in_progress") return "In progress";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Minutes past midnight this visit is expected to start, or null if nothing
 *  in the row says.
 *
 *  Precedence matches the board's own: a computed ETA if the route was
 *  optimized, otherwise the subscription's window, otherwise the property's.
 *  Null is not "midnight" — it is the whole point of the Anytime group below,
 *  and sorting it as 0 would put every un-timed visit at the top of the day. */
function startMinutes(v: CalendarVisit, tz: string): number | null {
  if (v.eta_start) {
    // On the ORG's clock, not the device's — this is the sort key and the
    // row bucket for the whole grid, so a device in another timezone used to
    // move visits between rows, not just mislabel them. The window fallback
    // below is a `time` column (wall clock, no zone) and needs no conversion.
    const mins = orgLocalMinutes(v.eta_start, tz);
    if (mins != null) return mins;
  }
  const raw = v.subscriptions?.earliest_time ?? v.properties?.earliest_service_time ?? null;
  const m = raw ? /^(\d{1,2}):(\d{2})/.exec(raw) : null;
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** "9:15a" — short enough to sit in front of a street name in a 96px column. */
function clock(mins: number) {
  const h24 = Math.floor(mins / 60) % 24;
  const h = h24 % 12 || 12;
  return `${h}:${String(mins % 60).padStart(2, "0")}${h24 < 12 ? "a" : "p"}`;
}

function VisitChip({
  visit,
  color,
  onOpen,
  hovered,
  onHover,
  hiddenOnPhone = false,
  showService = false,
}: {
  visit: CalendarVisit;
  color: string | undefined;
  onOpen: (id: string) => void;
  /** The MAP is pointing at this one. */
  hovered?: boolean;
  onHover?: (id: string | null) => void;
  /** Past the phone's cut-off in a week column that has not been expanded.
   *  Rendered either way, because at `md` the column scrolls and there is no
   *  cut-off to be past. */
  hiddenOnPhone?: boolean;
  /** The visits on screen are not all one service, so the chip names it. */
  showService?: boolean;
}) {
  const tz = useOrgTimezone();
  const locale = useIntlLocale();
  const name = visit.clients?.display_name ?? "Unnamed client";
  const who = visit.staff?.display_name ?? null;
  const street = visit.properties?.street ?? null;
  const city = visit.properties?.city ?? null;
  const mins = startMinutes(visit, tz);
  // One line under the name, in the order a dispatcher reads it: when, then
  // where. Both are optional and either alone is worth a line; neither leaves
  // the chip a single line tall, which is what a day with no routing looks
  // like before it is optimized.
  const serviceName = visit.services?.name ?? null;
  const cadence = cadenceLabel(visit, locale);
  // "One-time" only. See cadenceLabel(): the cadence is constant per customer,
  // so putting it on every chip would cost a 96px column its street name to
  // repeat what the client list already says. The service name likewise, only
  // when it varies.
  const oneTime = visit.subscriptions?.frequency === "one_time" ? "One-time" : null;
  // A stay visit runs every day of the stay, so its plan's cadence ("Every
  // day") says nothing; the stay's dates do (#411).
  const stayDates = visitStayDates(visit.subscriptions?.stays);
  const second = [
    mins == null ? null : clock(mins),
    showService ? serviceName : null,
    stayDates ? "Stay" : oneTime,
    street,
  ]
    .filter(Boolean)
    .join(" · ");
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
          // `touch:min-h-11` is the repo's 44px idiom (see ui/button.tsx): a
          // chip is dense at a pointer's width and a real target at a thumb's.
          className={`w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-2xs transition hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary touch:min-h-11 ${
            hiddenOnPhone ? "hidden md:flex" : "flex"
          } ${hovered ? "bg-primary/15 ring-1 ring-primary/50" : ""}`}
        >
          {/* Was an 8px dot. Unassigned still has no tech and therefore no tech
              colour — an outlined badge rather than a grey one, because grey is
              a colour and on a board where colour means "whose route" a grey
              badge reads as a tenth technician. */}
          <TechAvatar name={who} color={color} />
          {/* The wrapper is the flex item, and it is the one that has to be
              allowed to shrink: `truncate` on the lines inside it does nothing
              until something above them has a narrow box to be narrow in. */}
          <span className="min-w-0 flex-1">
            <span className={`block truncate ${statusTone(visit.status)}`}>{name}</span>
            {second && (
              <span className="block truncate text-3xs text-muted-foreground">{second}</span>
            )}
          </span>
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
          {(serviceName || cadence) && (
            <>
              <dt className="text-muted-foreground">Service</dt>
              <dd>
                {serviceName && <bdi>{serviceName}</bdi>}
                {stayDates ? (
                  <>
                    {serviceName ? " · " : null}Stay, {stayDates}
                  </>
                ) : (
                  <>
                    {serviceName && cadence ? " · " : null}
                    {cadence}
                  </>
                )}
              </dd>
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
  onPickUnassigned,
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
  /** "N unassigned" under a day: open that day's unassigned visits. Falls
   *  back to opening the day when the page has no separate handler. */
  onPickUnassigned?: (d: string) => void;
  onOpenVisit: (visitId: string) => void;
}) {
  const tz = useOrgTimezone();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const showService = servicesVary(visits);
  const { days, leadingBlanks } = calendarWindow(day, range);

  const byDay = new Map<string, CalendarVisit[]>();
  for (const v of visits) {
    if (!byDay.has(v.scheduled_on)) byDay.set(v.scheduled_on, []);
    byDay.get(v.scheduled_on)!.push(v);
  }
  // Timed work first, in clock order, then everything with no time on it in
  // route order. Sorting by `sequence` alone — which is what this did — put an
  // 8am stop below an un-routed visit whose sequence happened to be lower, and
  // a column of chips that is not in time order cannot be read down.
  for (const list of byDay.values()) {
    list.sort((a, b) => {
      const am = startMinutes(a, tz);
      const bm = startMinutes(b, tz);
      if (am !== bm) return (am ?? 1e6) - (bm ?? 1e6);
      return (a.sequence ?? 9999) - (b.sequence ?? 9999);
    });
  }

  const isWeekend = (d: string) => {
    const dow = new Date(`${d}T00:00:00`).getDay();
    return dow === 0 || dow === 6;
  };
  const cols = hideWeekends ? 5 : 7;
  const isMonth = range === "month";
  const monthBlanks = isMonth ? Math.min(leadingBlanks, cols - 1) : 0;
  const visibleDays = hideWeekends ? days.filter((d) => !isWeekend(d)) : days;
  const todayIso = iso(new Date());

  // ── The two ranges need different answers on a phone ──────────────────────
  //
  // This grid was `grid-cols-7` at every width. At 360px that is seven columns
  // of about 45px each, holding a weekday, a date and chips with client names
  // in them — legible on a laptop and unusable in a driveway. Shrinking a dense
  // grid does not make it work; below the breakpoint it needs a different
  // shape.
  //
  // A WEEK becomes one column: seven full-width day rows, each with its visits
  // underneath, which is the same information at a size a thumb can use.
  //
  // A MONTH keeps its seven columns, because the shape of a month IS the
  // information — which week a date falls in, where the gaps are — and thirty
  // stacked rows would destroy that while adding a very long scroll. What
  // changes is density: on a phone a month cell shows the date and how many
  // visits, and tapping it opens that day. Chips are only hidden where the day
  // itself is one tap away.
  //
  // The month cell's own arithmetic, because it is what decides whether the
  // page scrolls sideways: at 320px, seven columns leave roughly 34px each and
  // about 22px of that is inside the padding. "MON 31 12" on one line needs
  // more than twice that, so the weekday moved OUT of the cell into a column
  // header the whole grid shares, and the count stacks under the date until
  // there is room for it alongside. What is left in a cell is a two-digit
  // number, which fits with room to spare.
  const gridCls = isMonth
    ? cols === 5
      ? "grid-cols-5"
      : "grid-cols-7"
    : cols === 5
      ? "grid-cols-1 md:grid-cols-5"
      : "grid-cols-1 md:grid-cols-7";

  // A floor on the week grid's width, and the container that pays for it.
  //
  // Seven columns of the map split at 1024px are 74px each; five are 104px. A
  // column narrower than about 96px cannot hold a badge and a name, and the
  // answer is NOT to let the page get wider — that is the rule this repo
  // enforces in a browser. So the grid keeps its floor and the container
  // scrolls, which is the same trade `ui/table.tsx` makes. Below `md` there is
  // one column and no floor to enforce, hence the `md:` on both halves.
  //
  // 42rem is seven times 96px, and it is that rather than anything rounder so
  // that a 768px tablet — where the map is stacked and the calendar has the
  // whole width — clears it with room and gets no scrollbar at all. The scroll
  // is for the case that actually needs it: the map docked beside the calendar
  // from `lg` up.
  //
  // The negative margin is for the 1px ring on today's column: without it the
  // ring on Monday sits exactly on the scroll container's edge and is clipped,
  // which reads as a missing border rather than as a highlight.
  const weekScroll = isMonth ? "" : "md:-mx-0.5 md:overflow-x-auto md:px-0.5 md:pb-1";
  const weekFloor = isMonth ? "" : cols === 5 ? "md:min-w-[30rem]" : "md:min-w-[42rem]";

  return (
    <div className="rounded-lg border bg-card p-2 sm:p-4">
      {/* Only a month gets a column header. A week is one column below `md`,
          where seven labels over one column would be a lie. */}
      {isMonth && (
        <div
          className={`mb-1.5 grid gap-1.5 px-1 sm:gap-2 ${cols === 5 ? "grid-cols-5" : "grid-cols-7"}`}
          aria-hidden
        >
          {(hideWeekends ? WEEKDAY_LABELS.slice(0, 5) : WEEKDAY_LABELS).map((label) => (
            <span
              key={label}
              className="truncate text-center text-3xs uppercase text-muted-foreground"
            >
              {label}
            </span>
          ))}
        </div>
      )}
      <div className={weekScroll}>
        <div className={`grid gap-1.5 sm:gap-2 ${gridCls} ${weekFloor}`}>
          {Array.from({ length: monthBlanks }).map((_, i) => (
            <div key={`blank-${i}`} />
          ))}
          {visibleDays.map((d) => {
            const list = byDay.get(d) ?? [];
            const dt = new Date(`${d}T00:00:00`);
            const isOpen = expanded.has(d);
            // The month collapses in JS, because its cells are hidden below
            // `md` anyway and a hidden chip there costs a render for nothing.
            // The week collapses in CSS: the same chips are on the page at
            // every width, and only the phone's copy of the column is cut off,
            // because at `md` the column scrolls and nothing is cut off at all.
            const rendered = isMonth && !isOpen ? list.slice(0, CHIPS_PER_DAY) : list;
            const phoneCut = isOpen ? list.length : CHIPS_PER_DAY;
            const unassigned = list.filter((v) => !v.assigned_staff_id).length;
            // Where the timed work stops and "sometime today" begins. Only
            // drawn when the day has both, because a heading over all of it or
            // none of it says nothing.
            const firstUntimed = list.findIndex((v) => startMinutes(v, tz) == null);
            const showAnytime = !isMonth && firstUntimed > 0;
            const isToday = d === todayIso;
            return (
              <div
                key={d}
                className={`flex flex-col rounded-md border p-1.5 text-xs ${
                  isMonth ? "min-h-[3.5rem] md:min-h-[7rem]" : "md:h-[30rem] xl:h-[36rem]"
                } ${isToday ? "border-primary ring-1 ring-primary" : ""} ${
                  d === day ? "bg-muted/40" : ""
                }`}
              >
                {/* The date is the control that opens the day. The chips are their
                    own controls, so the whole cell is deliberately NOT a button —
                    nesting one inside another is invalid and swallows the chip's
                    own click. */}
                <button
                  onClick={() => onPickDay(d)}
                  className={`mb-1 flex w-full rounded px-1 text-left transition hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary ${
                    isToday ? "bg-primary/10 text-primary" : ""
                  } ${
                    isMonth
                      ? "min-h-[2.75rem] flex-1 flex-col items-center justify-center gap-0 md:mouse:min-h-0 md:flex-none md:flex-row md:items-baseline md:gap-1.5"
                      : "min-h-[2.75rem] items-center gap-1.5 md:mouse:min-h-0 md:flex-col md:items-start md:gap-0 md:border-b md:pb-1"
                  }`}
                  title={`Open ${dt.toLocaleDateString()} on the board`}
                >
                  <span className="flex items-baseline gap-1.5">
                    {/* A month's weekday lives in the column header above; repeating
                        it in all thirty cells is what made them too wide to fit. */}
                    {!isMonth && (
                      <span className="text-3xs uppercase text-muted-foreground">
                        {dt.toLocaleDateString(undefined, { weekday: "short" })}
                      </span>
                    )}
                    <span className="font-medium">{dt.getDate()}</span>
                  </span>
                  {list.length > 0 && (
                    <span
                      className={`shrink-0 text-3xs text-muted-foreground ${
                        isMonth ? "md:ml-auto" : "ml-auto md:ml-0"
                      }`}
                    >
                      {isMonth
                        ? list.length
                        : `${list.length} visit${list.length === 1 ? "" : "s"}`}
                    </span>
                  )}
                </button>

                {/* The week's column is the scroller. `md:min-h-0` is what lets
                    it be one: a flex child's minimum is its content, so without
                    it the column grows to fit twenty chips and takes the page
                    with it, and `overflow-y-auto` never has anything to do. */}
                <div
                  className={`flex-col gap-0.5 ${isMonth ? "hidden md:flex" : "flex"} ${
                    isMonth ? "" : "md:min-h-0 md:flex-1 md:overflow-y-auto"
                  }`}
                >
                  {rendered.map((v, i) => (
                    <Fragment key={v.id}>
                      {showAnytime && i === firstUntimed && (
                        <span
                          className={`mt-1 px-1 text-3xs uppercase text-muted-foreground ${
                            i >= phoneCut ? "hidden md:block" : "block"
                          }`}
                        >
                          Anytime
                        </span>
                      )}
                      <VisitChip
                        visit={v}
                        color={
                          v.assigned_staff_id ? techColors.get(v.assigned_staff_id) : undefined
                        }
                        onOpen={onOpenVisit}
                        hovered={hoveredVisitId === v.id}
                        onHover={onHoverVisit}
                        hiddenOnPhone={!isMonth && i >= phoneCut}
                        showService={showService}
                      />
                    </Fragment>
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
                    className={`mt-0.5 px-1 text-left text-3xs text-muted-foreground hover:text-foreground touch:min-h-11 ${
                      isMonth ? "hidden md:block" : "md:hidden"
                    }`}
                  >
                    {isOpen ? "Show less" : `+${list.length - CHIPS_PER_DAY} more`}
                  </button>
                )}

                {/* A button, not a label: it said "2 unassigned" and did
                    nothing when tapped (QA #439). It opens that day with its
                    unassigned visits in front. */}
                {unassigned > 0 && (
                  <button
                    type="button"
                    onClick={() => (onPickUnassigned ?? onPickDay)(d)}
                    data-unassigned-link={d}
                    className={`mt-auto px-1 pt-1 text-left text-3xs text-amber-700 underline-offset-2 hover:underline touch:min-h-11 ${
                      isMonth ? "hidden md:block" : ""
                    }`}
                  >
                    {unassigned} unassigned
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {/* This used to read "Hover a visit for who and where". Hover does not
          exist on a touchscreen, so on the device where this board is most
          used the sentence described a gesture the reader could not make — and
          the hover card it pointed at is a shortcut, not the only way in.
          Tapping a chip opens the visit, which is where all of it lives. */}
      <p className="mt-3 text-2xs text-muted-foreground">
        Colors match the map: each technician keeps the same color in both, and the badge on a
        visit is their initials. Open a visit for who and where, or the date for that day&apos;s
        board.
        {isMonth && (
          <span className="md:hidden">
            {" "}
            A month shows each day&apos;s visit count; open the day to see who is on it.
          </span>
        )}
      </p>
    </div>
  );
}
