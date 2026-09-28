import { createFileRoute, Link } from "@tanstack/react-router";
import { humanizeRole } from "@/lib/humanize";
import { orgLocalDay, orgLocalDayTime, orgLocalTime } from "@/lib/org-day";
import { useOrgTimezone, useOrgToday } from "@/hooks/useOrgToday";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  lazy,
  Suspense,
} from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  getMyDay,
  startVisit,
  completeVisit,
  skipVisit,
  recordVisitPhoto,
  listMyDayFieldStaff,
} from "@/lib/my-day.functions";
import { listAddonServices, createAddonCharge } from "@/lib/addons.functions";
import { getVisitStations, logStationService } from "@/lib/stations.functions";
import { logDnaSampleFromField } from "@/lib/dna.functions";
import { sendVisitStatusSms } from "@/lib/messages.functions";
import { TECH_SKIP_REASON_CODES, SKIP_REASON_LABELS } from "@/lib/skip-rules.functions";
import { useOnline, usePendingCount } from "@/lib/offline/useOnline";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { nativeTopBarStyle } from "@/lib/native-build";
import { useOfflineVisitActions } from "@/lib/offline/useOfflineVisitActions";
import { syncQueue } from "@/lib/offline/sync";
import { startAutoSync, type SyncTrigger } from "@/lib/offline/auto-sync";
import {
  countPendingForVisit,
  countQueuedCompletionPhotos,
  enqueueAction,
  listPending,
} from "@/lib/offline/queue";
import { runOrQueue } from "@/lib/offline/run-or-queue";
import { useQueuedLifecycle } from "@/lib/offline/useQueuedLifecycle";
import { dayAtAGlance } from "@/lib/my-day-progress";
import { withQueuedLifecycle, type LifecycleKind } from "@/lib/offline/queued-visit-state";
import { resolveOfflineUserId } from "@/lib/offline/action-owner";
import {
  describeReadFreshness,
  formatCacheAge,
  READ_CACHE_MAX_AGE_MS,
} from "@/lib/offline/read-cache-policy";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { toast } from "sonner";
import {
  Navigation,
  Calendar as CalendarIcon,
  Camera,
  ChevronDown,
  ChevronUp,
  WifiOff,
  RefreshCw,
  ArrowDown,
  Clock,
  CircleParking,
  Dog,
  Fence,
  KeyRound,
  LockKeyhole,
  Phone,
  Ruler,
  Timer,
  List as ListIcon,
  Map as MapIcon,
  TriangleAlert,
} from "lucide-react";
import { PushToggle } from "@/components/PushToggle";
import { FOCUS_MY_DAY_SCHEDULE_EVENT } from "@/components/MobileTabBar";
// LanguageToggle moved to Settings → Preferences
import { useTranslation } from "react-i18next";
import { haptic } from "@/lib/haptics";
import { useMyRole } from "@/hooks/useMyRole";
import { useTabletTier } from "@/hooks/useTabletTier";
import { useSignedUrl } from "@/hooks/useSignedUrl";
import { YARD_SIZE_LABELS, type YardSizeCategory } from "@/lib/yard-size";
import { CloseOutOpenVisits } from "@/components/CloseOutOpenVisits";

export const Route = createFileRoute("/_authenticated/my-day")({
  // Honor ?date=YYYY-MM-DD deep-links (notifications, bookmarks) instead of
  // silently showing today (P1.8). ?staff=<uuid> lets office roles preview a
  // technician's day read-only.
  validateSearch: (search: Record<string, unknown>): { date?: string; staff?: string } => {
    const out: { date?: string; staff?: string } = {};
    const raw = typeof search.date === "string" ? search.date : undefined;
    if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(new Date(raw).getTime())) {
      out.date = raw;
    }
    const s = typeof search.staff === "string" ? search.staff : undefined;
    if (s && /^[0-9a-f-]{36}$/i.test(s)) out.staff = s;
    return out;
  },
  component: MyDay,
});

// When this app instance started. Anything in the query cache whose
// dataUpdatedAt predates it was restored from the device rather than fetched
// now — that is what separates "today's route" from "the copy on disk".
const SESSION_STARTED_AT = Date.now();

/**
 * How long a fetched station list stays in the query cache — and it is the
 * whole point of the prefetch, not a tuning knob.
 *
 * React Query drops a query five minutes after its last observer goes away, and
 * a prefetched query never has one. So a station list fetched while the truck
 * had signal at 7am was gone from memory by 7:05, `dehydrate` had nothing to
 * write, and the tech reached the property at 11 with an empty panel — the
 * prefetch would have looked like it worked and changed nothing.
 *
 * Held for as long as the device is allowed to keep the day's reads at all
 * (READ_CACHE_MAX_AGE_MS) so memory and disk expire on one rule rather than
 * two: a list that is still on disk is still worth showing, and one that is too
 * old for disk is too old for the panel.
 *
 * `staleTime` only keeps the prefetch from re-firing on every render of the
 * day; opening the panel with signal still refetches, which is what picks up a
 * log another tech filed against the same visit.
 */
const VISIT_STATIONS_CACHE = {
  gcTime: READ_CACHE_MAX_AGE_MS,
  staleTime: 60_000,
} as const;

function MyDay() {
  const { date: dateParam, staff: staffParam } = Route.useSearch();
  const navigate = Route.useNavigate();
  // "Today" is the ORGANIZATION'S today, not the device's. The times on this
  // page speak the org's wall clock (orgLocalTime below), so the day the page
  // opens on has to agree with them: a device-clock today here meant a tech
  // whose phone sits in another timezone — or anyone working the boundary
  // hour — opened tomorrow's list under org-time labels, while dispatch was
  // still bucketing the same visits into today. `null` means "the org's
  // today", resolved at render rather than frozen into state at mount, so it
  // also survives midnight without a stale default.
  const orgTodayIso = useOrgToday();
  const [pickedDay, setPickedDay] = useState<string | null>(dateParam ?? null);
  const day = pickedDay ?? orgTodayIso;
  // Follow in-app navigations that change the search param (e.g. a
  // notification link clicked while already on My Day).
  useEffect(() => {
    if (dateParam) setPickedDay(dateParam);
  }, [dateParam]);
  // Pressing "Today" while already on My Day asks us to focus the day control.
  // Below `md` that is the date chip in the header; the seven-day strip it
  // replaced on 2026-09-14 was a whole 48px row spent on a control that is
  // used a few times a week, on the screen whose entire problem is vertical
  // room. `input` comes first in the query because the chip IS an input --
  // a native date field laid transparently over the styled face, so the day
  // picker a phone already has is the one that opens.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focusStrip = () => {
      const el = stripRef.current;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      const target =
        el.querySelector<HTMLElement>("input") ??
        el.querySelector<HTMLElement>("button[data-selected='true']") ??
        el.querySelector<HTMLElement>("button");
      target?.focus({ preventScroll: true });
    };
    window.addEventListener(FOCUS_MY_DAY_SCHEDULE_EVENT, focusStrip);
    return () => window.removeEventListener(FOCUS_MY_DAY_SCHEDULE_EVENT, focusStrip);
  }, []);

  // Shared day setter: state + ?date= mirror (deep links / tab truthfulness).
  const applyDay = useCallback(
    (next: string) => {
      setPickedDay(next);
      navigate({
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          date: next === orgTodayIso ? undefined : next,
        }),
        replace: true,
      } as any);
    },
    [navigate, orgTodayIso],
  );

  const fn = useServerFn(getMyDay);
  const qc = useQueryClient();
  const online = useOnline();
  // "Saved 4 hr ago" has to keep counting while a tech sits in a dead zone —
  // a frozen age reads as if the app just refreshed.
  //
  // QA-P1: this used to STORE `Date.now()` and pass the stored value to
  // describeReadFreshness. Between ticks it was up to 60 seconds behind, so
  // data fetched after mount had a NEGATIVE age against it — and a negative
  // age is precisely what that function reads as `clockSuspect`, its guard
  // against a device whose clock has stepped backward. The result was the
  // escalated red "this route may have changed — confirm before driving it"
  // banner firing against correct, live, just-fetched data, for the first
  // minute of every single load.
  //
  // The guard is right; it was being fed a clock reading it had no way to know
  // was stale. So the interval now only forces a re-render, and the clock is
  // read at render — there is no stored `now` left to go stale.
  //
  // It matters more than a cosmetic wrong banner. That warning is the app
  // telling a tech standing at a customer's fence not to trust what is on the
  // screen. Firing it on every load is how it stops being read at all, and
  // the one time the route really has changed is the time it is ignored.
  const [, forceAgeRepaint] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => forceAgeRepaint((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const pending = usePendingCount();
  const { t } = useTranslation();
  const { role } = useMyRole();
  const isOfficeRole = role === "owner" || role === "office_manager" || role === "dispatcher";

  // This page has two layers that have to get out of the tab bar's way: the
  // scroll container's bottom padding, and the NEXT UP bar that parks directly
  // on top of the tab bar. Both were written as `max-md:` back when the tab bar
  // was `md:hidden` and that was the only breakpoint in the app. The bar now
  // reaches `lg` for field roles (useTabletTier), so on a 800px crew tablet the
  // tab bar sat on top of NEXT UP and on top of the last visit's Complete
  // button — the exact failure the hook's own comment warns about, in the one
  // place that had not been converted.
  //
  // Reading `barThroughTablet` rather than spelling a breakpoint is what keeps
  // these in step by construction: if the tier ever changes its mind about who
  // keeps the bar, this follows without anyone remembering it exists. Both
  // branches are written out in full because Tailwind scans for literal class
  // names and never sees a string it had to assemble.
  const { barThroughTablet } = useTabletTier();
  // 7rem clears the NEXT UP bar on its own; the wider value adds the tab bar's
  // 3.5rem on top of it, for exactly as long as the tab bar is on screen.
  const belowTabBarPadding = barThroughTablet
    ? "pb-[calc(7rem+env(safe-area-inset-bottom))] max-lg:pb-[calc(10.5rem+env(safe-area-inset-bottom))]"
    : "pb-[calc(7rem+env(safe-area-inset-bottom))] max-md:pb-[calc(10.5rem+env(safe-area-inset-bottom))]";
  const nextUpAboveTabBar = barThroughTablet
    ? "max-lg:bottom-[calc(3.5rem+env(safe-area-inset-bottom))] max-lg:pb-0"
    : "max-md:bottom-[calc(3.5rem+env(safe-area-inset-bottom))] max-md:pb-0";

  const { data, isLoading, isError, dataUpdatedAt, refetch } = useQuery({
    queryKey: ["my-day", day, staffParam ?? ""],
    queryFn: () => fn({ data: staffParam ? { day, staffId: staffParam } : { day } }),
  });

  // Mobile Phase 3 offline hardening: this response is one of the few written
  // to the device (lib/offline/read-cache-policy.ts) and restored on launch, so
  // `data` here can be a copy fetched hours ago. Whether that is what the tech
  // is looking at right now is not something they can be left to guess — a
  // silently stale route is how someone drives to yesterday's houses.
  const freshness = describeReadFreshness({
    hasData: !!data,
    dataUpdatedAt,
    isError,
    online,
    // `now` is deliberately NOT passed. It defaults to a live Date.now()
    // inside describeReadFreshness — see the note on that parameter, and on
    // forceAgeRepaint above, for why a stored clock reading here produced a
    // red warning against correct data.
    sessionStartedAt: SESSION_STARTED_AT,
  });
  const previewing = !!data?.previewing;

  // Office/dispatch users: fetch the field-staff list so we can show a picker.
  const staffListFn = useServerFn(listMyDayFieldStaff);
  const staffList = useQuery({
    queryKey: ["my-day", "field-staff"],
    queryFn: () => staffListFn(),
    enabled: isOfficeRole,
    staleTime: 60_000,
  });
  const fieldStaff = staffList.data?.staff ?? [];

  // Bind server-fn callers once for the sync driver.
  const startFn = useServerFn(startVisit);
  const completeFn = useServerFn(completeVisit);
  const skipFn = useServerFn(skipVisit);
  const photoFn = useServerFn(recordVisitPhoto);
  const stationFn = useServerFn(logStationService);
  const callers = useMemo(
    () => ({
      startVisit: startFn,
      completeVisit: completeFn,
      skipVisit: skipFn,
      recordVisitPhoto: photoFn,
      logStationService: stationFn,
    }),
    [startFn, completeFn, skipFn, photoFn, stationFn],
  );

  // Client names for the two messages that ask a tech to go back and redo
  // work. Held in a ref rather than closed over, because `visits` is derived
  // below `runSync` and putting it in the dependency array would rebuild the
  // sync driver on every refetch.
  const visitNames = useRef<Map<string, string>>(new Map());
  /** "Bark Park and 2 others", or nothing when we cannot name any of them.
   *  A queued action can outlive the day it belongs to -- it survives the app
   *  being killed in a pocket -- so an id with no row today is expected and
   *  simply contributes no name. */
  const namesFor = useCallback((ids: string[]): string | undefined => {
    const named = ids.map((id) => visitNames.current.get(id)).filter(Boolean) as string[];
    if (named.length === 0) return undefined;
    if (named.length === 1) return named[0];
    if (named.length === 2) return `${named[0]} and ${named[1]}`;
    return `${named[0]} and ${named.length - 1} others`;
  }, []);

  const runSync = useCallback(
    async (trigger: SyncTrigger) => {
      // Replay only the signed-in tech's own queued work — see lib/offline/queue.
      //
      // resolveOfflineUserId, NOT supabase.auth.getSession(). getSession reads
      // local storage EXCEPT when the stored token has expired, in which case
      // supabase-js refreshes it over the network first — which offline hangs for
      // ever, with no deadline here to stop it. That is the exact defect
      // action-owner.ts was written to eliminate, and this call site was still
      // making it: 7am, token aged out overnight, one bar in the yard so
      // navigator.onLine is true, and Sync does nothing for ever with no toast.
      //
      // Worse, the BADGE already used the bounded resolver, so the count said "6
      // pending" while the button it labels could not act at all — breaking the
      // one invariant countPending exists to hold: the count and the thing the
      // button acts on have to be the same set.
      let uid: string;
      try {
        uid = await resolveOfflineUserId();
      } catch {
        return;
      }
      const res = await syncQueue(callers, uid);
      if (res.alreadyRunning) {
        // A replay is already in flight. Saying nothing is indistinguishable from
        // a dead button -- so the BUTTON is told. An automatic run (mount, back
        // online) is not a request anybody made, and the replay in flight is
        // already doing its job; telling the tech "Already syncing…" on opening
        // the page, with nothing queued, was noise. See lib/offline/auto-sync.
        if (trigger === "tap") toast.info("Already syncing…");
        return;
      }
      if (res.succeeded > 0) {
        toast.success(`Synced ${res.succeeded} queued action${res.succeeded === 1 ? "" : "s"}`);
        qc.invalidateQueries({ queryKey: ["my-day"] });
      }
      if (res.dropped > 0) {
        // Never folded into the success count: this is a photo whose bytes are
        // gone, and the tech is the only person who can retake it.
        toast.error(
          `${res.dropped} queued photo${res.dropped === 1 ? "" : "s"} could not be recovered from this device. Retake if the visit still needs one`,
          { description: namesFor(res.droppedVisitIds) },
        );
        qc.invalidateQueries({ queryKey: ["my-day"] });
      }
      if (res.deadLettered > 0) {
        // Loud, specific, and never folded into any other count. The queue was
        // blocking everything behind this; giving up unblocks the day, but the
        // work itself is gone and only the tech can redo it.
        //
        // And it now NAMES the stop. This is the one message in the app that
        // asks somebody to drive somewhere a second time, and it used to end
        // "Check the visit and redo it if needed" without saying which visit --
        // on a twenty-stop day, with the queue already emptied of the evidence.
        toast.error(
          `${res.deadLettered} queued action${res.deadLettered === 1 ? "" : "s"} the server kept refusing ${res.deadLettered === 1 ? "has" : "have"} been discarded so the rest could sync. Go back and redo the work if it still needs doing`,
          { duration: 12_000, description: namesFor(res.deadLetteredVisitIds) },
        );
        qc.invalidateQueries({ queryKey: ["my-day"] });
      }
      if (res.failed > 0) {
        toast.error(`Sync stalled on 1 action, will retry`);
      }
    },
    [callers, qc, namesFor],
  );

  // Auto-sync on load + whenever we come back online. Once per REAL mount: the
  // replay on mount is scheduled and the cleanup cancels it, so StrictMode's
  // rehearsal mount (and a tab flicked away from at once) starts nothing. Not
  // into a dead zone either: startAutoSync asks isDefinitelyOffline when the
  // timer fires.
  useEffect(() => startAutoSync(runSync, window, isDefinitelyOffline), [runSync]);

  // The day AS WORKED, not just as the server last described it: every queued
  // Start, Complete and Skip applied on top. Before this, an offline Complete
  // was queued correctly and changed nothing the page read -- the card stayed
  // "in progress" with Complete live (a second tap queued a second
  // completion), the count did not move, and the bottom bar kept saying
  // "IN PROGRESS · Resume" about a job that was finished. Everything below
  // reads `visits`, so the count, the next stop, the bottom bar and the map
  // all move on together. See lib/offline/queued-visit-state.ts.
  const queuedLifecycle = useQueuedLifecycle(dataUpdatedAt);
  const serverVisits = data?.visits;
  const visits = useMemo(
    () => withQueuedLifecycle(serverVisits ?? [], queuedLifecycle),
    [serverVisits, queuedLifecycle],
  );
  // List or map. Not in the URL: it is a way of looking at the day, not a
  // different day, and a tech who taps Map then reloads in a dead spot should
  // get the list back rather than a grey tile grid.
  const [view, setView] = useState<"list" | "map">("list");
  // Kept current for namesFor above. Written during render rather than in an
  // effect: a sync can fire from the online listener before an effect has run,
  // and a toast that says "and 2 others" with no names is worse than one that
  // says nothing.
  visitNames.current = new Map(
    visits.map((v: { id: string; clients?: { display_name?: string | null } | null }) => [
      v.id,
      v.clients?.display_name ?? "a visit",
    ]),
  );
  const staff = data?.staff;

  // ── the read half of the same basement garage ────────────────────────────
  //
  // Logging a station survives a dead zone now (runOrQueue → IndexedDB →
  // syncQueue). Seeing which stations there are did not, and a queue is worth
  // nothing if the tech never gets a row to press.
  //
  // "visit-stations" has been on the offline allowlist since the read cache was
  // written, which made this look covered and is why it went unnoticed: the
  // allowlist says what MAY be persisted, not what ever gets fetched. The query
  // lives inside StationsSubpanel, the subpanel is rendered only while
  // `showStations`, and a tech taps Stations when they are standing at the
  // stations — under an apartment complex, with no signal. So the one fetch
  // that could have filled the cache was always attempted from the one place it
  // could not succeed, and the allowlisted entry was never written.
  //
  // Prefetching here moves that fetch to the morning, on the run through the
  // day list, where the truck still has a bar. Only the commercial and
  // multi-unit stops — the same test the Stations button itself uses, because a
  // residential property has no stations and fetching one per house would spend
  // the device's whole byte budget proving it.
  const stationsFn = useServerFn(getVisitStations);
  const dayVisits = data?.visits;
  useEffect(() => {
    // Offline this would only mint a failed query per commercial stop, and a
    // failed query is not persisted — it would evict nothing and fix nothing.
    if (!online || !dayVisits) return;
    type Stop = { id: string; properties?: { account_type?: string; has_units?: boolean } | null };
    for (const v of dayVisits as Stop[]) {
      const prop = v?.properties;
      if (!(prop?.account_type === "commercial" || prop?.has_units)) continue;
      void qc.prefetchQuery({
        queryKey: ["visit-stations", v.id],
        queryFn: () => stationsFn({ data: { visitId: v.id } }),
        ...VISIT_STATIONS_CACHE,
      });
    }
  }, [online, dayVisits, qc, stationsFn]);

  // Counted from `visits`, which already carries the queued statuses, so an
  // offline Complete moves the count and promotes the next stop. The rules
  // (H1: skipped is not done; BUG-17: an open job outranks the next scheduled
  // one) live in lib/my-day-progress.ts, where they are tested.
  const { completedCount, skippedCount, total, pct, activeVisit, nextUp } = dayAtAGlance(visits);

  // ...and bring it back on screen without the tech hunting for it. Scrolls
  // once per open visit, not on every render, so it never fights a tech who has
  // deliberately scrolled elsewhere. Guarded on the id so re-renders and
  // background refetches don't yank the viewport back.
  const activeVisitId = activeVisit?.id as string | undefined;
  useEffect(() => {
    if (!activeVisitId) return;
    // The list renders after this effect's first run on a cold load, so wait a
    // frame for the anchor to exist rather than querying a DOM that isn't there.
    const raf = requestAnimationFrame(() => {
      document
        .getElementById(`visit-${activeVisitId}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeVisitId]);

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;

  // Fetch failed and nothing is cached for this day — say so plainly instead
  // of falling through to the misleading "not linked to a staff record" state.
  if (isError && !data)
    return (
      <div className="space-y-3 py-10 text-center">
        <WifiOff className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Couldn't load this day{online ? "" : " (you're offline)"}, and no synced copy is saved on
          this device.
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );

  return (
    // The bottom padding is what keeps the LIST clear of the two bars pinned
    // to the bottom of the screen. The map does not need it and must not have
    // it: the map sizes itself to stop exactly above those bars, so 10.5rem of
    // padding underneath it is 168px of empty page below a map that already
    // ends where it should — which is precisely the "I have to scroll to see
    // the whole map" the view was reported for. Measured at 360x800: the page
    // was 1002px tall inside an 800px viewport, and 168 of the 202 was this.
    <div className={`-mx-4 -my-6 ${view === "map" ? "pb-0" : belowTabBarPadding}`}>
      {/* BUILD-11: a visit started on an earlier day (or before today's workday
          ended) that was never closed. Asks the tech what happened rather than
          guessing — nothing here completes anything on its own. */}
      <CloseOutOpenVisits />
      {/* Sticky, blurred top bar — feels like a native nav.
          `top` is the impersonation banner's measured height, 0 when there is
          no banner: both are sticky to the same edge and the banner wins on
          z-index, so a fixed top-0 here vanished under it. */}
      <div
        className="sticky top-[var(--hs-banner-h,0px)] z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60"
        // Sizes to its content, so no height override — see nativeTopBarStyle.
        style={nativeTopBarStyle()}
      >
        <div className="space-y-3 px-4 py-3">
          {(!online || pending > 0) && (
            <div
              className={`flex items-center justify-between gap-3 rounded-lg border p-2.5 text-sm animate-fade-in ${
                online
                  ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : "border-destructive/50 bg-destructive/10 text-destructive"
              }`}
            >
              <div className="flex items-center gap-2">
                {!online && <WifiOff className="h-4 w-4" />}
                <span className="font-medium">
                  {!online ? t("common.offline") : t("common.online")}
                  {pending > 0 ? ` · ${t("common.pending", { count: pending })}` : ""}
                </span>
              </div>
              {online && pending > 0 && (
                <button
                  onClick={() => {
                    haptic("tap");
                    runSync("tap");
                  }}
                  className="inline-flex min-h-9 items-center gap-1 rounded-md border border-current px-3 py-1 text-xs font-medium active:scale-95 transition-transform"
                >
                  <RefreshCw className="h-3 w-3" /> {t("common.sync")}
                </button>
              )}
            </div>
          )}

          {/* Read-only offline fallback (Phase 3): what is on screen was not
              fetched just now — either the device is offline or the refresh
              failed — so it is labelled with WHEN it was fetched. Past the
              trust horizon the wording escalates from "saved copy" to a
              warning, because a route that old has probably been re-sequenced
              and driving off it sends the tech to the wrong houses. */}
          {freshness?.status === "cached" && (
            <div
              className={`flex items-center justify-between gap-3 rounded-lg border p-2.5 text-sm animate-fade-in ${
                freshness.beyondTrustHorizon
                  ? "border-destructive/50 bg-destructive/10 text-destructive"
                  : "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {online ? (
                    <RefreshCw className="h-4 w-4 shrink-0" />
                  ) : (
                    <WifiOff className="h-4 w-4 shrink-0" />
                  )}
                  <span className="font-medium">
                    {online ? "Couldn't refresh" : "Offline"}: saved copy,{" "}
                    {formatCacheAge(freshness.ageMs)}
                  </span>
                </div>
                <div className="pl-6 text-xs opacity-90">
                  Last updated{" "}
                  {new Date(freshness.fetchedAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  {freshness.beyondTrustHorizon
                    ? " . This route may have changed. Confirm before driving it."
                    : ""}
                </div>
              </div>
              <button
                onClick={() => {
                  haptic("tap");
                  refetch();
                }}
                className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md border border-current px-3 py-1 text-xs font-medium active:scale-95 transition-transform"
              >
                <RefreshCw className="h-3 w-3" /> Retry
              </button>
            </div>
          )}

          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-bold tracking-tight md:text-xl md:font-semibold">
                {t("myDay.title")}
              </h1>
              {/* Your own name under your own heading is noise, and it cost a
                  line on the one screen that has none to spare. It is still
                  drawn for the two cases that are NOT "this is me": an office
                  role previewing a technician, and an account with no staff
                  record, where the line is the explanation. */}
              {previewing || !staff ? (
                <p className="truncate text-xs text-muted-foreground">
                  {staff
                    ? `${staff.display_name}${staff.role ? ` · ${humanizeRole(staff.role)}` : ""}`
                    : t("myDay.notOnStaff")}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* Icon-only below `md`: the words cost 149px in a row that also
                  carries the page heading and the day chip, and at 320px the
                  heading lost. The full-width version returns on a laptop. */}
              <PushToggle compact />

              {/* The day control below `md`. A native date input laid
                  transparently over a styled face: the phone opens the picker
                  it already has, the control is a real form field for the
                  keyboard and for screen readers, and nothing here reimplements
                  a calendar. `pointer-events-none` on the face so the tap
                  always lands on the input beneath it. */}
              <div ref={stripRef} className="relative shrink-0 md:hidden">
                <div className="pointer-events-none flex min-h-11 items-center gap-2 rounded-lg border bg-background pl-3 pr-2">
                  <CalendarIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="whitespace-nowrap text-sm font-medium">
                    {/* The weekday is the first 47px to go, and only below
                        360px. At 320 the heading and the chip cannot both have
                        what they want, and a date without its weekday is still
                        a date -- whereas "My d…" is not a heading. Every real
                        phone in the 360-430 band keeps the full label. */}
                    <span className="max-[359px]:hidden">
                      {new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
                        weekday: "short",
                      })}
                      {", "}
                    </span>
                    {new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </div>
                <input
                  type="date"
                  aria-label="Pick a day"
                  value={day}
                  onChange={(e) => {
                    const v = e.target.value;
                    applyDay(v && !Number.isNaN(new Date(v).getTime()) ? v : orgTodayIso);
                  }}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
              </div>

              {/* Desktop keeps the raw date input; below `md` the 7-day strip
                  (below) is the date control (Mobile Phase 2). */}
              <input
                type="date"
                value={day}
                onChange={(e) => {
                  // Clearing the field (Backspace/Delete) yields an empty value.
                  // Fall back to today instead of passing "" downstream, which
                  // rendered the same "not linked to a staff record" screen as a
                  // genuinely unlinked account and alarmed techs (finding #18).
                  const v = e.target.value;
                  const next = v && !Number.isNaN(new Date(v).getTime()) ? v : orgTodayIso;
                  // Mirror the day into ?date= (like ?staff= below) so deep
                  // links and the mobile Today/Schedule tabs stay truthful.
                  applyDay(next);
                }}
                // 40px, and visible on every iPad — `max-md:hidden` only
                // hides it below 768px, where the 7-day strip takes over.
                // A tablet gets this control and a finger, so it needs the
                // height a finger needs.
                className="h-10 rounded-md border bg-background px-2 text-sm max-md:hidden touch:h-11"
              />
            </div>
          </div>

          {total > 0 && (
            <div className="flex items-center gap-2">
              {/* PROGRESS LEFT, VIEW RIGHT.
                  The toggle used to lead the row and the progress followed it,
                  which put the control first and the fact second. The number
                  is what a technician reads at a glance between driveways; the
                  toggle is pressed a few times a day. min-w-0 so the pill
                  yields to the toggle rather than pushing it off the edge. */}
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted/60 px-3 py-2">
                <div className="min-w-0 shrink-0 truncate text-xs font-medium">
                  {completedCount} {t("common.of")} {total} {t("common.done")}
                  {skippedCount > 0 && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      · {skippedCount} skipped
                    </span>
                  )}
                </div>
                {/* The bar is the one thing here allowed to give up width, so
                    it is the only flex item without shrink-0. At 320px it
                    narrows to a sliver and the two numbers stay readable,
                    which is the right way round: the bar restates the
                    percentage, the percentage does not restate the bar. */}
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted-foreground/20">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="shrink-0 text-xs font-medium text-muted-foreground">{pct}%</div>
              </div>

              {/* Labelled, not icon-only. "List" and "Map" next to the glyph
                  cost about 60px and remove the guess; the icons alone were a
                  list and a folded map, which are not far apart at 16px. Still
                  44px tall -- the height is now the padding plus the label
                  rather than a fixed square, so min-h-11 states it outright. */}
              <div className="flex shrink-0 rounded-lg border p-0.5" role="group" aria-label="View">
                {(["list", "map"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={view === v}
                    onClick={() => {
                      haptic("tap");
                      setView(v);
                    }}
                    className={`inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors ${
                      view === v
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {v === "list" ? (
                      <ListIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    ) : (
                      <MapIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    )}
                    {v === "list" ? "List" : "Map"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isOfficeRole && fieldStaff.length > 0 && (
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <label htmlFor="my-day-staff" className="shrink-0 text-muted-foreground">
                Viewing:
              </label>
              <select
                id="my-day-staff"
                value={staffParam ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  navigate({
                    search: (prev: Record<string, unknown>) => ({ ...prev, staff: v || undefined }),
                    replace: true,
                  } as any);
                }}
                // MEASURED 2026-08-19: 332px wide, right edge at 407px in a
                // 360px viewport, and 36px tall. A `<select>` with no width
                // sizes itself to its LONGEST OPTION — here a technician's
                // full name plus their role — so this grew with the team and
                // nothing in the class list ever said how wide it would be.
                // `min-w-0 max-w-full` lets it take the space it is given and
                // clip the label; the open list is unaffected and still shows
                // every name in full.
                className="h-9 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm touch:min-h-11"
              >
                <option value="">
                  {data?.staff && !previewing ? "My day" : "(Select technician)"}
                </option>
                {fieldStaff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name}
                    {s.role ? ` · ${humanizeRole(s.role)}` : ""}
                  </option>
                ))}
              </select>
              {previewing && (
                <span className="rounded-full border px-2 py-0.5 text-3xs uppercase tracking-wide text-muted-foreground">
                  Preview · read-only
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3 px-4 pt-4">
        {!staff && !isOfficeRole && (
          <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
            {t("myDay.unlinkedStaff")}
          </div>
        )}

        {!staff && isOfficeRole && (
          <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
            {fieldStaff.length === 0
              ? "No active technicians in your organization yet."
              : "Pick a technician above to preview their day."}
          </div>
        )}

        {staff && visits.length === 0 && (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            <p>
              {previewing
                ? `${staff.display_name} has nothing scheduled on ${day}.`
                : t("myDay.nothingScheduled")}
            </p>
            <Button asChild variant="outline" size="sm" className="mt-4">
              {/* /routes is OFFICE-ONLY. ROUTE_ROLES does not grant it to a
                  tech, so RoleGuard bounced them straight back here with a red
                  "You don't have access to that page" — the only action on the
                  screen was a dead end for the only role the screen is for.
                  /my-schedule is their own forward view and they can open it. */}
              <Link to="/my-schedule">View my schedule</Link>
            </Button>
          </div>
        )}

        {view === "map" ? (
          <MyDayMap
            visits={visits}
            staffName={data?.staff?.display_name ?? "My route"}
            onVisitClick={(id) => {
              // Back to the list, at that stop. A pin answers "where", the
              // card answers "what do I do here", and a tech tapping a pin is
              // asking the second question.
              setView("list");
              requestAnimationFrame(() => {
                document.getElementById(`visit-${id}`)?.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                });
              });
            }}
          />
        ) : (
          <ol className="space-y-3">
            {visits.map((v: any, idx: number) => (
              <VisitCard key={v.id} visit={v} index={idx + 1} day={day} preview={previewing} />
            ))}
          </ol>
        )}
      </div>

      {/* Sticky bottom "Next up" action bar. Wherever the MobileTabBar is on
          screen this sits directly on top of it (the bar is 3.5rem + safe-area
          inset), and the tab bar already absorbs the safe-area, so no extra
          inset is added on that branch. Which widths those are is the tier's
          call, not a fixed breakpoint — see nextUpAboveTabBar above. */}
      {nextUp && (
        <div
          /* `inset-x-0` is the VIEWPORT, but from md up the sidebar is a fixed
             16rem column at left-0 with z-10 — and this bar is z-40, so it was
             drawn straight over it. Measured 2026-08-25: at 768 it buried
             Analytics, Needs review and the account/sign-out row; at 1024,
             Invoices and the account row. The inner mx-auto then centred the
             text on the viewport rather than the content column, so "NEXT UP"
             straddled the sidebar edge.

             Starting at the sidebar's own width variable fixes both at once —
             the bar spans the content column and mx-auto centres within it.
             When the rail is collapsed to icons the var still reads 16rem, so
             the bar starts slightly inboard of the rail; a small gap, never an
             overlap, and the navigation stays reachable either way. */
          data-bottom-chrome=""
          className={`fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-background/70 animate-fade-in md:left-(--sidebar-width) ${nextUpAboveTabBar}`}
        >
          <a
            href={`#visit-${nextUp.id}`}
            onClick={() => haptic("select")}
            className="mx-auto flex max-w-lg items-center justify-between gap-3 px-4 py-3 active:opacity-70"
          >
            <div className="min-w-0">
              {/* BUG-17: an open job is not "next up" — saying so invites the
                  tech to start a second visit on top of one already running. */}
              <div
                className={`text-3xs font-medium uppercase tracking-wide ${
                  activeVisit ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"
                }`}
              >
                {activeVisit ? t("myDay.inProgress") : t("myDay.nextUp")} · #{nextUp.sequence ?? ""}
              </div>
              <div className="truncate text-sm font-semibold">{nextUp.clients?.display_name}</div>
            </div>
            <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-md">
              {activeVisit ? t("myDay.resume") : t("myDay.jump")} <ArrowDown className="h-4 w-4" />
            </div>
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * The whole day on one map.
 *
 * The route was only ever a vertical list of cards, so "where am I going after
 * this" meant scrolling and reading addresses. This is the same visits, in the
 * same order, with the driving order drawn between them — see RouteMap, which
 * the office dispatch board already uses for exactly this and which techs had
 * no way to reach.
 *
 * LOADED ON DEMAND. Leaflet plus its CSS and marker images is real weight, and
 * a technician who never opens the map should never pay for it — this screen is
 * the one that has to work on a cold start in a van. `React.lazy` keeps it out
 * of the My Day chunk until the toggle is pressed.
 */
const RouteMapLazy = lazy(() =>
  import("@/components/RouteMap").then((m) => ({ default: m.RouteMap })),
);

function MyDayMap({
  visits,
  staffName,
  onVisitClick,
}: {
  visits: any[];
  staffName: string;
  onVisitClick: (visitId: string) => void;
}) {
  const mappable = visits.filter(
    (v) => v.properties?.latitude != null && v.properties?.longitude != null,
  );

  // ── THE MAP IS AS TALL AS THE ROOM IT HAS, AND NOT A PIXEL MORE ──────────
  //
  // It used to be a flat 460px on a phone, 520 above `md`. On the handset this
  // is actually used on, 460px starting below the header runs underneath the
  // Next Up strip and the tab bar, so seeing the bottom of the route meant
  // scrolling the page — on the one view whose entire job is showing the shape
  // of the day at a glance. A map you have to scroll to see is a list.
  //
  // Measured rather than computed from a breakpoint, because the space above
  // it is not a constant: the day strip, the progress bar and the at-a-glance
  // row are always there, an office user previewing a technician gets another
  // row, and the Next Up strip appears only when something is still open. So
  // the gap between this element's own top edge and the highest bar pinned to
  // the bottom is the answer, and every one of those bars carries
  // `data-bottom-chrome` so this does not have to know their names.
  const frameRef = useRef<HTMLDivElement>(null);
  const [mapHeight, setMapHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const el = frameRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      let floor = window.innerHeight;
      for (const bar of document.querySelectorAll<HTMLElement>("[data-bottom-chrome]")) {
        const r = bar.getBoundingClientRect();
        // A bar hidden at this width has no height and must not pull the
        // floor up to zero.
        if (r.height > 0) floor = Math.min(floor, r.top);
      }
      // The 12 is the gap this sits in. NO FLOOR, deliberately, and this was
      // measured rather than reasoned: a 200px minimum put the bottom of the
      // map 62px behind the tab bar at 360x800, which is the same fault as the
      // scrolling in a quieter costume — the map "fits" and you still cannot
      // see the end of the route. A minimum that exceeds the room available
      // can only hide something.
      //
      // So the map is exactly the room there is. On a technician's own phone
      // that is around 460px of a 932px screen. It is smallest for an office
      // user previewing a technician, whose header carries an extra row for the
      // staff picker — and a visibly short map there is TRUE, and says where
      // the space went, which a map tucked under the navigation does not.
      setMapHeight(Math.max(0, Math.round(floor - top - 12)));
    };
    // ── MEASURE UNTIL IT SETTLES, NOT ONCE ──────────────────────────────
    //
    // One measurement at mount is wrong and was: MEASURED at 360x800, the map
    // came out 202px when the room was 126px, and the 76px difference went
    // behind the tab bar. Two things move underneath this after the first
    // paint and neither is a window resize, so neither fires any listener
    // below. The header above grows when the day's data arrives and the
    // at-a-glance row appears. The Next Up strip does not exist at all until
    // there is a visit to be next, and it is 61px, so before it mounts the
    // floor is the tab bar 66px lower down.
    //
    // So measure on every frame for about a second, which is a bounded
    // handful of getBoundingClientRect calls and converges as soon as the
    // layout does — React bails out of an identical setState, so the frames
    // after it settles cost a measurement and nothing else. Deliberately not
    // a ResizeObserver on this element's parent: the parent's height is
    // partly the height being set here, which is a loop.
    let frames = 0;
    let raf = 0;
    const settle = () => {
      measure();
      if (++frames < 60) raf = requestAnimationFrame(settle);
    };
    settle();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);

    // And watch the bars themselves, because they change height without the
    // window changing size. MEASURED: the Next Up strip reads "NEXT UP · #1 /
    // Jump" on a day that has not started and "IN PROGRESS · #3 / Resume" on
    // one that has, and the second is 4px taller. A map measured against the
    // first wording sits 4px behind the second — small, and exactly the fault
    // this is all about, so it is watched rather than rounded away.
    //
    // Only the bars, for the same reason as above.
    const ro = new ResizeObserver(measure);
    for (const bar of document.querySelectorAll("[data-bottom-chrome]")) ro.observe(bar);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
    // Re-measure when the day changes: the Next Up strip is there for a day
    // with work left and gone for a day that is finished, and it is 56px.
  }, [visits.length, mappable.length]);

  // A map with nothing on it is worse than no map: it looks like a failure of
  // the map rather than of the data. Say which it is.
  if (mappable.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
        {visits.length === 0
          ? "Nothing scheduled for this day."
          : "None of today's stops have coordinates yet, so there is nothing to plot. The office can geocode these properties."}
      </div>
    );
  }

  return (
    <div ref={frameRef} className="overflow-hidden rounded-xl border">
      <Suspense
        fallback={
          <div
            className="grid place-items-center bg-muted/30 text-sm text-muted-foreground"
            style={{ height: mapHeight ?? 360 }}
          >
            Loading map...
          </div>
        }
      >
        <RouteMapLazy
          groups={[
            {
              staffId: null,
              name: staffName,
              color: "#2563eb",
              visits: mappable,
            },
          ]}
          // Measured above. The fallback only applies for the single frame
          // before the first measurement lands, and on the server, where
          // there is no viewport to measure.
          height={mapHeight ?? 360}
          drawRoutes
          onVisitClick={onVisitClick}
        />
      </Suspense>
      {mappable.length < visits.length && (
        <div className="border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {visits.length - mappable.length} of {visits.length} stops have no coordinates and are not
          shown.
        </div>
      )}
    </div>
  );
}

/** What the badge says when the status came from the device's queue rather than
 *  the server. "Syncing" rather than "queued": the work is done, the tech can
 *  move on, and the only thing outstanding is the device telling the office. */
const QUEUED_BADGE_LABELS: Record<LifecycleKind, string> = {
  start: "in progress · syncing",
  complete: "done · syncing",
  skip: "skipped · syncing",
};

function statusBadge(status: string, queuedSync?: LifecycleKind) {
  const map: Record<string, string> = {
    scheduled: "bg-muted text-muted-foreground",
    in_progress: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    skipped: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    canceled: "bg-destructive/15 text-destructive",
  };
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${map[status] ?? "bg-muted"}`}
    >
      {queuedSync ? QUEUED_BADGE_LABELS[queuedSync] : status.replace("_", " ")}
    </span>
  );
}

type HazardKey =
  | "do_not_enter_if_dog_out"
  | "aggressive_dog"
  | "escape_risk"
  | "invisible_fence"
  | "bees_wasps"
  | "sharp_objects"
  | "slippery_surfaces"
  | "dog_in_yard_during_service";

const HAZARD_LABELS: Record<HazardKey, { label: string; severity: "critical" | "warn" }> = {
  do_not_enter_if_dog_out: { label: "DO NOT ENTER if dog is outside", severity: "critical" },
  aggressive_dog: { label: "Aggressive dog", severity: "critical" },
  escape_risk: { label: "Escape risk: close gate immediately", severity: "critical" },
  invisible_fence: { label: "Invisible fence", severity: "warn" },
  dog_in_yard_during_service: { label: "Dog in yard during service", severity: "warn" },
  bees_wasps: { label: "Bees / wasps", severity: "warn" },
  sharp_objects: { label: "Sharp objects", severity: "warn" },
  slippery_surfaces: { label: "Slippery surfaces", severity: "warn" },
};

function HazardBanner({ property }: { property: any }) {
  if (!property) return null;
  const active = (Object.keys(HAZARD_LABELS) as HazardKey[]).filter((k) => property[k]);
  const notes = property.hazard_notes as string | undefined;
  if (active.length === 0 && !notes) return null;
  const critical = active.filter((k) => HAZARD_LABELS[k].severity === "critical");
  const warn = active.filter((k) => HAZARD_LABELS[k].severity === "warn");
  return (
    <div className="mb-3 space-y-2">
      {critical.length > 0 && (
        <div className="rounded-md border-2 border-destructive bg-destructive/10 p-3">
          <div className="text-xs font-bold uppercase tracking-wide text-destructive">
            ⚠ Safety warnings: read before entering
          </div>
          <ul className="mt-1 space-y-0.5 text-sm font-semibold text-destructive">
            {critical.map((k) => (
              <li key={k}>• {HAZARD_LABELS[k].label}</li>
            ))}
          </ul>
        </div>
      )}
      {warn.length > 0 && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            {warn.map((k) => (
              <span key={k}>⚠ {HAZARD_LABELS[k].label}</span>
            ))}
          </div>
        </div>
      )}
      {notes && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-800 dark:text-amber-300">
          <span className="font-semibold">Hazard notes:</span> {notes}
        </div>
      )}
    </div>
  );
}

function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const tz = useOrgTimezone();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const startedMs = new Date(startedAt).getTime();
  // An unparseable started_at would render "NaN:NaN" — show nothing instead.
  if (!Number.isFinite(startedMs)) return null;
  const secs = Math.max(0, Math.floor((now - startedMs) / 1000));
  // Sanity cap: a stale/bad started_at (e.g. a visit left in-progress for
  // days) would otherwise tick up to absurd values like "10500:12" (P1.9).
  // Past 8h the elapsed time is no longer useful field info — flag it instead.
  if (secs > 8 * 3600) {
    // Plain type, not the timer's mono: this is a sentence, and mono set it
    // as "8h+,  started  Sun,  Sep  27". The start TIME on the org's clock
    // is the useful fact; the day only when it was not today, since "started
    // Sun, Sep 27" on Sunday the 27th said nothing.
    const sameDay = orgLocalDay(new Date(startedMs), tz) === orgLocalDay(new Date(now), tz);
    return (
      <span className="text-xs text-muted-foreground">
        Over 8h · started {sameDay ? orgLocalTime(startedAt, tz) : orgLocalDayTime(startedAt, tz)}
      </span>
    );
  }
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return (
    <span className="font-mono tabular-nums">
      {m}:{s.toString().padStart(2, "0")}
    </span>
  );
}

function PhotoThumb({
  path,
  onOpen,
  onUrl,
}: {
  path: string;
  /** Opens the in-app viewer. Was `target="_blank"` to a signed storage URL,
   *  which on the phone handed the technician to Safari mid-route — see
   *  PhotoLightbox. */
  onOpen?: () => void;
  /** Reports the signed URL up so the viewer can show it without signing
   *  again. Signing happens once, here, where the thumbnail already needed it. */
  onUrl?: (url: string | null) => void;
}) {
  // Distinguish "still loading" from "can't be shown" so a broken photo shows a
  // clear placeholder instead of the browser's broken-image icon (finding #35).
  const { url, status } = useSignedUrl("visit-photos", path);
  const [imgFailed, setImgFailed] = useState(false);
  const state = imgFailed ? "error" : status;

  useEffect(() => {
    onUrl?.(imgFailed ? null : (url ?? null));
  }, [url, imgFailed, onUrl]);

  if (state === "error") {
    return (
      <div
        className="flex h-14 w-14 flex-col items-center justify-center rounded border bg-muted/50 text-center text-3xs leading-tight text-muted-foreground"
        title="This photo couldn't be loaded. It may not have finished uploading."
      >
        <span>Photo</span>
        <span>unavailable</span>
      </div>
    );
  }
  if (state === "loading" || !url)
    return <div className="h-14 w-14 animate-pulse rounded bg-muted" />;
  return (
    <button
      type="button"
      onClick={onOpen}
      // 56px square: already over the 44px floor, so the thumbnail itself is
      // the target and there is nothing smaller to hit.
      className="block rounded border focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Open photo"
    >
      <img
        src={url}
        alt="Visit"
        className="h-14 w-14 rounded object-cover"
        onError={() => setImgFailed(true)}
      />
    </button>
  );
}

function mapsUrl(p: any): string {
  const q = encodeURIComponent([p?.street, p?.city, p?.postal_code].filter(Boolean).join(", "));
  return `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}

/** "HH:MM[:SS]" wall-clock (property service window) → "8:00 AM". */
function fmtWindowTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${min} ${ampm}`;
}

/** The best per-card time label: a computed ETA if the route was optimized,
 *  else the property's configured service window, else nothing. ETAs are
 *  instants, rendered on the ORG's clock; the window fallback is a `time`
 *  column and stays timezone-free. */
function visitWindowLabel(visit: any, tz: string): string | null {
  if (visit?.eta_start) {
    const start = orgLocalTime(visit.eta_start, tz);
    const end = visit?.eta_end ? orgLocalTime(visit.eta_end, tz) : "";
    if (start) return end ? `ETA ${start}–${end}` : `ETA ${start}`;
  }
  const p = visit?.properties;
  const early = p?.earliest_service_time ? fmtWindowTime(p.earliest_service_time) : "";
  const late = p?.latest_service_time ? fmtWindowTime(p.latest_service_time) : "";
  if (early && late) return `Window ${early}–${late}`;
  if (early) return `After ${early}`;
  if (late) return `By ${late}`;
  return null;
}

const DOG_TEMPERAMENT_LABELS: Record<string, string> = {
  friendly: "friendly",
  nervous: "nervous",
  aggressive: "aggressive",
  unknown: "temperament unknown",
};

function DogsRow({ dogs }: { dogs: any }) {
  const list: any[] = Array.isArray(dogs) ? dogs : dogs ? [dogs] : [];
  if (list.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {list.map((d: any, i: number) => {
        const aggressive = d?.temperament === "aggressive";
        return (
          <span
            key={d?.id ?? d?.name ?? i}
            // text-sm, not text-xs: this is the line that tells somebody what
            // is behind the gate before they open it, and it was set two steps
            // smaller than the client's name.
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm ${
              aggressive
                ? "border-destructive/60 bg-destructive/10 font-semibold text-destructive"
                : "border-border bg-muted/50 text-foreground/80"
            }`}
          >
            {/* A lucide glyph rather than 🐕: an emoji renders in the system
                font at a size this app does not control, ignores currentColor
                so it stays brown inside a red warning chip, and is a different
                picture on every platform. Same reason the clock, parking and
                phone emoji went. */}
            <Dog className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="sr-only">Dog on site:</span>
            {d?.name ?? "Dog"}
            {d?.temperament && (
              <span className="font-normal opacity-80">
                · {DOG_TEMPERAMENT_LABELS[d.temperament] ?? d.temperament}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** One access fact — gate code, lock box, key, yard size.
 *
 *  These were a two-column grid of `text-xs` label/value pairs, which is the
 *  size this app uses for timestamps and footnotes. A gate code is not a
 *  footnote: it is the thing somebody is squinting at, outdoors, holding a
 *  phone in one hand, while a dog barks on the other side of the gate. Codes
 *  are `text-base` and tabular so 0 and O, 1 and l cannot be confused. */
function AccessFact({
  icon: Icon,
  label,
  value,
  mono = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div
          className={`leading-tight ${mono ? "font-mono text-base font-semibold tabular-nums" : "text-sm"}`}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

function VisitCard({
  visit,
  index,
  day,
  preview = false,
}: {
  visit: any;
  index: number;
  day: string;
  preview?: boolean;
}) {
  const qc = useQueryClient();
  const smsFn = useServerFn(sendVisitStatusSms);
  const { role } = useMyRole();
  // Dispatcher schedules/routes but never performs field work — start/complete
  // is silently rejected server-side, which made those buttons look broken.
  // Preview mode (office role viewing another tech's day) also disables actions.
  const canPerformVisit = !preview && role !== "dispatcher";

  const actions = useOfflineVisitActions(visit.id, visit.organization_id as string | undefined);
  // Billing an add-on is the one action on this card that is NOT queued when
  // the signal drops — start/complete/skip/photo all go to IndexedDB, this
  // goes straight to the server. The tech has no way to know that, so the card
  // has to say it. (Q-11 is whether it should queue at all; until that is
  // answered, refusing honestly beats failing with a network error.)
  const cardOnline = useOnline();
  const tz = useOrgTimezone();

  const [showSkip, setShowSkip] = useState(false);
  const [showAddon, setShowAddon] = useState(false);
  const [showStations, setShowStations] = useState(false);
  // Q-5. Only for clients the office has actually enrolled — a sample against
  // a client who never opted in is a record nobody can act on and the client
  // never agreed to. The server refuses it too; this keeps the button from
  // appearing at all.
  const [showDna, setShowDna] = useState(false);
  // The secondary actions, folded away until asked for. Per card, and not
  // remembered: a technician who opened Skip on stop 3 is not asking for it on
  // stop 4, and a card that opens pre-expanded is the busy card again.
  const [showMore, setShowMore] = useState(false);
  const dnaEnrolled = !!visit.clients?.dna_compliance_enabled;
  const [addonSvcId, setAddonSvcId] = useState("");
  const [addonQty, setAddonQty] = useState("1");
  const addonListFn = useServerFn(listAddonServices);
  const addonChargeFn = useServerFn(createAddonCharge);
  const { data: addonSvcData } = useQuery({
    queryKey: ["addon-services"],
    queryFn: () => addonListFn({ data: {} }),
    staleTime: 5 * 60_000,
  });
  const addonServices: any[] = addonSvcData?.services ?? [];
  const addonMut = useMutation({
    mutationFn: () =>
      addonChargeFn({
        data: {
          clientId: visit.client_id,
          addonServiceId: addonSvcId,
          quantity: Math.max(1, parseInt(addonQty, 10) || 1),
          visitId: visit.id,
          source: "field",
        },
      }),
    onSuccess: () => {
      toast.success("Add-on billed");
      setShowAddon(false);
      setAddonSvcId("");
      setAddonQty("1");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState<(typeof TECH_SKIP_REASON_CODES)[number]>("other");
  const [uploading, setUploading] = useState(false);
  const [photoKind, setPhotoKind] = useState<"before" | "completion" | "issue">("completion");
  // Which photo the in-app viewer is showing, and the signed URLs the
  // thumbnails have already fetched. Keyed by photo id rather than index so a
  // photo arriving mid-render cannot shift somebody else's URL onto it.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string | null>>({});
  const setPhotoUrl = useCallback((id: string, url: string | null) => {
    setPhotoUrls((m) => (m[id] === url ? m : { ...m, [id]: url }));
  }, []);
  const [pendingLocal, setPendingLocal] = useState(0);
  // Counted SEPARATELY from pendingLocal. The Complete button is unlocked
  // offline on the strength of a completion photo waiting to sync; it used to
  // be gated on the count of ALL pending actions, so queueing a Start unlocked
  // Complete. The server then refuses ("A completion photo is required"),
  // which is not a network error, so the sync loop breaks on it and every
  // action queued behind it stops for good.
  const [queuedCompletionPhotos, setQueuedCompletionPhotos] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  // Refresh per-visit pending count so cards can show a subtle "queued" chip.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      // Scoped to the signed-in tech, resolved the same bounded way the sync
      // loop resolves it. Unscoped, tech A's queued completion photo unlocked
      // tech B's Complete button on a shared tablet — and B's completion was
      // then refused by the server, burned five attempts and dead-lettered.
      resolveOfflineUserId()
        .then((uid) =>
          Promise.all([
            countPendingForVisit(visit.id, uid),
            countQueuedCompletionPhotos(visit.id, uid),
          ]),
        )
        .then(([pending, photos]) => {
          if (cancelled) return;
          setPendingLocal(pending);
          setQueuedCompletionPhotos(photos);
        })
        .catch(() => {
          // No identity means no queue of our own to report.
          if (cancelled) return;
          setPendingLocal(0);
          setQueuedCompletionPhotos(0);
        });
    };
    refresh();
    window.addEventListener("offline-queue-change", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("offline-queue-change", refresh);
    };
  }, [visit.id]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["my-day", day] });

  const start = useMutation({
    mutationFn: () => actions.start(),
    onSuccess: (r) => {
      haptic("select");
      toast.success(r.queued ? "Queued. Starts when back online" : "Started");
      if (!r.queued) invalidate();
    },
    onError: (e: Error) => {
      haptic("error");
      toast.error(e.message);
    },
  });
  const complete = useMutation({
    mutationFn: () => actions.complete(),
    onSuccess: (r) => {
      haptic("success");
      toast.success(r.queued ? "Queued. Completes when back online" : "Completed");
      if (!r.queued) invalidate();
    },
    onError: (e: Error) => {
      haptic("error");
      toast.error(e.message);
    },
  });
  const skip = useMutation({
    mutationFn: () => actions.skip(reason, reasonCode),
    onSuccess: (r) => {
      haptic("warning");
      toast.success(r.queued ? "Queued. Will skip when back online" : "Marked skipped");
      setShowSkip(false);
      if (!r.queued) invalidate();
    },
    onError: (e: Error) => {
      haptic("error");
      toast.error(e.message);
    },
  });
  const sms = useMutation({
    mutationFn: (kind: "reminder" | "on_my_way" | "completed") =>
      smsFn({ data: { visitId: visit.id, kind } }),
    onSuccess: () => {
      haptic("select");
      toast.success("SMS sent");
    },
    onError: (e: Error) => {
      haptic("error");
      toast.error(e.message);
    },
  });

  const uploadPhoto = async (file: File) => {
    setUploading(true);
    try {
      const r = await actions.uploadPhoto(file, photoKind);
      haptic("tap");
      toast.success(
        r.queued
          ? `${photoKind[0].toUpperCase() + photoKind.slice(1)} photo queued. Uploads when online`
          : `${photoKind[0].toUpperCase() + photoKind.slice(1)} photo uploaded`,
      );
      if (!r.queued) invalidate();
      // Back to the kind that finishes the visit. The picker used to keep
      // whatever was chosen last, so a tech who shot a Before filed every
      // photo after it as a Before too — including the one they took to
      // finish the job. The Complete button stayed locked, the hint below it
      // kept asking for a completion photo, and the only clue that anything
      // was wrong was the word "Before" in a toast that had already gone.
      setPhotoKind("completion");
    } catch (e: any) {
      haptic("error");
      toast.error(e.message ?? "Upload failed");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const photos = useMemo(() => visit.visit_photos ?? [], [visit.visit_photos]);
  const hasCompletionPhoto = photos.some((p: any) => p.kind === "completion");
  // If a completion photo is queued locally, allow "Complete" — the sync
  // driver replays photos first (older ts) then complete (newer ts).
  const hasQueuedCompletionPhoto = queuedCompletionPhotos > 0;
  const done = visit.status === "completed";
  const skipped = visit.status === "skipped";
  const inProg = visit.status === "in_progress";
  const scheduled = visit.status === "scheduled";
  // Auto-marked missed overnight. Still completable — see the note on the
  // Complete button — because the work may well have been done.
  const missed = visit.status === "missed";
  const finalStatus = done || skipped;
  const p = visit.properties;
  // Waste stations only exist on commercial or multi-unit properties. On a
  // residential card there are never any, so the button never appears.
  const hasStations = p?.account_type === "commercial" || !!p?.has_units;

  // The photo control appears in two places — primary once the visit is under
  // way, behind More before that — so it is written once. A FUNCTION and not a
  // component: an inline component is a new type on every render, which would
  // unmount and remount the select and close it under the tech's thumb.
  const photoCapture = () => (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={photoKind}
        onChange={(e) => setPhotoKind(e.target.value as any)}
        // MEASURED 2026-08-19: 40px, four short of the floor, on the
        // screen a technician uses outdoors with gloves on.
        className="h-11 rounded-md border bg-background px-3 text-sm"
        aria-label="Photo type"
      >
        <option value="before">Before</option>
        <option value="completion">Completion</option>
        <option value="issue">Issue</option>
      </select>
      <Button
        type="button"
        variant="outline"
        size="default"
        className="h-11 min-w-0 flex-1"
        disabled={uploading}
        onClick={async () => {
          // Prefer native Capacitor camera when inside the app shell.
          try {
            const { isNative, takePhotoNative } = await import("@/lib/native");
            if (isNative()) {
              const blob = await takePhotoNative();
              if (blob) {
                const file = new File([blob], `photo-${Date.now()}.jpg`, {
                  type: blob.type || "image/jpeg",
                });
                await uploadPhoto(file);
                return;
              }
            }
          } catch {
            /* fall through to web input */
          }
          fileInput.current?.click();
        }}
      >
        <Camera className="mr-1.5 h-4 w-4" />
        {uploading ? "Uploading…" : "Take photo"}
      </Button>
    </div>
  );
  const [collapsed, setCollapsed] = useState(finalStatus);
  useEffect(() => {
    setCollapsed(finalStatus);
  }, [finalStatus]);

  return (
    <li
      id={`visit-${visit.id}`}
      className={`animate-fade-in scroll-mt-40 rounded-xl border bg-card p-4 shadow-sm transition-shadow ${inProg ? "ring-2 ring-blue-500/40 shadow-md" : ""}`}
    >
      {!collapsed && <HazardBanner property={p} />}

      <div className="flex items-start gap-3">
        {/* The stop's place in the route, as a target rather than a `#3` in a
            row of grey footnotes. A technician checking they are at the right
            house reads this and the address, in that order. */}
        <div
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-base font-bold tabular-nums ${
            finalStatus
              ? "bg-muted text-muted-foreground"
              : inProg
                ? "bg-blue-600 text-white"
                : "bg-primary/10 text-primary"
          }`}
          aria-hidden="true"
        >
          {visit.sequence ?? index}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="sr-only">Stop {visit.sequence ?? index}.</span>
            {statusBadge(visit.status, visit.queuedSync)}
            {visit.zones?.name && <span className="truncate">{visit.zones.name}</span>}
            {pendingLocal > 0 && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-3xs font-medium text-amber-700 dark:text-amber-400">
                {pendingLocal} queued
              </span>
            )}
            {inProg && visit.started_at && (
              // Larger + bolder than the meta row: techs read this outdoors
              // in sunlight (P2 field-readiness).
              <span className="inline-flex items-center gap-1 text-sm font-semibold text-blue-700 dark:text-blue-300">
                <Timer className="h-3.5 w-3.5" aria-hidden="true" />
                <ElapsedTimer startedAt={visit.started_at} />
              </span>
            )}
          </div>

          {/* THE ADDRESS LEADS. It was `text-sm text-muted-foreground` under a
              `text-base` client name — the faintest line on the card was the
              one answering "is this the right house". The name still matters
              (it is who you greet, and who you are calling) and keeps the line
              below. */}
          <div className="mt-1 text-lg font-bold leading-tight">
            {p?.street ?? visit.clients?.display_name ?? "Visit"}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {[p?.city, p?.postal_code].filter(Boolean).join(" ")}
            {p?.city || p?.postal_code ? " · " : ""}
            {visit.clients?.display_name ?? "Client"}
          </div>

          {/* When this stop is expected, and how big the yard is — one line of
              context, wrapping rather than stacking.

              Yard size used to sit in the bordered access block below with the
              gate code and the key. It is not a credential: nobody squints at
              "Extra large" through a windscreen, and on a property with no
              code and no key it was the block's only occupant, which drew a
              framed panel around one word. The block is for things you have to
              read correctly to get in. */}
          {(visitWindowLabel(visit, tz) || p?.yard_size) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {visitWindowLabel(visit, tz) && (
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  {visitWindowLabel(visit, tz)}
                </span>
              )}
              {p?.yard_size && (
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Ruler className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {YARD_SIZE_LABELS[p.yard_size as YardSizeCategory] ?? p.yard_size} yard
                </span>
              )}
            </div>
          )}

          {!collapsed && (
            <>
              {/* Dogs on site (H1 safety gap): name + temperament belongs next
                  to hazards, on residential cards too, so the tech knows what
                  they're walking into. */}
              <DogsRow dogs={p?.dogs} />

              {/* Getting in. One block, bordered, at a size that survives
                  sunlight and gloves — see AccessFact. */}
              {(p?.gate_code || p?.lock_box_code || p?.key_location) && (
                <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-lg border bg-muted/30 p-2.5">
                  {p?.gate_code && (
                    <AccessFact icon={Fence} label="Gate" value={p.gate_code} mono />
                  )}
                  {p?.lock_box_code && (
                    <AccessFact icon={LockKeyhole} label="Lock box" value={p.lock_box_code} mono />
                  )}
                  {p?.key_location && (
                    <div className="col-span-2">
                      <AccessFact icon={KeyRound} label="Key" value={p.key_location} />
                    </div>
                  )}
                </div>
              )}
              {p?.parking_notes && (
                <div className="mt-2 flex items-start gap-2 text-sm text-muted-foreground">
                  <CircleParking className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0">{p.parking_notes}</span>
                </div>
              )}
              {p?.access_notes && (
                <div className="mt-1.5 text-sm text-muted-foreground">{p.access_notes}</div>
              )}
              {skipped && (
                <div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  Skipped
                  {/* The TIME it was skipped, which for a queued skip replayed
                      on reconnect is hours before the row was written. Null on
                      every skip recorded before `skipped_at` existed, so it is
                      rendered only when present rather than falling back to a
                      row timestamp that would mean something else. */}
                  {visit.skipped_at ? ` at ${orgLocalTime(visit.skipped_at, tz)}` : ""}
                  {visit.skip_reason_code
                    ? ` (${SKIP_REASON_LABELS[visit.skip_reason_code as keyof typeof SKIP_REASON_LABELS] ?? visit.skip_reason_code})`
                    : ""}
                  {visit.skip_reason ? `: ${visit.skip_reason}` : ""}
                </div>
              )}
            </>
          )}
        </div>

        {finalStatus && (
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? <ChevronDown className="h-5 w-5" /> : <ChevronUp className="h-5 w-5" />}
          </button>
        )}
      </div>

      {/* Navigate and Call, side by side and full width.
          They were stacked in a right-hand column beside the text, which cost
          the address about a third of a 360px card and gave each button
          whatever width was left over. They are the two things a technician
          presses without looking, so they get equal halves of the card and a
          48px height rather than the 40px minimum. */}
      {!collapsed && (p?.street || visit.clients?.primary_phone) && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {p?.street && (
            <a
              href={mapsUrl(p)}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border bg-background px-3 text-sm font-semibold transition-colors hover:bg-accent active:bg-accent ${
                visit.clients?.primary_phone ? "" : "col-span-2"
              }`}
            >
              <Navigation className="h-4 w-4 shrink-0" aria-hidden="true" /> Navigate
            </a>
          )}
          {visit.clients?.primary_phone && (
            <a
              href={`tel:${visit.clients.primary_phone}`}
              className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border bg-background px-3 text-sm font-semibold transition-colors hover:bg-accent active:bg-accent ${
                p?.street ? "" : "col-span-2"
              }`}
            >
              <Phone className="h-4 w-4 shrink-0" aria-hidden="true" /> Call
            </a>
          )}
        </div>
      )}

      {!collapsed && photos.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {photos.map((ph: any, i: number) => (
            <div key={ph.id} className="relative">
              <PhotoThumb
                path={ph.storage_path}
                onOpen={() => setLightboxIndex(i)}
                onUrl={(u) => setPhotoUrl(ph.id, u)}
              />
              <span className="pointer-events-none absolute -bottom-1 -right-1 rounded bg-background px-1 text-3xs uppercase text-muted-foreground shadow-sm">
                {ph.kind}
              </span>
            </div>
          ))}
        </div>
      )}

      <PhotoLightbox
        photos={photos.map((ph: any) => ({ url: photoUrls[ph.id] ?? null, kind: ph.kind }))}
        openIndex={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
      />

      {!preview && !finalStatus && (
        <div className="mt-4 space-y-3">
          {/* ── WHAT THIS STOP NEEDS NEXT, AND NOTHING ELSE ────────────────
              A scheduled stop used to render nine buttons: Start, a greyed-out
              Complete, Skip, + Add-on, Stations, DNA sample, Text reminder,
              Text "on my way", and a photo-type select beside Take photo. Nine
              controls, on a phone, for a technician who has not arrived yet and
              whose next act is one of them.
              Nothing has been taken away — every one of those is still on the
              card, one tap down, under More. What changed is which ones are
              showing before you ask. The rule is the visit's own state: a stop
              you have not started needs Start; a stop in progress needs a photo
              and Complete; everything else is occasional and can wait to be
              asked for. A greyed Complete next to Start was the clearest case —
              it looks pressable, it is not, and the sentence explaining why
              only appears once you have started. */}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadPhoto(f);
            }}
          />

          {scheduled && (
            <Button
              className="h-12 w-full text-base"
              onClick={() =>
                canPerformVisit
                  ? start.mutate()
                  : toast.error(
                      "You're not authorized to start visits. Dispatchers can schedule, but field staff must start the visit.",
                    )
              }
              disabled={start.isPending || !canPerformVisit}
              title={
                canPerformVisit
                  ? ""
                  : "Only field staff (owner, office manager, or tech) can start a visit"
              }
            >
              Start
            </Button>
          )}

          {(inProg || missed) && photoCapture()}

          {/* Complete stays out of the way until it can do something. It is
              enabled for a SCHEDULED visit too — complete_visit has accepted
              ('scheduled','in_progress','missed') since 20260804060000, so a
              tech who did the work without pressing Start can still close it —
              which is why a completion photo on a scheduled stop brings the
              button back rather than stranding the work behind Start. */}
          {(inProg || missed || hasCompletionPhoto || hasQueuedCompletionPhoto) && (
            <Button
              variant="default"
              className="h-12 w-full text-base"
              disabled={
                !canPerformVisit ||
                (!hasCompletionPhoto && !hasQueuedCompletionPhoto) ||
                complete.isPending ||
                // `missed` belongs here. complete_visit has accepted
                // ('scheduled','in_progress','missed') since 20260804060000 --
                // widened deliberately, so a tech who did the work and forgot
                // to close it can come back to yesterday and record it. The
                // button never learned, so both Start and Complete were dead
                // on those cards with nothing on screen saying why. There are
                // 2,001 missed visits in production.
                (!inProg && !scheduled && !missed)
              }
              onClick={() =>
                canPerformVisit
                  ? complete.mutate()
                  : toast.error(
                      "You're not authorized to complete visits. Dispatchers can schedule, but field staff must complete the visit.",
                    )
              }
              title={
                !canPerformVisit
                  ? "Only field staff (owner, office manager, or tech) can complete a visit"
                  : hasCompletionPhoto || hasQueuedCompletionPhoto
                    ? ""
                    : "Add a completion photo first"
              }
            >
              Complete
            </Button>
          )}
          {/* The reason Complete is grey, UNDER Complete. It lived at the
              bottom of the card, below More options, where the Resume strip
              covers it on the in-progress stop, and the button's own `title`
              is a hover tooltip, which a phone does not have. Shown only when
              the button is on screen and the photo is the one thing missing. */}
          {(inProg || missed) &&
            canPerformVisit &&
            !hasCompletionPhoto &&
            !hasQueuedCompletionPhoto && (
              <p className="-mt-1 text-center text-xs text-muted-foreground">
                Take a completion photo to finish this visit.
              </p>
            )}

          {missed && (
            <p className="text-xs text-muted-foreground">
              Marked missed overnight. If you did the work, you can still complete it here and it
              will be recorded late.
            </p>
          )}

          {/* Logging the work itself.
              Stations stays primary on any property that has them, in every
              state, because on a commercial site the station list IS the card's
              content rather than a step in the visit — and because the button's
              only condition is the PROPERTY. It is deliberately not gated on
              `canPerformVisit`: a dispatcher cannot start or complete a visit
              but log_station_service authorises them through can_write_org, so
              gating it would take away a real capability to tidy a different
              problem. `tests/a-read-only-preview-that-wrote-a-station-log`
              pins that, and pins it by reading the 400 characters in front of
              this onClick — which is why the DNA button, which IS gated, sits
              after it and not in a shared condition above it.
              A DNA sample is taken during the visit, so that one is state-shaped
              and waits until there is a visit under way to attach it to.
              `empty:hidden` rather than a compound condition on the wrapper,
              for the same reason. */}
          <div className="grid grid-cols-2 gap-2 empty:hidden">
            {hasStations && (
              <Button variant="outline" className="h-11" onClick={() => setShowStations((s) => !s)}>
                Stations
              </Button>
            )}
            {(inProg || missed) && dnaEnrolled && canPerformVisit && (
              <Button variant="outline" className="h-11" onClick={() => setShowDna((s) => !s)}>
                DNA sample
              </Button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowMore((m) => !m)}
            aria-expanded={showMore}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {showMore ? "Fewer options" : "More options"}
            {showMore ? (
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            )}
          </button>

          {showMore && (
            <div className="space-y-3 rounded-lg border bg-muted/20 p-2.5">
              {scheduled && photoCapture()}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-11 px-4 sm:h-8 sm:px-3"
                  onClick={() => setShowSkip((s) => !s)}
                >
                  Skip
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 px-4 sm:h-8 sm:px-3"
                  onClick={() => setShowAddon((s) => !s)}
                >
                  + Add-on
                </Button>
                {scheduled && dnaEnrolled && canPerformVisit && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-11 px-4 sm:h-8 sm:px-3"
                    onClick={() => setShowDna((s) => !s)}
                  >
                    DNA sample
                  </Button>
                )}
                {visit.clients?.primary_phone && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-11 px-4 sm:h-8 sm:px-3"
                      disabled={sms.isPending}
                      onClick={() => sms.mutate("reminder")}
                    >
                      Text reminder
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-11 px-4 sm:h-8 sm:px-3"
                      disabled={sms.isPending}
                      onClick={() => sms.mutate("on_my_way")}
                    >
                      Text "on my way"
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          {showSkip && (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Reason</label>
                <select
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value as any)}
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {TECH_SKIP_REASON_CODES.map((c) => (
                    <option key={c} value={c}>
                      {SKIP_REASON_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Details (what happened, photos, etc.)"
                rows={2}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!reason.trim() || skip.isPending}
                  onClick={() => skip.mutate()}
                >
                  Confirm skip
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowSkip(false)}>
                  Cancel
                </Button>
              </div>
              <p className="text-2xs text-muted-foreground">
                The office sets the billing rules for each skip reason.
              </p>
            </div>
          )}

          {showAddon &&
            (() => {
              const svc = addonServices.find((s) => s.id === addonSvcId);
              const qtyNum = Math.max(1, parseInt(addonQty, 10) || 1);
              const totalCents = svc ? svc.unit_price_cents * qtyNum : 0;
              if (!addonServices.length) {
                // An empty catalog used to leave a permanently-disabled Bill
                // button with no explanation — say why instead. Two different
                // reasons produce an empty list and they need different
                // sentences: the price list is deliberately NOT persisted to
                // the device (see read-cache-policy), so offline it is empty
                // even when the office has a full catalog. Telling a tech at a
                // fence with no bars that the office never set add-ons up
                // sends them to complain about a setting that is already
                // correct.
                return (
                  <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                    {cardOnline ? (
                      <>
                        No add-on services are set up yet, so there's nothing to bill. Ask the
                        office to add them under Settings → Add-ons.
                      </>
                    ) : (
                      <>
                        You're offline, so the add-on price list isn't available. Note it on the
                        visit and bill it when you have signal, or call the office.
                      </>
                    )}
                  </div>
                );
              }
              return (
                <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                  <div className="text-xs font-medium text-muted-foreground">
                    Bill an add-on to this client
                  </div>
                  {/* Six columns at every width gave the quantity box and the
                      Bill button one column each — about 38px on the one
                      screen in this product that is a phone screen by
                      definition, for the control that charges a card. Below
                      `sm` the service picker takes the row and quantity sits
                      beside a full-width Bill. */}
                  <div className="grid grid-cols-6 gap-2">
                    <select
                      className="col-span-6 h-9 rounded-md border bg-background px-2 text-sm sm:col-span-4"
                      value={addonSvcId}
                      onChange={(e) => setAddonSvcId(e.target.value)}
                    >
                      <option value="">Select service…</option>
                      {addonServices.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}: ${(s.unit_price_cents / 100).toFixed(2)}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="1"
                      className="col-span-2 h-9 rounded-md border bg-background px-2 text-sm touch:min-h-11 sm:col-span-1"
                      value={addonQty}
                      onChange={(e) => setAddonQty(e.target.value)}
                    />
                    {/* Real money hits the client's account — always confirm.
                      In-app dialog, NOT window.confirm(): browsers suppress
                      repeated native dialogs, which made this button a silent
                      no-op in the field (P0.4). */}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          className="col-span-4 touch:min-h-11 sm:col-span-1"
                          disabled={!addonSvcId || !svc || addonMut.isPending || !cardOnline}
                        >
                          {addonMut.isPending ? "…" : "Bill"}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            Bill ${(totalCents / 100).toFixed(2)} to{" "}
                            {visit.clients?.display_name ?? "this client"}?
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {svc
                              ? `${svc.name}${qtyNum > 1 ? ` × ${qtyNum}` : ""} at the catalog price. `
                              : ""}
                            The office will see this charge for review.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            disabled={addonMut.isPending}
                            onClick={() => {
                              if (!svc) {
                                toast.error(
                                  "That add-on service is no longer available. Pick another from the list.",
                                );
                                return;
                              }
                              addonMut.mutate();
                            }}
                          >
                            Bill it
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                  {svc && (
                    <p className="text-2xs font-medium">
                      Total: ${(totalCents / 100).toFixed(2)} at the catalog price
                    </p>
                  )}
                  {!cardOnline && (
                    // The list can still be on screen from a fetch made while
                    // the signal was good; React Query keeps it in memory. So
                    // the Bill button looks live, and pressing it used to fail
                    // with a raw network error on a real charge.
                    <p className="text-2xs font-medium text-amber-600 dark:text-amber-500">
                      You're offline. Unlike start, complete, skip and photos, an add-on charge is
                      not queued. Bill it when you have signal.
                    </p>
                  )}
                  <p className="text-2xs text-muted-foreground">
                    Prepaid clients are debited immediately; postpaid clients see it on the next
                    invoice. Field charges are capped per charge and reviewed by the office;
                    anything larger needs the office to bill it.
                  </p>
                </div>
              );
            })()}
          {showDna && (
            <DnaSamplePanel
              visitId={visit.id}
              hasUnits={!!p?.has_units}
              onDone={() => setShowDna(false)}
            />
          )}
          {showStations && <StationsSubpanel visitId={visit.id} readOnly={preview} />}
        </div>
      )}
    </li>
  );
}

/**
 * Q-5: the tech-facing half of DNA compliance.
 *
 * It asks for what the tech can actually see standing in the yard — what kind
 * of sample and where they found it — and nothing else. Whose dog it was and
 * what it costs are office decisions, and the RPC behind this refuses to
 * accept either, so there is no way for this panel to grow into them by
 * accident.
 */
function DnaSamplePanel({
  visitId,
  hasUnits,
  onDone,
}: {
  visitId: string;
  hasUnits: boolean;
  onDone: () => void;
}) {
  const logFn = useServerFn(logDnaSampleFromField);
  const online = useOnline();
  const [kind, setKind] = useState<"pile_sample" | "cheek_swab">("pile_sample");
  const [where, setWhere] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      logFn({ data: { visitId, sampleKind: kind, locationNote: where.trim() || undefined } }),
    onSuccess: () => {
      toast.success("Sample logged. The office will send it to the lab.");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="text-xs font-medium text-muted-foreground">Log a DNA sample</div>
      <div className="flex gap-2">
        <select
          className="h-9 flex-1 rounded-md border bg-background px-2 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value as "pile_sample" | "cheek_swab")}
        >
          <option value="pile_sample">Waste sample</option>
          <option value="cheek_swab">Cheek swab</option>
        </select>
      </div>
      <input
        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
        maxLength={300}
        placeholder={hasUnits ? "Where, e.g. by building C bins" : "Where, e.g. side yard"}
        value={where}
        onChange={(e) => setWhere(e.target.value)}
      />
      {!online && (
        // Same honesty as the field add-on charge: this is not one of the
        // queued actions, and a live-looking button that fails with a raw
        // network error is worse than one that says why.
        <p className="text-2xs font-medium text-amber-600 dark:text-amber-500">
          You're offline. A sample isn't queued like start, complete and photos. Log it when you
          have signal.
        </p>
      )}
      <Button size="sm" disabled={mut.isPending || !online} onClick={() => mut.mutate()}>
        {mut.isPending ? "Logging…" : "Log sample"}
      </Button>
      <p className="text-2xs text-muted-foreground">
        Goes to the office unmatched and unpriced. They decide whose dog it was.
      </p>
    </div>
  );
}

/**
 * Which of this visit's stations have a log sitting in the queue.
 *
 * The green "saved" tick is driven by the server's own logs, so offline every
 * row a tech had just filled in still read as untouched — on the screen where
 * they are working down a wall of identical bins and the only way to tell which
 * ones are done is to look. The visit card's pending count and the "Queued"
 * toast both said something happened; the row itself, the only place that
 * answers "did I already do this one", said nothing.
 *
 * Read from IndexedDB rather than remembered in component state so it survives
 * the panel being closed, the card collapsing, and the app being killed in a
 * pocket — all of which happen between the first station and the last.
 *
 * Scoped to this user for the reason every read of the queue is: on a shared
 * tablet the previous tech's queued logs are not this tech's work, and marking
 * a bin done on their behalf is how one gets skipped.
 */
function useQueuedStationIds(visitId: string): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      resolveOfflineUserId()
        .then((userId) => listPending(userId))
        .then((actions) => {
          if (cancelled) return;
          setIds(
            new Set(
              actions
                .filter((a) => a.kind === "station" && a.visitId === visitId)
                .map((a) => (a as { wasteStationId: string }).wasteStationId),
            ),
          );
        })
        .catch(() => {
          // No resolvable owner means no queue we may attribute. An empty set
          // understates; inventing one would mark bins done that are not.
          if (!cancelled) setIds(new Set());
        });
    };
    refresh();
    // Both edges matter: enqueue marks a row, and the delete that syncQueue
    // does on a successful replay is what un-marks it once the server has it.
    window.addEventListener("offline-queue-change", refresh);
    window.addEventListener("online", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("offline-queue-change", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [visitId]);
  return ids;
}

/** `readOnly` is the preview case, and it is the whole reason this prop exists.
 *  The header of /my-day badges an office role viewing a tech's day as
 *  "Preview · read-only", and every other control on the card honours that
 *  through `canPerformVisit`. This panel did not: `log_station_service` accepts
 *  `can_write_org OR is_visit_tech`, so office staff ARE permitted, and the
 *  Save button wrote a real station-service record against another person's
 *  visit from a screen promising to write nothing. The read stays — seeing
 *  which bins a tech has logged is exactly what an office user opens a preview
 *  for — and only the write goes. */
function StationsSubpanel({ visitId, readOnly = false }: { visitId: string; readOnly?: boolean }) {
  const qc = useQueryClient();
  const listFn = useServerFn(getVisitStations);
  const logFn = useServerFn(logStationService);
  const online = useOnline();
  const queuedStationIds = useQueuedStationIds(visitId);
  const { data, isPending } = useQuery({
    queryKey: ["visit-stations", visitId],
    queryFn: () => listFn({ data: { visitId } }),
    // The same options the day's prefetch used. If they differed, the entry the
    // prefetch put in the cache and the entry this panel wants would still be
    // one query — React Query keeps the longest gcTime any observer asked for —
    // but the prefetch's three days would be the only thing holding it, and a
    // reader that quietly relies on somebody else's setting is one edit away
    // from a panel that is empty again with nothing to point at.
    ...VISIT_STATIONS_CACHE,
  });

  // Through the queue, like Start / Complete / Skip / photos.
  //
  // This was a bare useMutation whose only failure path was `toast.error`, on
  // the one screen guaranteed to be used out of signal. Waste stations live at
  // apartment complexes and HOAs — parking garages, basements, service
  // corridors — so the place a tech logs one is the place their phone has
  // nothing, and the record they lost is the proof of service that answers a
  // commercial billing dispute.
  const mut = useMutation({
    mutationFn: (v: {
      wasteStationId: string;
      bagsCollected: number;
      linerReplaced: boolean;
      refillBagsAdded: number;
      notes?: string;
    }) =>
      runOrQueue({
        // The honest answer, like every other action in this file. This one
        // read `navigator.onLine` raw, which on a resumed native app in a dead
        // zone says "online" -- so the request went out, hung, and cost the
        // 8-second deadline before queueing. Per station. On a wall of twenty
        // bins, in the basement car park this panel was hardened for.
        online: !isDefinitelyOffline(),
        label: "Log station",
        send: () => logFn({ data: { visitId, ...v } }),
        queue: async () => {
          await enqueueAction({
            kind: "station",
            visitId,
            ...v,
            userId: await resolveOfflineUserId(),
          });
        },
      }),
    onSuccess: (r) => {
      toast.success(r.queued ? "Queued. Logs when back online" : "Station logged");
      // Only when it actually landed. Refetching after a queue write would show
      // the tech the server's copy — no log for this station — directly
      // contradicting the toast that just said it was saved.
      if (!r.queued) qc.invalidateQueries({ queryKey: ["visit-stations", visitId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const stations: any[] = data?.stations ?? [];
  const logs: any[] = data?.logs ?? [];
  const logFor = (sid: string) => logs.find((l) => l.waste_station_id === sid);

  // "No stations configured" is an answer from the server, and it used to be
  // printed whenever `data` was missing for ANY reason — including the fetch
  // having failed in the dead zone this panel is opened in. So the app told a
  // tech standing in front of a row of bins that the property has none and to
  // go and ask the office, which is a specific, confident, wrong instruction.
  // Not knowing has to look different from knowing there are none.
  if (!data) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        {isPending
          ? "Loading stations…"
          : online
            ? "Couldn't load this property's stations. Try again in a moment."
            : "No saved copy of this property's stations on this device. Open My Day where you have signal and they'll be here next time."}
      </div>
    );
  }

  if (stations.length === 0) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        No waste stations configured for this property. Ask the office to add them.
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="text-xs font-medium text-muted-foreground">Station service log</div>
      {stations.map((s) => {
        const existing = logFor(s.id);
        return (
          <StationRow
            key={s.id}
            station={s}
            existing={existing}
            queued={queuedStationIds.has(s.id)}
            onSave={(payload) => mut.mutate({ wasteStationId: s.id, ...payload })}
            disabled={mut.isPending}
            readOnly={readOnly}
          />
        );
      })}
    </div>
  );
}

function StationRow({
  station,
  existing,
  queued,
  onSave,
  disabled,
  readOnly = false,
}: {
  station: any;
  existing?: any;
  /** This station has a log waiting in the offline queue — saved on the device,
   *  not yet on the server, and therefore invisible to `existing`. */
  queued?: boolean;
  onSave: (v: {
    bagsCollected: number;
    linerReplaced: boolean;
    refillBagsAdded: number;
    notes?: string;
  }) => void;
  disabled: boolean;
  /** Preview: show the record, offer no way to change it. Distinct from
   *  `disabled`, which is the transient in-flight state of a save that IS
   *  allowed. The inputs go down with the button — a field left editable under
   *  a heading that says read-only invites someone to type numbers that can
   *  never be saved. */
  readOnly?: boolean;
}) {
  const [bags, setBags] = useState<string>(String(existing?.bags_collected ?? "0"));
  const [liner, setLiner] = useState<boolean>(existing?.liner_replaced ?? false);
  const [refill, setRefill] = useState<string>(String(existing?.refill_bags_added ?? "0"));
  const [notes, setNotes] = useState<string>(existing?.notes ?? "");
  return (
    <div className="rounded-md border bg-background p-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-sm font-medium">{station.label}</div>
        {/* Queued outranks saved: if both are true the tech has logged this
            station again since the server's copy, and "saved" would point at
            the older of the two answers. */}
        {queued ? (
          <span className="shrink-0 text-2xs font-medium text-amber-600 dark:text-amber-500">
            queued
          </span>
        ) : (
          existing && <span className="shrink-0 text-2xs text-emerald-600">saved</span>
        )}
      </div>
      {station.location_description && (
        <div className="text-2xs text-muted-foreground">{station.location_description}</div>
      )}
      <div className="mt-2 grid grid-cols-6 gap-2 text-xs">
        <label className="col-span-2">
          <span className="block text-2xs text-muted-foreground">Bags collected</span>
          <input
            type="number"
            min="0"
            value={bags}
            disabled={readOnly}
            onChange={(e) => setBags(e.target.value)}
            className="h-9 w-full rounded-md border bg-background px-2 disabled:opacity-60"
          />
        </label>
        <label className="col-span-2">
          <span className="block text-2xs text-muted-foreground">Refill bags added</span>
          <input
            type="number"
            min="0"
            value={refill}
            disabled={readOnly}
            onChange={(e) => setRefill(e.target.value)}
            className="h-9 w-full rounded-md border bg-background px-2 disabled:opacity-60"
          />
        </label>
        <label className="col-span-2 flex items-center gap-2 pt-4">
          <input
            type="checkbox"
            checked={liner}
            disabled={readOnly}
            onChange={(e) => setLiner(e.target.checked)}
            className="h-4 w-4 disabled:opacity-60"
          />
          <span>Liner replaced</span>
        </label>
        <input
          className="col-span-6 h-9 rounded-md border bg-background px-2 disabled:opacity-60"
          placeholder="Notes (optional)"
          value={notes}
          disabled={readOnly}
          onChange={(e) => setNotes(e.target.value)}
        />
        {readOnly ? (
          <p className="col-span-6 text-2xs text-muted-foreground">
            Read-only while previewing another technician's day.
          </p>
        ) : (
          <Button
            size="sm"
            className="col-span-6"
            disabled={disabled}
            onClick={() =>
              onSave({
                bagsCollected: parseInt(bags, 10) || 0,
                linerReplaced: liner,
                refillBagsAdded: parseInt(refill, 10) || 0,
                notes: notes.trim() || undefined,
              })
            }
          >
            {existing ? "Update" : "Save"}
          </Button>
        )}
      </div>
    </div>
  );
}
