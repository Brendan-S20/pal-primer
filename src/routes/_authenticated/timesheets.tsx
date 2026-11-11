// Timesheets: the office's week of the time clock.
//
// One row per person, one column per day of the org's Monday-to-Sunday week,
// with hours, overtime past forty, and the visits each person completed that
// day beside the hours they were paid for them. Tapping a day opens its shifts
// so a forgotten clock-out can be fixed; "Add time" covers a day nobody
// clocked at all; "Export CSV" is the payroll input.
//
// Two shapes, not one scaled. Nine columns of numbers is a desk layout; from
// `lg` down it is one card per person with the week as a list, because a
// seven-column grid on a phone is seven columns nobody can read or tap.
//
// Every time on this page is on the ORGANIZATION's clock (the day a shift
// belongs to, the times printed, the times typed into the form), because the
// office reading it may be anywhere and payroll is kept on the business's day.

import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Download, Plus, Timer, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  addTimeEntry,
  editTimeEntry,
  listTimesheet,
} from "@/lib/time-clock.functions";
import {
  addDays,
  buildTimesheet,
  formatDuration,
  mondayOf,
  orgTimeInputValue,
  orgWallTimeToInstant,
  possibleMissedClockOut,
  shiftMinutes,
  timesheetCsvRows,
  TIMESHEET_CSV_HEADERS,
  type ClockEntry,
  type TimesheetDay,
  type TimesheetRow,
} from "@/lib/time-clock";
import { formatDay } from "@/lib/format";
import { orgLocalTime } from "@/lib/org-day";
import { useOrgToday } from "@/hooks/useOrgToday";
import { downloadCsv } from "@/lib/csv";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/timesheets")({
  head: () => titleHead("Timesheets"),
  validateSearch: (search: Record<string, unknown>): { week?: string } => {
    const w = typeof search.week === "string" ? search.week : undefined;
    return w && /^\d{4}-\d{2}-\d{2}$/.test(w) && !Number.isNaN(Date.parse(w)) ? { week: w } : {};
  },
  component: TimesheetsPage,
});

const TIMESHEET_KEY = "timesheet";

/** "Sep 21 – 27" / "Sep 28 – Oct 4". Built from formatDay so the one spelling
 *  of a date in this product is the one used here. */
function weekLabel(monday: string): string {
  const a = formatDay(monday).replace(/^[A-Za-z]+, /, "");
  const b = formatDay(addDays(monday, 6)).replace(/^[A-Za-z]+, /, "");
  const [am] = a.split(" ");
  const [bm, ...rest] = b.split(" ");
  return am === bm ? `${a} – ${rest.join(" ")}` : `${a} – ${b}`;
}

type Editing =
  | { mode: "edit"; entry: ClockEntry; name: string }
  | { mode: "add"; staffId: string | null; day: string };

function TimesheetsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const orgToday = useOrgToday();
  const weekStart = mondayOf(search.week ?? orgToday);
  const thisWeek = mondayOf(orgToday);

  const fetchSheet = useServerFn(listTimesheet);
  const { data, isLoading, error } = useQuery({
    queryKey: [TIMESHEET_KEY, weekStart],
    queryFn: () => fetchSheet({ data: { weekOf: weekStart } }),
  });

  // Open shifts count up to now, so the page repaints while it is open.
  const [, repaint] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => repaint((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const tz = data?.timezone ?? "America/Chicago";
  const sheet = data
    ? buildTimesheet({
        weekStart: data.weekStart,
        tz,
        now: Date.now(),
        staff: data.staff,
        entries: data.entries,
        visits: data.visits,
        tips: data.tips,
        scheduled: data.scheduled,
      })
    : null;
  const entriesById = useMemo(
    () => new Map((data?.entries ?? []).map((e) => [e.id, e])),
    [data?.entries],
  );

  const [dayOpen, setDayOpen] = useState<{ staffId: string; day: string } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const goWeek = (monday: string) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        week: monday === thisWeek ? undefined : monday,
      }),
      replace: true,
    } as any);

  const openRow = dayOpen && sheet?.rows.find((r) => r.staff.id === dayOpen.staffId);
  const openDay = openRow && openRow.days.find((d) => d.day === dayOpen!.day);

  const onTheClock = sheet?.rows.filter((r) => r.onTheClock).length ?? 0;
  const visits = sheet?.rows.reduce((n, r) => n + r.visitsCompleted, 0) ?? 0;
  const missed = sheet?.rows.reduce((n, r) => n + r.possibleMissedClockOuts, 0) ?? 0;

  const exportCsv = () => {
    if (!sheet) return;
    downloadCsv(
      `timesheet-${sheet.weekStart}.csv`,
      [...TIMESHEET_CSV_HEADERS],
      timesheetCsvRows(sheet, tz),
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">Timesheets</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Hours from the time clock, by day, with the visits each person completed. A completed
            visit counts on the day it was completed, the day its hours were worked; "scheduled"
            is every visit on their route this week, the number My Day counts against. Tap a day
            to fix a forgotten clock-out.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setEditing({ mode: "add", staffId: null, day: orgToday })}
          >
            <Plus className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" /> Add time
          </Button>
          <Button type="button" variant="outline" onClick={exportCsv} disabled={!sheet}>
            <Download className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" /> Export CSV
          </Button>
        </div>
      </div>

      {/* The week picker. Arrows, the week itself, and a date field for
          jumping further than a week or two -- any day picks its week. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Previous week"
            onClick={() => goWeek(addDays(weekStart, -7))}
          >
            <ChevronLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
          </Button>
          <div className="min-w-[9.5rem] px-2 text-center text-sm font-medium tabular-nums">
            {weekLabel(weekStart)}
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Next week"
            disabled={weekStart >= thisWeek}
            onClick={() => goWeek(addDays(weekStart, 7))}
          >
            <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          </Button>
        </div>
        {weekStart !== thisWeek && (
          <Button type="button" variant="ghost" onClick={() => goWeek(thisWeek)}>
            This week
          </Button>
        )}
        <Input
          type="date"
          aria-label="Jump to the week of"
          value={weekStart}
          max={orgToday}
          onChange={(e) => {
            const v = e.target.value;
            if (/^\d{4}-\d{2}-\d{2}$/.test(v)) goWeek(mondayOf(v));
          }}
          className="w-auto"
        />
      </div>

      {isLoading && <Card className="p-6 text-sm text-muted-foreground">Loading the week…</Card>}
      {error && (
        <Card className="border-destructive/40 p-6 text-sm">
          The timesheet could not be loaded: {(error as Error).message}
        </Card>
      )}

      {sheet && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Hours this week" value={formatDuration(sheet.totalMinutes)} />
            <Stat
              label="Overtime"
              value={formatDuration(sheet.overtimeMinutes)}
              hint="past 40 hours a person"
              warn={sheet.overtimeMinutes > 0}
            />
            <Stat label="On the clock now" value={String(onTheClock)} />
            <Stat
              label="Visits completed"
              value={String(visits)}
              hint="on the day each was completed"
            />
            <Stat
              label="Tips"
              value={tipMoney(sheet.tipsCents)}
              hint="from the most recent visit on each tipped invoice"
            />
          </div>

          {/* A shift open 12 hours or more, or closed after more than 16, is
              usually a forgotten clock-out (QA row 22, #438). Flagged, never
              closed for them: the office decides what the real time was. */}
          {missed > 0 && (
            <Card
              role="status"
              className="flex items-start gap-2 border-amber-400/60 bg-amber-50/60 p-4 text-sm dark:border-amber-900/60 dark:bg-amber-950/30"
            >
              <TriangleAlert
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300"
                aria-hidden="true"
              />
              <span className="min-w-0">
                {missed === 1
                  ? "1 shift looks like a missed clock-out"
                  : `${missed} shifts look like a missed clock-out`}{" "}
                (open 12 hours or more, or longer than 16 hours). They are marked below. Tap the day
                to fix the time.
              </span>
            </Card>
          )}

          {sheet.rows.length === 0 ? (
            <Card className="p-6 text-sm text-muted-foreground">
              Nobody on the team runs routes yet, and nobody clocked in this week.
            </Card>
          ) : (
            <>
              {/* Below lg: one card per person, the week as a list. */}
              <div className="grid gap-3 md:grid-cols-2 lg:hidden">
                {sheet.rows.map((row) => (
                  <PersonCard
                    key={row.staff.id}
                    row={row}
                    tz={tz}
                    onDay={(day) => setDayOpen({ staffId: row.staff.id, day })}
                  />
                ))}
              </div>

              {/* From lg: the grid. */}
              <Card className="hidden lg:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[12rem]">Person</TableHead>
                      {sheet.days.map((d) => (
                        <TableHead key={d} className="text-center">
                          {formatDay(d).replace(/,.*$/, "")}
                          <span className="block text-xs font-normal text-muted-foreground">
                            {formatDay(d).replace(/^[A-Za-z]+, /, "")}
                          </span>
                        </TableHead>
                      ))}
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead
                        className="text-right"
                        title="Completed (by the day completed) and scheduled (on their route this week)"
                      >
                        Visits
                      </TableHead>
                      <TableHead className="text-right">Tips</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sheet.rows.map((row) => (
                      <TableRow key={row.staff.id}>
                        <TableCell className="max-w-[16rem]">
                          <div className="truncate font-medium" title={row.staff.display_name}>
                            {row.staff.display_name}
                          </div>
                          {row.onTheClock && (
                            <div className="text-xs text-emerald-700 dark:text-emerald-400">
                              On the clock
                            </div>
                          )}
                          {row.possibleMissedClockOuts > 0 && <MissedClockOutNote row={row} />}
                        </TableCell>
                        {row.days.map((d) => (
                          <TableCell key={d.day} className="p-1 text-center">
                            <DayCellButton
                              day={d}
                              onClick={() => setDayOpen({ staffId: row.staff.id, day: d.day })}
                              label={`${row.staff.display_name}, ${formatDay(d.day)}`}
                            />
                          </TableCell>
                        ))}
                        <TableCell className="text-right tabular-nums">
                          <TotalCell row={row} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">
                          <div>{row.visitsCompleted} done</div>
                          <div className="text-xs text-muted-foreground">
                            {row.visitsScheduled} scheduled
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.tipsCents > 0 ? tipMoney(row.tipsCents) : "–"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </>
          )}
        </>
      )}

      {/* A day's shifts. */}
      <Dialog open={!!openDay} onOpenChange={(o) => !o && setDayOpen(null)}>
        <DialogContent className="max-w-md">
          {openRow && openDay && (
            <>
              <DialogHeader>
                <DialogTitle className="break-words">{openRow.staff.display_name}</DialogTitle>
                <DialogDescription>
                  {formatDay(openDay.day)} · {formatDuration(openDay.minutes)} ·{" "}
                  {openDay.visitsCompleted} visit{openDay.visitsCompleted === 1 ? "" : "s"}{" "}
                  completed
                  {openDay.tipsCents > 0 ? ` · ${tipMoney(openDay.tipsCents)} in tips` : ""}
                </DialogDescription>
              </DialogHeader>
              {openDay.segments.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No time on the clock this day
                  {openDay.visitsCompleted > 0 ? ", though visits were completed" : ""}.
                </p>
              ) : (
                <ul className="space-y-2">
                  {openDay.segments.map((s) => {
                    const entry = entriesById.get(s.entryId);
                    return (
                      <li
                        key={`${s.entryId}-${s.day}`}
                        className="flex items-center gap-3 rounded-lg border p-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium tabular-nums">
                            {s.continuesFromPreviousDay ? "Midnight" : orgLocalTime(s.start, tz)}
                            {" – "}
                            {s.open && !s.continuesIntoNextDay
                              ? "still on the clock"
                              : s.continuesIntoNextDay
                                ? "midnight"
                                : orgLocalTime(s.end, tz)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatDuration(s.minutes)}
                            {s.continuesFromPreviousDay || s.continuesIntoNextDay
                              ? " · part of a shift across midnight"
                              : ""}
                            {entry?.edited_at ? " · corrected by the office" : ""}
                          </p>
                          {entry && possibleMissedClockOut(entry, Date.now()) && (
                            <p className="mt-1 text-xs font-medium text-amber-800 dark:text-amber-300">
                              Possible missed clock-out: this shift{" "}
                              {entry.clock_out ? "ran" : "has been open for"}{" "}
                              {formatDuration(shiftMinutes(entry, Date.now()))}.
                            </p>
                          )}
                          {entry?.note && (
                            <p className="mt-1 break-words text-xs text-muted-foreground">
                              {entry.note}
                            </p>
                          )}
                        </div>
                        {entry && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            onClick={() =>
                              setEditing({ mode: "edit", entry, name: openRow.staff.display_name })
                            }
                          >
                            {s.open ? "Clock out" : "Edit"}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setEditing({ mode: "add", staffId: openRow.staff.id, day: openDay.day })
                  }
                >
                  <Plus className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" /> Add time on this
                  day
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {editing && data && (
        <EntryDialog
          key={editing.mode === "edit" ? editing.entry.id : `add-${editing.staffId}-${editing.day}`}
          editing={editing}
          tz={tz}
          today={orgToday}
          people={data.pickable}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** "$12.50". The sheet's other figures are hours and counts, so this is its
 *  only money and gets its own formatter rather than the invoice one. */
function tipMoney(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

function Stat({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <Card
      className={`p-4 ${warn ? "border-amber-400/60 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/30" : ""}`}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}

/** "Possible missed clock-out", under a person's name. */
function MissedClockOutNote({ row }: { row: TimesheetRow }) {
  return (
    <div className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
      {row.possibleMissedClockOuts === 1
        ? "Possible missed clock-out"
        : `${row.possibleMissedClockOuts} possible missed clock-outs`}
    </div>
  );
}

function TotalCell({ row }: { row: TimesheetRow }) {
  // A person with no clocked time at all this week is not "0m": they never
  // clocked in, which is the thing the office needs to read (QA row 22).
  if (!row.clockedIn) {
    return <div className="text-sm text-muted-foreground">No clock-ins</div>;
  }
  return (
    <div>
      <div className="font-medium">{formatDuration(row.totalMinutes)}</div>
      {row.overtimeMinutes > 0 && (
        <div className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
          {formatDuration(row.overtimeMinutes)} overtime
        </div>
      )}
    </div>
  );
}

/** One day in the grid: hours on top, visits under, the whole cell a button. */
function DayCellButton({
  day,
  onClick,
  label,
}: {
  day: TimesheetDay;
  onClick: () => void;
  label: string;
}) {
  const open = day.segments.some((s) => s.open);
  const empty = day.segments.length === 0;
  const flagged = day.possibleMissedClockOut;
  return (
    // Named by its own text plus sr-only context, not by an aria-label that
    // replaced the text: "9h" and "3 visits" are what a voice-control user
    // reads off the cell and says, and the old label left the visits out
    // (axe label-content-name-mismatch, gaps-r2-11 part 2).
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-11 w-full min-w-[4.5rem] flex-col items-center justify-center rounded-md px-1 py-1 text-sm tabular-nums transition-colors hover:bg-muted ${
        flagged
          ? "bg-amber-500/15 ring-1 ring-inset ring-amber-500/60"
          : open
            ? "bg-emerald-500/10"
            : ""
      }`}
    >
      <span className="sr-only">{label}: </span>
      <span
        className={`inline-flex items-center gap-1 ${empty ? "text-muted-foreground" : "font-medium"}`}
      >
        {flagged && (
          <TriangleAlert
            className="h-3 w-3 shrink-0 text-amber-700 dark:text-amber-300"
            aria-hidden="true"
          />
        )}
        {empty ? (
          <>
            <span aria-hidden="true">–</span>
            <span className="sr-only">no time</span>
          </>
        ) : (
          formatDuration(day.minutes)
        )}
      </span>
      {day.visitsCompleted > 0 && (
        <span className="text-xs text-muted-foreground">
          {day.visitsCompleted} visit{day.visitsCompleted === 1 ? "" : "s"}
        </span>
      )}
      {flagged && <span className="sr-only">, possible missed clock-out</span>}
    </button>
  );
}

function PersonCard({
  row,
  tz,
  onDay,
}: {
  row: TimesheetRow;
  tz: string;
  onDay: (day: string) => void;
}) {
  return (
    // min-w-0: a grid item's automatic minimum is its min-content width, and
    // the day rows' nowrap times made that 352px on a 360px phone. The
    // truncation inside only engages once the card is allowed to be narrower.
    <Card className="min-w-0 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="break-words font-medium">{row.staff.display_name}</div>
          <div className="text-xs text-muted-foreground">
            {row.visitsCompleted} visit{row.visitsCompleted === 1 ? "" : "s"} completed ·{" "}
            {row.visitsScheduled} scheduled
            {row.tipsCents > 0 ? ` · ${tipMoney(row.tipsCents)} in tips` : ""}
            {row.onTheClock ? " · on the clock" : ""}
          </div>
          {row.possibleMissedClockOuts > 0 && <MissedClockOutNote row={row} />}
        </div>
        <div className="shrink-0 text-right tabular-nums">
          <TotalCell row={row} />
        </div>
      </div>
      <ul className="mt-3 divide-y">
        {row.days.map((d) => {
          const first = d.segments[0];
          const last = d.segments[d.segments.length - 1];
          return (
            <li key={d.day}>
              <button
                type="button"
                onClick={() => onDay(d.day)}
                // The same name the grid's cell carries, so "open this
                // person's Monday" is one question in both shapes: the
                // person in sr-only text, then what the row shows.
                className={`flex min-h-11 w-full items-center gap-3 py-1 text-left text-sm ${
                  d.possibleMissedClockOut ? "bg-amber-500/10" : ""
                }`}
              >
                <span className="sr-only">{row.staff.display_name}, </span>
                <span className="w-24 shrink-0">{formatDay(d.day)}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums">
                  {first
                    ? `${first.continuesFromPreviousDay ? "Midnight" : orgLocalTime(first.start, tz)} – ${
                        last.open && !last.continuesIntoNextDay
                          ? "now"
                          : last.continuesIntoNextDay
                            ? "midnight"
                            : orgLocalTime(last.end, tz)
                      }${d.visitsCompleted ? ` · ${d.visitsCompleted} visits` : ""}`
                    : d.visitsCompleted
                      ? `No time · ${d.visitsCompleted} visits`
                      : ""}
                </span>
                <span
                  className={`inline-flex shrink-0 items-center gap-1 tabular-nums ${d.segments.length ? "font-medium" : "text-muted-foreground"}`}
                >
                  {d.possibleMissedClockOut && (
                    <TriangleAlert
                      className="h-3 w-3 shrink-0 text-amber-700 dark:text-amber-300"
                      aria-hidden="true"
                    />
                  )}
                  {d.segments.length ? (
                    formatDuration(d.minutes)
                  ) : (
                    <>
                      <span aria-hidden="true">–</span>
                      <span className="sr-only">no time</span>
                    </>
                  )}
                </span>
                {d.possibleMissedClockOut && (
                  <span className="sr-only">, possible missed clock-out</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function EntryDialog({
  editing,
  tz,
  today,
  people,
  onClose,
}: {
  editing: Editing;
  tz: string;
  today: string;
  people: { id: string; display_name: string }[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const editFn = useServerFn(editTimeEntry);
  const addFn = useServerFn(addTimeEntry);

  const initial = (() => {
    if (editing.mode === "edit") {
      const i = orgTimeInputValue(editing.entry.clock_in, tz);
      const o = editing.entry.clock_out
        ? orgTimeInputValue(editing.entry.clock_out, tz)
        : // A forgotten clock-out. The form starts at now, because any other
          // time would be a guess the office might save without reading.
          orgTimeInputValue(Date.now(), tz);
      return {
        staffId: editing.entry.staff_id,
        inDay: i.day,
        inTime: i.time,
        outDay: o.day,
        outTime: o.time,
        note: editing.entry.note ?? "",
      };
    }
    return {
      staffId: editing.staffId ?? "",
      inDay: editing.day,
      inTime: "08:00",
      outDay: editing.day,
      outTime: "16:00",
      note: "",
    };
  })();
  const [f, setF] = useState(initial);
  const [stillOn, setStillOn] = useState(editing.mode === "edit" && !editing.entry.clock_out);
  const [saving, setSaving] = useState(false);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }));

  const save = async () => {
    const clockIn = new Date(orgWallTimeToInstant(f.inDay, f.inTime, tz)).toISOString();
    const clockOut = stillOn
      ? null
      : new Date(orgWallTimeToInstant(f.outDay, f.outTime, tz)).toISOString();
    if (clockOut && clockOut <= clockIn) {
      toast.error("The clock-out must be after the clock-in");
      return;
    }
    setSaving(true);
    try {
      if (editing.mode === "edit") {
        await editFn({
          data: { id: editing.entry.id, clockIn, clockOut, note: f.note.trim() || undefined },
        });
        toast.success("Time entry updated");
      } else {
        if (!f.staffId) {
          toast.error("Choose who this time is for");
          setSaving(false);
          return;
        }
        await addFn({
          data: {
            staffId: f.staffId,
            clockIn,
            clockOut: clockOut!,
            note: f.note.trim() || undefined,
          },
        });
        toast.success("Time added");
      }
      await qc.invalidateQueries({ queryKey: [TIMESHEET_KEY] });
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the time entry");
    } finally {
      setSaving(false);
    }
  };

  const name =
    editing.mode === "edit"
      ? editing.name
      : people.find((p) => p.id === f.staffId)?.display_name;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing.mode === "edit" ? "Fix a time entry" : "Add time"}</DialogTitle>
          <DialogDescription className="break-words">
            {name ? `${name}. ` : ""}Times are on the business's clock ({tz.replace(/_/g, " ")}).
            {editing.mode === "add" ? " For a day somebody worked and did not clock." : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {editing.mode === "add" && (
            <div className="space-y-1.5">
              <Label htmlFor="te-staff">Person</Label>
              <select
                id="te-staff"
                value={f.staffId}
                onChange={set("staffId")}
                className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm touch:min-h-11"
              >
                <option value="">Choose a person</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Clocked in</legend>
            {/* One column below sm. iOS draws a native date or time control
                at the width of its value and will not go narrower: on the
                owner's iPhone both were about 195px in 171px columns, so the
                time ran off the dialog and its left border sat on the date.
                `grid-cols-2` floors the TRACK at zero; it cannot shrink the
                control inside it. */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Input
                type="date"
                aria-label="Clock-in date"
                className="min-w-0"
                value={f.inDay}
                max={today}
                onChange={set("inDay")}
              />
              <Input
                type="time"
                aria-label="Clock-in time"
                className="min-w-0"
                value={f.inTime}
                onChange={set("inTime")}
              />
            </div>
          </fieldset>

          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Clocked out</legend>
            {editing.mode === "edit" && !editing.entry.clock_out && (
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={stillOn}
                  onChange={(e) => setStillOn(e.target.checked)}
                />
                Still on the clock
              </label>
            )}
            {!stillOn && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Input
                  type="date"
                  aria-label="Clock-out date"
                  className="min-w-0"
                  value={f.outDay}
                  max={today}
                  onChange={set("outDay")}
                />
                <Input
                  type="time"
                  aria-label="Clock-out time"
                  className="min-w-0"
                  value={f.outTime}
                  onChange={set("outTime")}
                />
              </div>
            )}
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="te-note">Note</Label>
            <Textarea
              id="te-note"
              value={f.note}
              maxLength={500}
              onChange={set("note")}
              placeholder="Why it was changed, for whoever runs payroll"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={saving}>
            <Timer className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
