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
 *
 * ── AND IT CAN BE SENT TO THE BACKGROUND (2026-10-04) ─────────────────────
 *
 * The owner: "When utilizing the auto-routing and it takes a while, allow it
 * to be dismissed to run in a background." Cancel used to be disabled for the
 * whole run, and the run was one request that only this card was waiting on.
 *
 * Now Apply starts a RUN (routing_runs, see auto-routing.server.ts) under an
 * id this card chooses, and the card watches the run's row rather than the
 * request. While it is going, Cancel reads "Run in background" and closing the
 * card by any route (that button, the X, Escape, Android's back) leaves it
 * running. The app header carries a pill that says so on every page
 * (RoutingRunIndicator), and tapping it comes back here.
 *
 * The result is still said by the toasts below, in the same words, from the
 * same object -- which the server now keeps on the run. If the card is open
 * when the run finishes, they appear then, as before. If it was dismissed,
 * the header says "Routes ready, review", and opening the card replays them
 * once and marks the run seen. The run writes the routes, all of its days in
 * one transaction, and a run that is cut off before that write has changed
 * nothing.
 *
 * ── AND NOTHING MOVES WITHOUT BEING SHOWN FIRST (2026-10-31, #609) ────────
 *
 * Decision D10. Apply used to ask for reassignment on every run, so it could
 * move a visit that was assigned by hand for a reason the planner cannot see:
 * the one walker a dog tolerates, the tech who holds the key. Three things
 * changed, and only these three:
 *
 *   * Current assignments are kept by default. A run gives out unassigned
 *     visits and puts every route in order; it moves a visit from one tech
 *     to another only when "Also move visits between techs" is switched on
 *     for that run. The switch starts off every time the card opens and is
 *     never remembered.
 *   * A visit pinned to its tech (the visit drawer, visits.route_pinned) is
 *     never moved, even with the switch on. The planner and the database
 *     write both refuse to.
 *   * Preview comes first. It plans every day and writes nothing, and the card
 *     lists every visit that would change hands or come off its route. Apply
 *     sends that preview back and the server writes exactly it; a day that
 *     changed in between is refused, not re-planned. Changing any input
 *     clears the preview, so Apply never writes a plan for other inputs.
 *
 * The run itself (background, header pill, toasts, Undo) is unchanged; it now
 * starts from a preview instead of from a fresh plan.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarDays, Check, ChevronDown, Clock, Loader2, Users, Wand2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getDispatchSettings } from "@/lib/visits.functions";
import {
  getRoutingRunUndo,
  markRoutingRunSeen,
  previewRoutingRun,
  startRoutingRun,
  undoRoutingRun,
} from "@/lib/routing-runs.functions";
import { undoSummaryLine, undoToastMs, undoUnavailableLine } from "@/lib/routing-undo";
import type { AutoRouteResult, RoutePreview } from "@/lib/auto-routing.server";
import type { RouteMove } from "@/lib/route-moves";
import type { RoadLegProblem } from "@/lib/road-legs.server";
import {
  failureKind,
  indicatorState,
  progressFraction,
  type RoutingRunRow,
} from "@/lib/routing-run";
import { ROUTING_RUNS_KEY, routingUi, useRoutingRuns } from "@/hooks/useRoutingRuns";
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

/** The run's measurement, or null when it could not be taken. */
type Forecast = AutoRouteResult["forecast"];

/** What the card says while a run is going, in the order the run goes. */
const stageLine = (run: RoutingRunRow | null) => {
  if (!run || !run.stage) return "Starting…";
  const of =
    run.days_total > 1
      ? ` (day ${Math.min(run.days_done + 1, run.days_total)} of ${run.days_total})`
      : "";
  if (run.stage === "road_times") return `Fetching road times${of}`;
  if (run.stage === "optimizing") return `Optimizing${of}`;
  return "Saving the routes";
};

/** Why a run did not finish, in the words a dispatcher can act on. */
const failureLine = (run: RoutingRunRow) => {
  const kind = failureKind(run);
  if (kind === "abandoned") {
    return "Auto-routing stopped before it finished, so nothing was changed. Run it again.";
  }
  if (kind === "abandoned_saved") {
    return "Auto-routing saved the routes but stopped before it could report on them. Check the board.";
  }
  return run.error || "Auto-routing did not finish.";
};

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

/** One line per move: who has the visit now, and who would have it. */
const moveLine = (m: RouteMove, fullName: (id: string | null) => string | null) => {
  const from = fullName(m.fromStaffId) ?? "Unassigned";
  if (m.kind === "assigned") return `Unassigned, goes to ${fullName(m.toStaffId)}`;
  if (m.kind === "reassigned") return `${from}, goes to ${fullName(m.toStaffId)}`;
  if (m.kind === "unassigned") return `${from}, taken off and left unassigned`;
  return `${from} keeps it, but it is left off the route`;
};

/**
 * What Apply will change, listed before it changes it (D10, #609).
 *
 * Every move is listed, none summarised away: a visit changing hands is the
 * thing the dispatcher is being asked about. The list scrolls inside the card
 * so a long one cannot push Apply off the screen. Visits that keep their tech
 * and only get a new place in the order are counted, not listed. The day
 * never changes, and the arrival times are worked out by the write itself,
 * so the card says that rather than guessing a time.
 */
function PreviewList({
  preview,
  reassign,
  fullName,
}: {
  preview: RoutePreview;
  reassign: boolean;
  fullName: (id: string | null) => string | null;
}) {
  const moves = preview.plans.flatMap((p) => p.moves);
  const reordered = preview.plans.reduce((n, p) => n + p.reordered, 0);
  const multiDay = new Set(preview.plans.map((p) => p.day)).size > 1;
  const headline =
    moves.length === 0
      ? "No visit changes tech."
      : moves.length === 1
        ? "1 visit changes."
        : `${moves.length} visits change.`;
  return (
    <section aria-label="Preview" className="space-y-1.5 rounded-md border p-2">
      <p className="text-2xs font-medium text-foreground">
        {headline}{" "}
        <span className="font-normal text-muted-foreground">
          {reordered === 1
            ? "1 visit keeps its tech and gets a new place in the order."
            : `${reordered} visits keep their tech and get a new place in the order.`}
        </span>
      </p>
      {moves.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto">
          {moves.map((m) => (
            <li key={`${m.day}:${m.visitId}`} className="min-w-0 rounded border px-2 py-1 text-2xs">
              <p className="truncate font-medium text-foreground">
                <bdi>{m.client ?? "A client"}</bdi>
                {m.service ? (
                  <span className="font-normal text-muted-foreground"> · {m.service}</span>
                ) : null}
                {multiDay ? (
                  <span className="font-normal text-muted-foreground"> · {shortDay(m.day)}</span>
                ) : null}
              </p>
              <p className="text-muted-foreground">{moveLine(m, fullName)}</p>
            </li>
          ))}
        </ul>
      )}
      {preview.skipped.length > 0 && (
        <p className="text-2xs text-muted-foreground">
          {preview.skipped.length === 1
            ? "1 day could not be planned and will not change."
            : `${preview.skipped.length} days could not be planned and will not change.`}
        </p>
      )}
      <p className="text-2xs leading-relaxed text-muted-foreground">
        No visit changes day. Arrival times are worked out for each route when you apply.
        {reassign ? "" : " Nobody loses a visit they already have."} Apply makes exactly these
        changes; if the day changes first, that day is left alone.
      </p>
    </section>
  );
}

export function AutoRoutingPanel({
  day,
  staff,
  onApplied,
  onClose,
  onReviewDay,
}: {
  day: string;
  staff: any[];
  onApplied: () => void;
  onClose: () => void;
  /** Show this day on the board: the first day of a run being reviewed. */
  onReviewDay?: (day: string) => void;
}) {
  const qc = useQueryClient();
  const previewFn = useServerFn(previewRoutingRun);
  const startFn = useServerFn(startRoutingRun);
  const seenFn = useServerFn(markRoutingRunSeen);
  const undoStateFn = useServerFn(getRoutingRunUndo);
  const undoFn = useServerFn(undoRoutingRun);
  const tz = useOrgTimezone();

  // The board leaves room under this card for as long as it is open, so the
  // last cards in a lane can be scrolled up out from under it (QA row 17:
  // it covered cards at 820, 1024 and 1440). routes.tsx reads the variable.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => {
      root.style.setProperty("--auto-routing-h", `${Math.ceil(el.getBoundingClientRect().height)}px`);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--auto-routing-h");
    };
  }, []);

  const techs = useMemo(() => staff.filter((s: any) => s.is_field_tech), [staff]);

  const [from, setFrom] = useState(day);
  const [to, setTo] = useState(day);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [section, setSection] = useState<Section>(null);
  const [windows, setWindows] = useState<WindowsChoice>("org");
  // Off every time the card opens, and never stored anywhere (D10): moving
  // work between techs is a choice made for one run, after seeing it.
  const [reassign, setReassign] = useState(false);

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

  // ── THE PREVIEW ─────────────────────────────────────────────────────────
  //
  // Kept with the inputs it was made from. Any change to them (days, people,
  // windows, the reassign switch) means the preview describes a different
  // run, so it stops counting and Apply goes back to Preview.
  const inputsKey = JSON.stringify([from, to, [...chosen].sort(), windows, reassign]);
  const [shownPreview, setShownPreview] = useState<{ key: string; preview: RoutePreview } | null>(
    null,
  );
  const preview = shownPreview?.key === inputsKey ? shownPreview.preview : null;
  const previewMut = useMutation({
    mutationFn: async () => {
      const key = inputsKey;
      const out = await previewFn({
        data: { staffIds: chosen, from, to, level: LEVEL, reassign, windows },
      });
      return { key, preview: out as RoutePreview };
    },
    onSuccess: (out) => {
      setSection(null);
      setShownPreview(out);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const fullName = (id: string | null) =>
    id ? String(staff.find((s) => s.id === id)?.display_name ?? "Another tech") : null;

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

  // ── THE RUN ─────────────────────────────────────────────────────────────
  //
  // The run this card is showing: one in progress (this person's, or one
  // they attached to), else the newest finished one they have not looked at.
  const { runs, serverNow } = useRoutingRuns();
  const shown = indicatorState(runs, serverNow);
  const activeRun = shown.kind === "running" ? shown.run : null;
  // Runs this card watched while they were going, so a finish it sees is
  // announced LIVE (and the card closes, as Apply always did) rather than
  // replayed as a review.
  const sawRunning = useRef(new Set<string>());
  if (activeRun) sawRunning.current.add(activeRun.id);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    routingUi.setPanelOpen(true);
    return () => {
      mounted.current = false;
      routingUi.setPanelOpen(false);
    };
  }, []);

  const applyMut = useMutation({
    mutationFn: async () => {
      // Apply writes the preview on screen and nothing else. No preview, no
      // write: the button says Preview until there is one.
      if (!preview) throw new Error("Preview the changes first.");
      // The id is chosen here so the card can watch the run's row before the
      // request comes back -- which, if the app is closed, it never does.
      const runId = crypto.randomUUID();
      routingUi.starting(runId);
      setTimeout(() => void qc.invalidateQueries({ queryKey: ROUTING_RUNS_KEY }), 400);
      try {
        return await startFn({
          data: { runId, staffIds: chosen, from, to, level: LEVEL, windows, preview },
        });
      } finally {
        routingUi.started(runId);
      }
    },
    onSuccess: (out) => {
      void qc.invalidateQueries({ queryKey: ROUTING_RUNS_KEY });
      // Written (or attached to another run): either way this preview is spent.
      setShownPreview(null);
      if (out.attached) {
        // One active run per organization. A second press watches the first
        // rather than starting a planner over the same visits.
        if (!out.mine) routingUi.attach(out.runId);
        toast.info(
          out.fromDay === out.toDay
            ? `Routes for ${shortDay(out.fromDay)} are already being planned. Showing that run.`
            : `Routes for ${shortDay(out.fromDay)} to ${shortDay(out.toDay)} are already being planned. Showing that run.`,
        );
        return;
      }
      // Dismissed while it ran: the header indicator announces it instead.
      if (!mounted.current) return;
      if (!routingUi.claim(`finished:${out.runId}`)) return;
      routingUi.claim(`review:${out.runId}`);
      if (out.status === "succeeded") finishLive(out.runId, out.result, from, to);
      else {
        toast.error(out.error);
        void seenFn({ data: { runId: out.runId } });
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // A finish this card saw on the poll rather than on its own request (the
  // request went to another tab, or the card was reopened mid-run), and a
  // finished run nobody has looked at yet (the review).
  const shownId = shown.kind === "idle" ? null : shown.run.id;
  useEffect(() => {
    if (shown.kind !== "ready" && shown.kind !== "failed") return;
    const run = shown.run;
    const live = sawRunning.current.has(run.id);
    const key = live ? `finished:${run.id}` : `review:${run.id}`;
    if (!routingUi.claim(key)) return;
    routingUi.claim(`review:${run.id}`);
    if (!live) {
      // Put the card and the board back on what was routed.
      setFrom(run.from_day);
      setTo(run.to_day);
      setWindows(run.windows);
      setPicked(run.staff_ids.length >= techs.length ? new Set() : new Set(run.staff_ids));
      onReviewDay?.(run.from_day);
    }
    if (shown.kind === "ready" && run.result) {
      if (live)
        finishLive(run.id, run.result as unknown as AutoRouteResult, run.from_day, run.to_day);
      else {
        announce(run.result as unknown as AutoRouteResult, run.from_day, run.to_day);
        void offerUndo(run.id);
        void seenFn({ data: { runId: run.id } }).then(() =>
          qc.invalidateQueries({ queryKey: ROUTING_RUNS_KEY }),
        );
      }
    } else {
      toast.error(failureLine(run), { duration: 12000 });
      void seenFn({ data: { runId: run.id } }).then(() =>
        qc.invalidateQueries({ queryKey: ROUTING_RUNS_KEY }),
      );
    }
    // Keyed on the run and its state; the setters and callbacks are stable
    // enough, and re-running on them would only hit the claim and return.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownId, shown.kind]);

  /** A run this card watched has finished: say so, refresh the board, mark
   *  it seen, and close, which is what Apply has always done. */
  function finishLive(runId: string, r: AutoRouteResult, runFrom: string, runTo: string) {
    announce(r, runFrom, runTo);
    void offerUndo(runId);
    qc.invalidateQueries({ queryKey: ["visits"] });
    onApplied();
    void seenFn({ data: { runId } }).then(() =>
      qc.invalidateQueries({ queryKey: ROUTING_RUNS_KEY }),
    );
    onClose();
  }

  // ── UNDO, AS WELL AS THE PREVIEW (#435, #609) ───────────────────────────
  //
  // The preview went on 2026-08-19 and came back on 2026-10-31 (D10), so the
  // dispatcher now sees every move before Apply. Undo stays: it is the way
  // back from a run that was shown and still turned out wrong. Once a run has
  // saved, one line says what it changed, with Undo beside it, which puts
  // back each visit's tech, order and arrival times.
  // The server keeps the offer for 15 minutes and withdraws it the moment
  // anything it would overwrite moves (20261015140000); the toast lasts a
  // minute. Called after the card closes, so it does not hold the card open.
  async function offerUndo(runId: string) {
    // Undo is extra; a failed read leaves the result as it was.
    const s = await undoStateFn({ data: { runId } }).catch(() => null);
    if (!s || !s.available || s.moved === 0) return;
    toast(undoSummaryLine(s.moved, s.techs), {
      duration: undoToastMs(s.expires_at, Date.now()),
      action: { label: "Undo", onClick: () => void runUndo(runId) },
    });
  }

  async function runUndo(runId: string) {
    try {
      const r = await undoFn({ data: { runId } });
      toast.success(
        r.restored === 1 ? "Put 1 visit back as it was." : `Put ${r.restored} visits back as they were.`,
      );
    } catch (e) {
      // The server's own sentence names the reason (expired, changed since).
      toast.error(e instanceof Error ? e.message : undoUnavailableLine(null));
    }
    qc.invalidateQueries({ queryKey: ["visits"] });
    onApplied();
  }

  /** Everything a finished run has to say, as toasts. Unchanged in wording
   *  from when it was the mutation's onSuccess; `from` and `to` are the
   *  run's, which on a review are not necessarily the card's. */
  function announce(r: AutoRouteResult, from: string, to: string) {
    {
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
          // Keeping assignments does not cause this: a kept visit is still
          // put in order. Only a range with no scheduled stops for the people
          // picked does.
          description: "Those days have no scheduled stops for the people you picked.",
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
            description:
              "Usually an address whose coordinates are wrong, or a region the router does not cover.",
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
      // A stop the run could not place at all (2026-10-10): nobody picked can
      // do its service, or no route reaches it inside its window. It was
      // left off every route rather than put somewhere late, so this is the
      // one toast that always needs a hand: assign it yourself, widen the
      // window, or give someone the skill under Users & roles.
      const left = r.unassignable ?? [];
      const leftCount = r.unassignableCount ?? 0;
      if (leftCount > 0) {
        const lines = left.slice(0, 4).map((u) => {
          const who = u.client ?? "A client";
          const when = from !== to ? ` on ${shortDay(u.day)}` : "";
          return u.reason === "no_eligible_tech"
            ? `${who}${when}: nobody on this run does ${u.service ?? "that service"}.`
            : `${who}${when}: no route reaches it between ${u.earliest ?? "…"} and ${u.latest ?? "…"}.`;
        });
        if (leftCount > 4) lines.push(`${leftCount - 4} more.`);
        // With reassign the stop came off its technician too; without it
        // the technician stands and only the order and the times went.
        const fate = r.reassign === false ? "left off the route" : "left unassigned";
        toast.warning(
          leftCount === 1 ? `1 stop was ${fate}.` : `${leftCount} stops were ${fate}.`,
          { description: lines.join(" "), duration: 15000 },
        );
      }
      // Refusals are surfaced, not swallowed. A dispatcher who is not told a
      // day was skipped will believe it was optimized.
      for (const s of r.skipped.slice(0, 3)) toast.warning(s.reason, { duration: 8000 });
      if (r.skipped.length > 3) {
        toast.warning(`${r.skipped.length - 3} more day(s) skipped.`, { duration: 8000 });
      }
    }
  }

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

  // Busy for as long as a run is going, whoever's tab started it. Apply waits;
  // closing does not.
  const busy = applyMut.isPending || activeRun != null;
  const fraction = activeRun ? progressFraction(activeRun) : null;

  const dateLabel = from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`;
  const techLabel =
    picked.size === 0
      ? "All techs"
      : picked.size === 1
        ? (techs.find((s: any) => picked.has(s.id))?.display_name ?? "1 tech")
        : `${picked.size} techs`;

  return (
    <div
      ref={cardRef}
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
      className="fixed inset-x-3 bottom-3 z-40 max-h-[min(32rem,calc(100dvh-6rem))] overflow-y-auto rounded-lg border bg-card shadow-xl max-md:bottom-[calc(var(--tab-bar-h)+env(safe-area-inset-bottom)+0.75rem)] max-md:max-h-[calc(100dvh-11rem)] sm:left-auto sm:right-4 sm:w-80 sm:max-w-[calc(100vw-2rem)]"
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
            {/* Stacked, not side by side. A native date field is drawn at the
                width of its value and will not go narrower (the owner's
                iPhone measured about 195px, see timesheets.tsx), so two of
                them and "to" in one row of a 320px card ran out of its side
                and gave the card a horizontal scroll (QA row 17). */}
            <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
              <span className="text-2xs text-muted-foreground">From</span>
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
                className="h-8 min-w-0 text-xs touch:min-h-11"
              />
              <span className="text-2xs text-muted-foreground">To</span>
              <Input
                type="date"
                value={to}
                min={from || undefined}
                aria-label="Last day"
                onChange={(e) => setTo(e.target.value)}
                className="h-8 min-w-0 text-xs touch:min-h-11"
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
                  ["honour", "Honor arrival windows"],
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
              The default is in Settings → Scheduling. Kept windows are never missed: a stop no
              route can reach in time is left unassigned and named. Set aside, every miss is listed.
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
                  className="shrink-0 text-2xs text-muted-foreground underline-offset-2 hover:underline touch:min-h-11 touch:px-2"
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

        {/* ── MOVING WORK BETWEEN TECHS IS ASKED FOR, PER RUN (D10, #609) ──
            This control was here once, default off, and was removed on
            2026-08-26 on the argument that selecting a tech was consent to
            have their whole day rearranged. It was not: it let Apply move a
            visit that was assigned by hand for a reason the planner cannot
            see. So it is back, off by default, off again every time the card
            opens, and never stored. Off still does useful work: unassigned
            visits are given out and every route is put in order; only who
            already has what stays. A visit pinned in the visit drawer stays
            with its tech even when this is on. */}
        <button
          role="switch"
          aria-checked={reassign}
          onClick={() => setReassign(!reassign)}
          disabled={busy || previewMut.isPending}
          className={`flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-start text-2xs touch:min-h-11 ${reassign ? "border-primary bg-primary/10" : "hover:bg-muted"}`}
        >
          <span
            aria-hidden
            className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${reassign ? "border-primary bg-primary text-primary-foreground" : ""}`}
          >
            {reassign && <Check className="h-3 w-3 shrink-0" />}
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-foreground">
              Also move visits between techs
            </span>
            <span className="block text-muted-foreground">
              {reassign
                ? "This run only. Visits pinned to a tech still stay put."
                : "Off: everyone keeps the visits they have. Unassigned visits are given out and each route is put in order."}
            </span>
          </span>
        </button>

        {preview && <PreviewList preview={preview} reassign={reassign} fullName={fullName} />}
      </div>

      {busy && (
        <div role="status" aria-live="polite" className="space-y-1.5 border-t px-3 py-2">
          <div className="flex items-center gap-1.5 text-2xs font-medium">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span className="min-w-0 truncate">{stageLine(activeRun)}</span>
          </div>
          {fraction != null && (
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="hs-meter h-full bg-primary"
                style={{ "--hs-meter": `${Math.round(fraction * 100)}%` } as CSSProperties}
              />
            </div>
          )}
          <p className="text-2xs leading-relaxed text-muted-foreground">
            You can close this. It keeps going, and the top bar shows when the routes are ready.
          </p>
        </div>
      )}

      {noStart.length > 0 && (
        <div className="border-t px-3 py-2">
          <p className="text-2xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">
              {noStart.length === 1
                ? `${String(noStart[0].display_name ?? "One technician").split(" ")[0]} has no start address.`
                : `${noStart.length} technicians have no start address.`}
            </span>{" "}
            Their route is planned from their own first stop, so the drive to it counts as nothing
            and they tend to be given more of the day than they can really fit. Adding it under Team
            makes these routes honest.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
        {/* Never disabled now. While a run is going this is how it is sent to
            the background, and the run carries on without the card. */}
        <Button variant="ghost" size="sm" onClick={onClose}>
          {busy ? "Run in background" : "Cancel"}
        </Button>
        {/* Preview first, then Apply (D10, #609). The button is Preview
            until a preview for exactly these inputs is on the card, and Apply
            sends that preview. The input gate is the one it always was: a
            range that runs forwards, and somebody to route. */}
        <Button
          size="sm"
          onClick={() => (preview ? applyMut.mutate() : previewMut.mutate())}
          disabled={!rangeValid || techs.length === 0 || busy || previewMut.isPending}
          title={
            techs.length === 0
              ? "Nobody runs routes yet"
              : !rangeValid
                ? "The last day is before the first"
                : undefined
          }
        >
          {busy
            ? "Planning…"
            : previewMut.isPending
              ? "Previewing…"
              : preview
                ? "Apply"
                : "Preview"}
        </Button>
      </div>
    </div>
  );
}
