/**
 * Auto-routing, as a floating card rather than a slab.
 *
 * ── WHAT WAS WRONG WITH THE LAST ONE ──────────────────────────────────────
 *
 * It was correct and unusable. Opening it inserted a full-width block between
 * the toolbar and the board, so the thing you were routing slid off-screen at
 * the moment you started routing it. Two date inputs, a level control with
 * a paragraph of hint text, a chip per tech, a bordered switch with two lines
 * of explanation, two buttons and a result table — all expanded at once,
 * roughly 500px tall before the preview even ran. The verdict was fair: it
 * "covers the majority of the screen" and it is "very much in the way".
 *
 * The information was not the problem; the simultaneity was. Every control was
 * shouting its full explanation whether or not you were touching it.
 *
 * ── THE SHAPE ─────────────────────────────────────────────────────────────
 *
 * A ~320px card floating over the board, bottom-right, so the schedule stays
 * visible and in place behind it. Each input collapses to a pill that STATES
 * ITS CURRENT VALUE — "Aug 5", "All techs", "Balanced" — and opens to an
 * editor only when clicked. One open at a time, so the card cannot grow past
 * about a third of the viewport.
 *
 * A pill showing its value is doing two jobs: it is the control, and it is the
 * summary you would otherwise need the panel open to read.
 *
 * ── AND THEN THERE WAS ONE BUTTON ─────────────────────────────────────────
 *
 * QA, 2026-08-19: "Also remove the preview, let's just have apply." So the
 * card no longer has a preview STEP, a result box, or an Apply that waits for
 * one. You pick the days and the people, and you press Apply. There is no
 * level to pick any more; see the note on LEVEL below.
 *
 * What the result box used to say is now said afterwards, by the toast, out of
 * `r.forecast` — the same numbers. Since 2026-10 they are read off the write
 * itself (apply_route_plan), after the road was measured, rather than off a
 * dry run taken before it; see route-plan.server.ts.
 *
 * Everything the previous panel could express, it still expresses, and the
 * three things it must never swallow still reach the screen:
 *
 *   * a stop that still misses its arrival window   → a warning toast
 *   * a day the planner refused                     → a warning toast
 *   * a day that had no route to compare against    → the honest "New route",
 *     which still refuses to invent a saving for it
 *
 * The one warning that DID go is "N tech-days had no route to compare", which
 * was a footnote to a per-day comparison the card no longer shows. Its whole
 * job was to explain why a headline covered fewer days than it planned; with
 * the headline reduced to one line, the all-or-nothing case it exists for is
 * what that line now says outright.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarDays, Check, ChevronDown, Clock, Users, Wand2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { applyOptimize, getDispatchSettings } from "@/lib/visits.functions";
import type { RoadLegProblem } from "@/lib/road-legs.server";
import { orgLocalTime } from "@/lib/org-day";
import { useOrgTimezone } from "@/hooks/useOrgToday";

// ── THERE IS NO LEVEL TO CHOOSE ANY MORE ────────────────────────────────
//
// This was three options: Fast, Balanced, Thorough. Measured on a real day of
// 21 stops across three technicians:
//
//   thorough   519.4 min driving   49.7 km   394 ms
//   balanced   546.3 min driving   53.1 km   249 ms
//   fast       546.3 min driving   53.1 km
//
// Two things follow, and only one of them is about the numbers.
//
// Thorough simply wins. It is a 2-opt pass over a route the others leave as
// nearest-neighbour, it saved 27 minutes of driving here, and it cost 145 ms
// against a statement_timeout of 8 seconds. There is no trade being made.
//
// And `fast` was never a speed setting. It differs from balanced ONLY where a
// customer has an arrival window or a morning/afternoon preference, and what
// it does there is ignore them. That is not a performance option, it is
// "arrive when the customer asked you not to", and nobody running two trucks
// would choose it on purpose. It read as harmless because the demo day has
// zero windows and zero preferences, which is exactly why the three levels
// measured the same and why the choice looked like a free one.
//
// So: always thorough, and the control is gone.
const LEVEL = "thorough" as const;

const mins = (n: number) => {
  const r = Math.round(n);
  if (Math.abs(r) < 60) return `${r} min`;
  const h = Math.floor(Math.abs(r) / 60);
  const m = Math.abs(r) % 60;
  return `${r < 0 ? "-" : ""}${h}h${m ? ` ${m}m` : ""}`;
};

/** What the result box used to say, in one line, after the fact.
 *
 *  `daysMeasured` counts only the days that HAD a route to compare against. A
 *  day whose stops carried no sequence is not a slower route, it is no route,
 *  and folding it into a saving would invent one — so when nothing was ordered
 *  this says exactly that instead of quoting a number.
 *
 *  It reports a WORSE result too. That used to be advice ("leave it alone");
 *  said after the write it is a fact, and it is still the fact a dispatcher
 *  would rather have than not. */
const drivingLine = (f: Forecast) => {
  // Not "no violations": no measurement. The caller warns about it separately.
  if (!f) return undefined;
  if (f.daysMeasured === 0) {
    return "New route, so these days had no order to compare against.";
  }
  if (f.savedMin > 0.5) return `Saves about ${mins(f.savedMin)} of driving.`;
  if (f.savedMin < -0.5) {
    return `Adds about ${mins(-f.savedMin)} of driving, and the order it replaced was quicker.`;
  }
  return "No meaningful change to driving time.";
};

/** "Aug 5" — the pill has ~90px, and the year is almost never the question. */
const shortDay = (iso: string) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

type Section = "dates" | "techs" | "windows" | null;

/** Arrival windows for this run: the organization's setting, or one of the
 *  two overridden once. Settings -> Scheduling holds the default. */
type WindowsChoice = "org" | "honour" | "ignore";

/**
 * Why a day could not be measured, in words for whoever has to act on it.
 *
 * A Record keyed on RoadLegProblem rather than a switch, so a seventh cause
 * added to road-legs.server.ts fails to compile here until it has a sentence.
 */
const ROAD_LEG_REASON: Record<RoadLegProblem, string> = {
  router_unreachable: "The routing service could not be reached.",
  router_error: "The routing service returned an error.",
  router_busy: "The free routing service was too busy to answer. Try again in a minute.",
  wrong_region: "The routing service has no map for these addresses.",
  too_many_points: "The day has more stops than the router will measure at once.",
  nothing_usable: "The routing service returned nothing usable.",
  save_failed: "The measurements could not be saved.",
};

/** applyOptimize's measurement, or null when it could not be taken. */
type Forecast = Awaited<ReturnType<typeof applyOptimize>>["forecast"];

function Pill({
  icon: Icon,
  value,
  open,
  onClick,
}: {
  icon: typeof CalendarDays;
  value: string;
  open: boolean;
  onClick: () => void;
}) {
  // 44px on touch and unchanged on a pointer — the same split ui/button.tsx
  // makes, for the same reason. A pill is the primary control on this card and
  // it was 24px tall.
  return (
    <button
      onClick={onClick}
      aria-expanded={open}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors touch:min-h-11 max-md:px-3 ${
        open ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="max-w-[9rem] truncate">{value}</span>
      <ChevronDown
        className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
      />
    </button>
  );
}

export function AutoRoutingPanel({
  day,
  staff,
  onApplied,
  onClose,
}: {
  day: string;
  staff: any[];
  onApplied: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const applyFn = useServerFn(applyOptimize);
  const tz = useOrgTimezone();

  const techs = useMemo(() => staff.filter((s: any) => s.is_field_tech), [staff]);

  const [from, setFrom] = useState(day);
  const [to, setTo] = useState(day);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [section, setSection] = useState<Section>(null);
  const [windows, setWindows] = useState<WindowsChoice>("org");

  // The organization's own choice, so the pill can say what "as set" means.
  // Same query key as Settings -> Scheduling and the board, so it is usually
  // already in the cache.
  const settingsFn = useServerFn(getDispatchSettings);
  const { data: dispatch } = useQuery({
    queryKey: ["dispatch-settings"],
    queryFn: () => settingsFn(),
  });
  const orgWindows: "honour" | "ignore" =
    (dispatch?.settings as { route_windows?: string } | null | undefined)?.route_windows ===
    "ignore"
      ? "ignore"
      : "honour";
  const effectiveWindows = windows === "org" ? orgWindows : windows;

  const chosen = picked.size ? [...picked] : techs.map((s: any) => s.id);

  // First names only: the toast lists every technician in the run, and three
  // full names is already wider than a phone.
  const nameOf = (id: string) =>
    String(staff.find((s: any) => s.id === id)?.display_name ?? "Tech").split(" ")[0];
  // ── WHO HAS NO START ADDRESS, AND WHY IT IS WORTH SAYING ────────────────
  //
  // staff_start_point falls back for somebody with no start address, and its
  // last tier is one of THEIR OWN stops -- so their route begins at their work
  // and they are charged no travel to reach it. Measured on the demo day: 6.0
  // minutes to the first stop, against 107.6 for a technician whose real home
  // address is across the city.
  //
  // The consequence is the opposite of what it sounds like. Because their day
  // costs less on paper, the balancer -- which evens out MEASURED minutes,
  // drive included -- hands them more of it. Same day: 8 stops for the person
  // with no address, 6 for the one with the longest commute. Nobody is being
  // shortchanged by the routing; the plan is simply built on a commute of zero
  // that does not exist.
  //
  // So the notice says what is actually true, and deliberately does NOT
  // promise a shorter day. Adding the address will usually make that person's
  // measured day LONGER, because the drive they were already doing finally
  // appears in the numbers.
  const noStart = techs.filter(
    (s: any) => chosen.includes(s.id) && (s.start_latitude == null || s.start_longitude == null),
  );

  const rangeValid = Boolean(from && to && to >= from);

  const applyMut = useMutation({
    mutationFn: () =>
      applyFn({ data: { staffIds: chosen, from, to, level: LEVEL, reassign: true, windows } }),
    onSuccess: (r) => {
      // The split is the point, so it is what the toast says. "Re-ordered 20
      // stops" was true both before and after the fix for the bug where all
      // twenty landed on one technician — it could not tell the dispatcher
      // whether the work had actually been divided.
      const share = (r.balance ?? []).map((b) => `${nameOf(b.staffId)} ${b.stops}`).join(" · ");
      if (r.forecast && r.forecast.daysPlanned === 0) {
        // The sentence the result box used to carry, and the one case where
        // `r.stops` cannot be trusted: with nothing to plan, plan_day_across_staff
        // returns each technician's CURRENT load rather than zero, so "Routed 20
        // stops" is what a run that touched nothing would otherwise say. The
        // measurement is the only thing that can tell the two apart.
        toast.info("Nothing to route in that range.", {
          // There is no checkbox to blame any more, so this says the only two
          // things that can now be true. It used to name the reassign control,
          // which was the usual cause and is gone.
          description:
            "Those days have no scheduled stops for the people you picked.",
          duration: 8000,
        });
      } else if (!r.forecast) {
        // Since 2026-10 the numbers come from the write itself, so there is
        // no separate measurement left to fail: no forecast means every day
        // in the range was refused, and each refusal follows as its own toast.
        // Claim nothing was routed, because nothing was.
        toast.warning("Nothing was routed.", {
          description: "Every day in that range was refused. The reasons follow.",
          duration: 8000,
        });
      } else {
        toast.success(
          `Routed ${r.stops} stop${r.stops === 1 ? "" : "s"}` + (share ? ` — ${share}` : "."),
          { description: drivingLine(r.forecast) },
        );
      }
      // The one fact that used to be worth a preview: a stop that will still
      // miss its window after the best order anybody can give it. It is a
      // separate toast rather than a line in the one above because it is the
      // only thing here a dispatcher may have to act on -- and it NAMES them,
      // because "2 stops" sends somebody hunting through the board.
      //
      // With windows set aside it is not a leftover but the price of the
      // shorter drive, early arrivals included, and says so: set aside, not
      // silently dropped.
      const misses = r.windowMisses ?? [];
      const missCount = r.windowMissCount ?? 0;
      const named = misses
        .slice(0, 4)
        .map(
          (m) =>
            `${m.client ?? "A client"}: ${m.kind === "late" ? "arrives" : "arrives early,"} ${orgLocalTime(m.etaStart, tz)}` +
            `${from !== to ? ` on ${shortDay(m.day)}` : ""}` +
            ` (window ${m.earliest ? orgLocalTime(m.earliest, tz) : "…"}–${m.latest ? orgLocalTime(m.latest, tz) : "…"}).`,
        );
      if (missCount > 4) named.push(`${missCount - 4} more.`);
      if (r.windowsHonoured === false && missCount > 0) {
        toast.warning(
          missCount === 1
            ? "Shortest driving: 1 arrival window is missed."
            : `Shortest driving: ${missCount} arrival windows are missed.`,
          { description: named.join(" "), duration: 15000 },
        );
      } else {
        const v = r.forecast?.violations ?? 0;
        if (v > 0) {
          toast.warning(
            v === 1
              ? "1 stop still misses its arrival window."
              : `${v} stops still miss their arrival windows.`,
            { description: named.join(" ") || undefined, duration: 12000 },
          );
        }
      }
      // A day planned from straight-line estimates is not the same day as one
      // planned against the road network, and until now they produced
      // identical output. road-legs.server.ts opens with why that matters: the
      // road runs 1.44x to 2.42x the straight line against a flat 1.45x model,
      // a hop OSRM drives in 22 minutes was costed at 66.7, and a solver
      // minimising the wrong quantity picks the wrong ORDER. So this is not
      // "the ETA may be off" -- the STOP ORDER may be wrong, and the
      // dispatcher is about to drive it.
      //
      // The reason is named because the four causes have different owners: an
      // outage passes, a wrong region is configuration, and a day too big for
      // the router is ours. A dispatcher cannot fix any of them, but the
      // person they forward this to can, and "routing was estimated" alone
      // does not tell them which.
      if (r.estimatedDays.length > 0) {
        const days = r.estimatedDays.length;
        const reasons = [...new Set(r.estimatedDays.map((d) => ROAD_LEG_REASON[d.problem]))];
        toast.warning(
          `${days === 1 ? "1 day was" : `${days} days were`} routed from straight-line estimates, not measured roads. ` +
            `The stop order may not be the best road route.`,
          { description: reasons.join(" "), duration: 12000 },
        );
      }
      // Different sentence on purpose: this day WAS measured, just not all of
      // it. Folding it into the warning above would overstate the problem, and
      // leaving it out would understate it.
      if (r.partlyEstimatedDays.length > 0) {
        const days = r.partlyEstimatedDays.length;
        toast.warning(
          `On ${days === 1 ? "1 day" : `${days} days`}, some stops sit outside the routing map, so those legs were estimated.`,
          {
            description: "Usually an address whose coordinates are wrong, or a region the router does not cover.",
            duration: 12000,
          },
        );
      }
      // A route that does not fit the day. The planner plans it anyway --
      // the dispatcher may choose to run late or move stops by hand -- but
      // until this, "Routed 40 stops" was all anyone was told about a day
      // the routing trials planned to finish at 02:51 the next morning.
      const over = r.fit?.overruns ?? [];
      if (over.length > 0) {
        const multiDay = from !== to;
        const lines = over
          .slice(0, 3)
          .map((o) =>
            o.minutesPastEnd > 0
              ? `${nameOf(o.staffId)} finishes at ${orgLocalTime(o.endsAt, tz)}${multiDay ? ` on ${shortDay(o.day)}` : ""}, ${mins(o.minutesPastEnd)} after the workday ends.`
              : `${nameOf(o.staffId)} has ${mins(o.plannedMin)} planned${multiDay ? ` on ${shortDay(o.day)}` : ""}, over their ${mins(o.capacityMin)} day.`,
          );
        if (over.length > 3) lines.push(`${over.length - 3} more.`);
        toast.warning(
          over.length === 1
            ? "One route does not fit the workday."
            : `${over.length} routes do not fit the workday.`,
          { description: lines.join(" "), duration: 12000 },
        );
      }
      // Stops with no map location are routed last, because nobody knows
      // where they are. Their ETA is a guess, so the dispatcher is told.
      const unlocated = (r.fit?.unlocated ?? []).reduce((n, u) => n + u.count, 0);
      if (unlocated > 0) {
        toast.warning(
          unlocated === 1
            ? "1 stop has no map location, so it was put at the end of the day."
            : `${unlocated} stops have no map location, so they were put at the end of the day.`,
          {
            description: "Fix the address on the client's property so it can be routed.",
            duration: 12000,
          },
        );
      }
      // Refusals are surfaced, not swallowed. A dispatcher who is not told a
      // day was skipped will believe it was optimized.
      for (const s of r.skipped.slice(0, 3)) toast.warning(s.reason, { duration: 8000 });
      if (r.skipped.length > 3) {
        toast.warning(`${r.skipped.length - 3} more day(s) skipped.`, { duration: 8000 });
      }
      qc.invalidateQueries({ queryKey: ["visits"] });
      onApplied();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Escape closes the card. It floats above the board, so the usual instinct
  // for "get this out of my way" has to work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (section) setSection(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [section, onClose]);

  const busy = applyMut.isPending;

  const dateLabel = from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`;
  const techLabel =
    picked.size === 0
      ? "All techs"
      : picked.size === 1
        ? (techs.find((s: any) => picked.has(s.id))?.display_name ?? "1 tech")
        : `${picked.size} techs`;

  return (
    <div
      role="dialog"
      aria-label="Auto-routing"
      /* `bottom-3` put Apply and Cancel INSIDE the tab bar. Measured on an
         iPhone 17 Pro, 2026-08-25: panel bottom 846, MobileTabBar top 789,
         Apply at y 793-837 — entirely behind it, and the panel is too short
         for its own scroller to engage, so there was no gesture that reached
         it. Both elements are z-40 and the nav renders after <main>, so the
         nav won. On the web it was merely half-covered; on the phone the
         primary action was unreachable.

         Cleared rather than restacked: raising z-index would only put the
         panel over the nav. The offset is the tab bar's own height plus the
         home-indicator inset, the same shape InstallBanner.tsx:71 uses, and it
         stops at md because that is where the bar itself stops.

         100vh -> 100dvh while here: it was the only 100vh left in the app and
         on iOS it resolves to the LARGE viewport. It was not the cause of the
         fault above — measured, it resolved correctly — but it is the wrong
         unit beside a tab bar that moves. */
      className="fixed inset-x-3 bottom-3 z-40 max-h-[min(32rem,calc(100dvh-6rem))] overflow-y-auto rounded-lg border bg-card shadow-xl max-md:bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.75rem)] max-md:max-h-[calc(100dvh-11rem)] sm:left-auto sm:right-4 sm:w-80"
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold">
          <Wand2 className="h-4 w-4 shrink-0" /> Auto-routing
        </div>
        <button
          onClick={onClose}
          aria-label="Close auto-routing"
          className="flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-muted touch:min-h-11 touch:min-w-11"
        >
          <X className="h-4 w-4 shrink-0" />
        </button>
      </div>

      <div className="space-y-2 p-3">
        <div className="flex flex-wrap gap-1.5">
          <Pill
            icon={CalendarDays}
            value={dateLabel}
            open={section === "dates"}
            onClick={() => setSection(section === "dates" ? null : "dates")}
          />
          <Pill
            icon={Users}
            value={techLabel}
            open={section === "techs"}
            onClick={() => setSection(section === "techs" ? null : "techs")}
          />
          <Pill
            icon={Clock}
            value={effectiveWindows === "ignore" ? "Shortest drive" : "Keep windows"}
            open={section === "windows"}
            onClick={() => setSection(section === "windows" ? null : "windows")}
          />
        </div>

        {section === "dates" && (
          <div className="space-y-1.5 rounded-md border p-2">
            <Label className="text-2xs text-muted-foreground">Days to route</Label>
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                value={from}
                aria-label="First day"
                onChange={(e) => {
                  setFrom(e.target.value);
                  // Dragging the start past the end silently inverts the range
                  // and the server rejects it. Carrying the end along keeps the
                  // common case (one day) working without a second click.
                  if (to < e.target.value) setTo(e.target.value);
                }}
                className="h-8 text-xs"
              />
              <span className="text-2xs text-muted-foreground">to</span>
              <Input
                type="date"
                value={to}
                min={from || undefined}
                aria-label="Last day"
                onChange={(e) => setTo(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
        )}

        {section === "windows" && (
          <div className="space-y-1.5 rounded-md border p-2">
            <Label className="text-2xs text-muted-foreground">Arrival windows, this run only</Label>
            <div role="radiogroup" aria-label="Arrival windows this run" className="grid gap-1">
              {(
                [
                  ["honour", "Honour arrival windows"],
                  ["ignore", "Shortest driving (ignore windows)"],
                ] as const
              ).map(([value, label]) => {
                const on = effectiveWindows === value;
                return (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={on}
                    onClick={() => setWindows(value === orgWindows ? "org" : value)}
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-2xs touch:min-h-11 ${on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    <Check className={`h-3 w-3 shrink-0 ${on ? "" : "invisible"}`} />
                    <span className="min-w-0">
                      {label}
                      {value === orgWindows ? " · your setting" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-2xs text-muted-foreground">
              The default is in Settings → Scheduling. Missed windows are listed after the run
              either way.
            </p>
          </div>
        )}

        {section === "techs" && (
          <div className="space-y-1.5 rounded-md border p-2">
            <div className="flex items-center justify-between">
              <Label className="text-2xs text-muted-foreground">
                {picked.size === 0 ? "Everyone who runs routes" : `${picked.size} selected`}
              </Label>
              {picked.size > 0 && (
                <button
                  className="text-2xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => setPicked(new Set())}
                >
                  Clear
                </button>
              )}
            </div>
            {/* Taller chips on touch would show one row inside max-h-32, so the
                list gets more room there and keeps its own scroll. */}
            <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto max-md:max-h-44">
              {techs.map((s: any) => {
                const on = picked.has(s.id);
                return (
                  <button
                    key={s.id}
                    aria-pressed={on}
                    onClick={() => {
                      const next = new Set(picked);
                      if (on) next.delete(s.id);
                      else next.add(s.id);
                      setPicked(next);
                    }}
                    className={`flex items-center rounded-full border px-2 py-0.5 text-2xs touch:min-h-11 max-md:px-3 ${on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
                  >
                    {s.display_name}
                  </button>
                );
              })}
              {techs.length === 0 && (
                <span className="text-2xs text-muted-foreground">
                  Nobody runs routes yet. Switch someone on under Crew.
                </span>
              )}
            </div>
          </div>
        )}

{/* ── THE CHECKBOX THAT USED TO BE HERE ─────────────────────────────
            "Also move work between techs", default off. It was the only
            control that could move a stop from one person to another, so it
            was shown rather than hidden, and it was off so that nobody had
            work taken away by surprise.

            Off was also why the feature appeared broken. With reassign off the
            planner considers ONLY unassigned visits, and a day the recurring
            schedule has already filled has none -- so Apply returned nothing,
            every time, and explained itself afterwards in a toast.

            It is gone because the consent it was asking for is already given
            higher up: WHO YOU SELECT IS THE CONSENT. The planner only ever
            touches visits that are unassigned or already belong to a SELECTED
            technician; somebody left out keeps their day. Proven against
            production rather than read off the comment -- selecting everyone
            except the technician holding all 21 of the day's stops returns
            zero rows, and his stops are untouched.

            So the panel is now what it says on the tin: who, which days,
            Apply. If you do not want somebody's day rearranged, do not tick
            them. */}
      </div>

      {noStart.length > 0 && (
        <div className="border-t px-3 py-2">
          <p className="text-2xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">
              {noStart.length === 1
                ? `${String(noStart[0].display_name ?? "One technician").split(" ")[0]} has no start address.`
                : `${noStart.length} technicians have no start address.`}
            </span>{" "}
            Their route is planned from their own first stop, so the drive to it
            counts as nothing and they tend to be given more of the day than
            they can really fit. Adding it under Team makes these routes honest.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {/* One button. The guard that used to live on Apply — "a preview
            exists" — was really a guard on the INPUTS, so that is what it is
            now: a range that runs forwards, and somebody to route. Both are
            visible in the pills above, which is where a disabled Apply sends
            you anyway. */}
        <Button
          size="sm"
          onClick={() => applyMut.mutate()}
          disabled={!rangeValid || techs.length === 0 || busy}
          title={
            techs.length === 0
              ? "Nobody runs routes yet"
              : !rangeValid
                ? "The last day is before the first"
                : undefined
          }
        >
          {applyMut.isPending ? "Applying…" : "Apply"}
        </Button>
      </div>
    </div>
  );
}
