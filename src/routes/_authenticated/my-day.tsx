import { isVaccineStartBlocked, petsMissingVaccines, type MissingVaccine } from "@/lib/pet-safety";
import { createFileRoute, Link } from "@tanstack/react-router";
import { roleLabelKey, techIsTrainer } from "@/lib/humanize";
import { daysBetweenOrgDays, orgLocalDay, orgLocalDayTime, orgLocalTime } from "@/lib/org-day";
import { visitEta } from "@/lib/visit-eta";
import { useOrgTimezone, useOrgToday } from "@/hooks/useOrgToday";
import { useOrgFieldRules } from "@/hooks/useOrgFieldRules";
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
  type CSSProperties,
} from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { getMyDay, getMyUpcomingDays, listMyDayFieldStaff } from "@/lib/my-day.functions";
import { listAddonServices, createAddonCharge } from "@/lib/addons.functions";
import { getVisitStations, logStationService } from "@/lib/stations.functions";
import { logDnaSampleFromField } from "@/lib/dna.functions";
import { sendOnMyWayMessage, sendVisitStatusSms } from "@/lib/messages.functions";
import {
  SKIP_REASON_LABELS,
  LESSON_SKIP_REASON_LABELS,
  WALK_SKIP_REASON_LABELS,
  SIT_SKIP_REASON_LABELS,
  techSkipReasonCodes,
} from "@/lib/skip-rules.functions";
import { useOnline, usePendingCount } from "@/lib/offline/useOnline";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { nativeTopBarStyle } from "@/lib/native-build";
import { useOfflineVisitActions } from "@/lib/offline/useOfflineVisitActions";
import { useQueueSync } from "@/components/QueueSync";
import {
  countPendingForVisit,
  countQueuedCompletionPhotos,
  queuedCollectionCents,
  enqueueAction,
  listPending,
} from "@/lib/offline/queue";
import { runOrQueue } from "@/lib/offline/run-or-queue";
import { useQueuedLifecycle } from "@/lib/offline/useQueuedLifecycle";
import { dayAtAGlance } from "@/lib/my-day-progress";
import { routeStops } from "@/lib/live-activity-state";
import { withQueuedLifecycle, type LifecycleKind } from "@/lib/offline/queued-visit-state";
import { resolveOfflineUserId } from "@/lib/offline/action-owner";
import { confirmEndWithEmptyReport } from "@/lib/offline/walk-drafts";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import {
  describeReadFreshness,
  READ_REFRESH_GRACE_MS,
  cacheAgeParts,
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
  Fence,
  KeyRound,
  LockKeyhole,
  Phone,
  Ruler,
  Timer,
  List as ListIcon,
  Map as MapIcon,
  TriangleAlert,
  Ban,
  ShieldCheck,
  ReceiptText,
  BellRing,
  Info as InfoIcon,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PushToggle } from "@/components/PushToggle";
import { FOCUS_MY_DAY_SCHEDULE_EVENT } from "@/components/MobileTabBar";
// LanguageToggle moved to Settings → Preferences
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useIntlLocale } from "@/lib/i18n";
import { formatClock, formatDay } from "@/lib/format";
import { haptic } from "@/lib/haptics";
import { useMyRole } from "@/hooks/useMyRole";
import { PAGE_BLEED_TOP, PAGE_BLEED_X } from "@/components/PageShell";
import { useTabletTier } from "@/hooks/useTabletTier";
import { useSidebar } from "@/components/ui/sidebar";
import { useSignedUrl } from "@/hooks/useSignedUrl";
import { YARD_SIZE_LABELS, type YardSizeCategory } from "@/lib/yard-size";
import { visitServiceLabel } from "@/lib/visit-service";
import { GroomPetPanel } from "@/components/my-day/GroomPetPanel";
import {
  TrainingProgressPanel,
  TrainingSessionBadge,
} from "@/components/training/TrainingProgressPanel";
import type { ServiceLine } from "@/lib/service-lines";
import { CloseOutOpenVisits } from "@/components/CloseOutOpenVisits";
import { EnRouteLocationChip } from "@/components/EnRouteLocationChip";
import { OffTheClockBanner, StillWorkingPrompt } from "@/components/TimeClock";
import { useHeaderPrefs } from "@/hooks/useHeaderPrefs";
import { recordFieldCollection } from "@/lib/field-collections.functions";
import {
  dueCents,
  formatMoney,
  moreThanOwedFromRefusal,
  newClientKey,
  type StopFacts,
} from "@/lib/stop-facts";
import {
  CollectForm,
  DogsLine,
  PaymentLine,
  StationsSummary,
  YardOutline,
  type CollectAnswer,
} from "@/components/my-day/StopFacts";
import { useServiceLines } from "@/components/CommercialOnly";
import { isYardVisit } from "@/lib/walk-concerns";
import {
  WalkAccess,
  WalkMeta,
  WalkReportFields,
  WalkTimer,
  isWalkVisit,
  useWalkReport,
} from "@/components/my-day/WalkParts";
import {
  SitCareLog,
  SitCodesHint,
  SitEmergencyFacts,
  SitMeta,
  SitNoteField,
  SitPetsCare,
  SitStayNotes,
  isSitVisit,
  sitEmergency,
  sitStepLabel,
  useSitCare,
  useSitPets,
} from "@/components/my-day/SitParts";
import { LogExpenseSheet } from "@/components/LogExpenseSheet";
import {
  captureCompletionFile,
  runVisitStep,
  takeCompletionPhoto,
  visitStep,
} from "@/lib/visit-step";
import {
  PHOTO_KIND_OPTIONS,
  photoKindLabel,
  defaultPhotoKind,
  type PhotoKind,
} from "@/lib/photo-kinds";
import { Checkbox } from "@/components/ui/checkbox";
import { VisitChecklistAnswers } from "@/components/VisitChecklistAnswers";
import {
  answersFor,
  checklistForLine,
  checklistLineOf,
  missingRequired,
  parseAnswers,
} from "@/lib/visit-checklist";
import { isLiveActivityAction, type LiveActivityAction } from "@/lib/live-activity-links";
import { useLiveActivityAction } from "@/components/my-day/use-live-activity-action";
import { pageTitle, titleHead, useDocumentTitle } from "@/lib/page-title";
import { MyDaySkeleton } from "@/components/PageSkeletons";
import { PullToRefresh } from "@/components/motion/PullToRefresh";
import { showCompletionCheck } from "@/lib/motion/completion-check";
import { useMotionList } from "@/lib/motion/use-motion-list";
import { readableError } from "@/lib/readable-error";
import { isFutureVisit } from "@/lib/booking-dates";

export const Route = createFileRoute("/_authenticated/my-day")({
  head: () => titleHead("My day"),
  // Wide — see src/components/PageShell.tsx. Its sticky bar and its map run edge
  // to edge (PAGE_BLEED_X), so the column under them has to reach the same
  // edges.
  staticData: { pageWidth: "wide" },
  // Honor ?date=YYYY-MM-DD deep-links (notifications, bookmarks) instead of
  // silently showing today (P1.8). ?staff=<uuid> lets office roles preview a
  // technician's day read-only. ?visit=<uuid> is the stop a push was about
  // (src/lib/field-notify.ts myDayLink): the page opens scrolled to it.
  // &action=start|complete comes with it from the lock screen's buttons
  // (src/lib/live-activity-links.ts), allowlisted again here.
  validateSearch: (
    search: Record<string, unknown>,
  ): { date?: string; staff?: string; visit?: string; action?: LiveActivityAction } => {
    const out: { date?: string; staff?: string; visit?: string; action?: LiveActivityAction } = {};
    const raw = typeof search.date === "string" ? search.date : undefined;
    if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(new Date(raw).getTime())) {
      out.date = raw;
    }
    const s = typeof search.staff === "string" ? search.staff : undefined;
    if (s && /^[0-9a-f-]{36}$/i.test(s)) out.staff = s;
    const v = typeof search.visit === "string" ? search.visit : undefined;
    if (v && /^[0-9a-f-]{36}$/i.test(v)) out.visit = v;
    if (out.visit && isLiveActivityAction(search.action)) out.action = search.action;
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
  const motionList = useMotionList<HTMLOListElement>();
  const {
    date: dateParam,
    staff: staffParam,
    visit: visitParam,
    action: actionParam,
  } = Route.useSearch();
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
  const upcomingFn = useServerFn(getMyUpcomingDays);
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
  // A training-only business calls its technicians trainers (train-17).
  const { lines: orgLines, known: orgLinesKnown } = useServiceLines();
  const trainerWords = orgLinesKnown && techIsTrainer(orgLines);
  const roleLabel = (role: string) => t(roleLabelKey(role, orgLinesKnown ? orgLines : null));
  // In the language this device reads. The route's head is English because
  // it runs before i18n has read the device's choice.
  useDocumentTitle(pageTitle(t("nav.item.my-day")));
  const locale = useIntlLocale();
  const { role, orgId } = useMyRole();
  const isOfficeRole = role === "owner" || role === "office_manager" || role === "dispatcher";
  // One "Log an expense" sheet for the page, opened from any card's More
  // options. Never while previewing somebody else's day: the expense would
  // be the viewer's own, filed from a screen that says it is not theirs.
  const [expenseOpen, setExpenseOpen] = useState(false);

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
  // And whether there is a tab bar at all: a phone set to the side menu
  // (Preferences → Menu on a phone) draws none, and NEXT UP parked 56px above
  // the bottom of the screen with nothing under it.
  const { prefs: headerPrefs } = useHeaderPrefs();
  const tabBarDrawn = headerPrefs.phoneNav === "bottom";
  // ── NEXT UP SITS ON THE TAB BAR, NOT NEAR IT ─────────────────────────────
  //
  // The offset is the tab bar's height as the tab bar itself is drawn,
  // `--tab-bar-h` (styles.css), plus the home indicator's inset, which the
  // tab bar pads by. Until 2026-10-07 it was a literal 3.5rem while the bar
  // was 51px, so NEXT UP floated 5px above it and the stop list scrolled
  // through the gap: the owner circled it on an iPhone 17 Pro, TestFlight
  // build 261. tests/viewports/my-day-gets-its-room-back.spec.ts measures the
  // two edges against each other, with the iPhone's insets and without.
  //
  // 7rem clears the NEXT UP bar on its own; the wider value adds the tab bar
  // on top of it, for exactly as long as the tab bar is on screen.
  //
  // For a tech the bar also stays on every touch screen, iPad landscape
  // included (useTabletTier, QA row 35), so each `max-lg:` here has a
  // `touch:` twin.
  const belowTabBarPadding = !tabBarDrawn
    ? "pb-[calc(7rem+env(safe-area-inset-bottom))]"
    : barThroughTablet
      ? "pb-[calc(7rem+env(safe-area-inset-bottom))] max-lg:pb-[calc(7rem+var(--tab-bar-h)+env(safe-area-inset-bottom))] touch:pb-[calc(7rem+var(--tab-bar-h)+env(safe-area-inset-bottom))]"
      : "pb-[calc(7rem+env(safe-area-inset-bottom))] max-md:pb-[calc(7rem+var(--tab-bar-h)+env(safe-area-inset-bottom))]";
  const nextUpAboveTabBar = !tabBarDrawn
    ? ""
    : barThroughTablet
      ? "max-lg:bottom-[calc(var(--tab-bar-h)+env(safe-area-inset-bottom))] max-lg:pb-0 touch:bottom-[calc(var(--tab-bar-h)+env(safe-area-inset-bottom))] touch:pb-0"
      : "max-md:bottom-[calc(var(--tab-bar-h)+env(safe-area-inset-bottom))] max-md:pb-0";
  // And the NEXT UP bar starts clear of the docked sidebar, from wherever the
  // sidebar docks: for a tech with the tab bar that is `lg` and only with a
  // mouse (sidebarDocksFrom). A fixed `md:` here would leave a gap on the
  // left of a crew tablet, beside a sidebar that is no longer there.
  // `--sidebar-docked-width` is what the sidebar actually takes from the page:
  // the icon width on the rail below 1024px (QA row 34) or a collapsed
  // column, the full column when it is expanded (#499).
  const { docksFrom } = useSidebar();
  const nextUpClearOfSidebar =
    docksFrom === "lg-mouse"
      ? "lg:mouse:start-(--sidebar-docked-width)"
      : "md:start-(--sidebar-docked-width)";

  const { data, isLoading, isError, isFetching, dataUpdatedAt, refetch } = useQuery({
    queryKey: ["my-day", day, staffParam ?? ""],
    queryFn: () => fn({ data: staffParam ? { day, staffId: staffParam } : { day } }),
    // Coming back to the app in a dead zone is not a reason to ask the server
    // for the day: the request can only fail. The saved copy now survives a
    // failed refresh (lib/offline/last-good-copy.ts), but a refetch that cannot
    // succeed only adds a failure. Focus while online, and the reconnect
    // refetch, are unchanged.
    refetchOnWindowFocus: () => !isDefinitelyOffline(),
  });
  // The first moments after opening, while a saved day's refresh is still
  // out: the banner waits for it rather than flashing (refreshInFlight).
  const [inLaunchGrace, setInLaunchGrace] = useState(
    () => Date.now() - SESSION_STARTED_AT < READ_REFRESH_GRACE_MS,
  );
  useEffect(() => {
    if (!inLaunchGrace) return;
    const id = window.setTimeout(
      () => setInLaunchGrace(false),
      Math.max(0, READ_REFRESH_GRACE_MS - (Date.now() - SESSION_STARTED_AT)),
    );
    return () => window.clearTimeout(id);
  }, [inLaunchGrace]);

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
    refreshInFlight: isFetching && inLaunchGrace,
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

  // The replay itself lives in the signed-in layout (components/QueueSync.tsx),
  // so the queue goes out on reconnect from whatever page is open, not only
  // this one. Here: the Sync button (the only "tap"), and the day's client
  // names, which let a message about work to redo name the stop.
  const { runSync, visitNames } = useQueueSync();

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
  const dayAsWorked = useMemo(
    () => withQueuedLifecycle(serverVisits ?? [], queuedLifecycle),
    [serverVisits, queuedLifecycle],
  );
  // A canceled visit is not a stop (gaps-r2-08). After an early return the
  // stay's last nights are canceled, and they were drawn as full cards with
  // Navigate, Call and the money due, and counted in "0 of 2 done", so a
  // sitter could drive to a house the client had come back to. The cards,
  // the count, the next stop and the map read `visits`; the canceled ones are
  // folded under one line below the list. Same rule as the lock screen
  // (routeStops in lib/live-activity-state.ts).
  const visits = useMemo(() => routeStops(dayAsWorked), [dayAsWorked]);
  const canceledVisits = useMemo(
    () => dayAsWorked.filter((v: { status: string }) => v.status === "canceled"),
    [dayAsWorked],
  );
  // List or map. Not in the URL: it is a way of looking at the day, not a
  // different day, and a tech who taps Map then reloads in a dead spot should
  // get the list back rather than a grey tile grid.
  const [view, setView] = useState<"list" | "map">("list");
  // Kept current for the sync toasts' names (QueueSync). Written during render
  // rather than in an effect: a sync can fire from the online listener before
  // an effect has run, and a toast that says "and 2 others" with no names is
  // worse than one that says nothing.
  visitNames.current = new Map(
    dayAsWorked.map((v: { id: string; clients?: { display_name?: string | null } | null }) => [
      v.id,
      v.clients?.display_name ?? t("myDay.aVisit"),
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
  const { completedCount, skippedCount, missedCount, total, pct, activeVisit, nextUp } =
    dayAtAGlance(visits);
  const upcomingDays = useQuery({
    queryKey: ["my-upcoming-days"],
    queryFn: () => upcomingFn({ data: {} }),
    enabled: !!staff && !previewing && visits.length === 0,
    staleTime: 60_000,
  });
  const nextWorkday = ((upcomingDays.data?.days ?? []) as { date: string }[]).find(
    (d) => d.date > day,
  );

  // The route on the iPhone lock screen is not driven from here any more: the
  // signed-in layout runs it (RouteLockScreenHost, my-day/RouteLockScreen
  // .tsx) from the same query this page reads for today, so it comes back
  // whichever page the app opens on.

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

  // A push about one stop opens on that stop. After the scroll above (two
  // frames, not one), because a tap on "New stop on today's route" is asking
  // about THAT stop, not about the job already in hand. Once per id, once
  // the stop is on the page; a later refetch does not move the tech again.
  const visitOnPage = !!visitParam && visits.some((v: any) => v.id === visitParam);
  useEffect(() => {
    if (!visitParam || !visitOnPage) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        document
          .getElementById(`visit-${visitParam}`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [visitParam, visitOnPage]);
  // ...and from the lock screen's Start or Complete: onto that stop's one
  // button, at whatever step the visit is at. Never the camera: that opens
  // only when the tech taps the button at its photo step
  // (src/lib/visit-step.ts). The card has to be on the page to be landed on,
  // so a lock-screen link brings the list back from the map.
  useEffect(() => {
    if (actionParam && visitOnPage) setView("list");
  }, [actionParam, visitOnPage]);
  useLiveActivityAction({
    visitId: visitParam,
    action: actionParam,
    ready: visitOnPage && view === "list",
    labels: { start: t("myDay.start"), complete: t("myDay.complete") },
    onHandled: () =>
      navigate({
        search: (prev: Record<string, unknown>) => ({ ...prev, action: undefined }),
        replace: true,
      }),
  });

  if (isLoading) return <MyDaySkeleton title={t("myDay.title")} label={t("common.loading")} />;

  // Fetch failed and nothing is cached for this day — say so plainly instead
  // of falling through to the misleading "not linked to a staff record" state.
  if (isError && !data)
    return (
      <div className="space-y-3 py-10 text-center">
        <WifiOff className="mx-auto h-6 w-6 text-muted-foreground shrink-0" />
        <p className="text-sm text-muted-foreground">
          {online ? t("myDay.loadFailed") : t("myDay.loadFailedOffline")}
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="me-1.5 h-3.5 w-3.5 shrink-0" /> {t("common.retryShort")}
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
    //
    // No negative margins on this root any more. It was `-mx-4 -my-6`, which
    // undid a 16px gutter that has been 24px from `sm` up, so from 640px My
    // Day sat 8px left of every other page. The one thing here that really
    // runs edge to edge is the sticky bar below, and it now says so with
    // PAGE_BLEED_X, which is the gutter's exact inverse.
    <div className={view === "map" ? "" : belowTabBarPadding}>
      <PullToRefresh />
      {/* BUILD-11: a visit started on an earlier day (or before today's workday
          ended) that was never closed. Asks the tech what happened rather than
          guessing — nothing here completes anything on its own. */}
      <CloseOutOpenVisits />
      {/* Sticky top bar, like a native nav.
          `top` is the impersonation banner's measured height, 0 when there is
          no banner: both are sticky to the same edge and the banner wins on
          z-index, so a fixed top-0 here vanished under it.

          OPAQUE since QA rows 20 and 35 (2026-10-15). It was 60-80% background
          with a blur, so the stop cards scrolling under it showed through
          the heading on a phone and on an iPad alike. A bar that holds the
          page's controls reads as part of the page when it is solid. */}
      <div
        data-page-bleed=""
        className={`sticky top-[var(--hs-banner-h,0px)] z-30 border-b bg-background ${PAGE_BLEED_X} ${PAGE_BLEED_TOP}`}
        // Sizes to its content, so no height override. See nativeTopBarStyle.
        style={nativeTopBarStyle()}
      >
        {/* The same reading column as the list below on a wide screen. */}
        <div className="space-y-2 py-3 lg:mx-auto lg:max-w-3xl">
          {/* ── ONE LINE EACH (QA row 20) ─────────────────────────────────
              The connection notice was a padded card, and the saved-copy
              notice under it was a card of two lines, so offline the header
              grew by about 110px before the heading. Each is now one line
              that truncates, with its action at the end. When the saved-copy
              line already says "Offline", the connection line is not drawn
              again: its pending count joins the saved-copy line instead. */}
          {(!online || pending > 0) && !(freshness?.status === "cached" && !online) && (
            <div
              className={`flex min-h-9 items-center gap-2 rounded-md border ps-2.5 text-xs animate-fade-in ${
                online
                  ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : "border-destructive/50 bg-destructive/10 text-destructive"
              }`}
            >
              {!online && <WifiOff className="h-3.5 w-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate py-1 font-medium">
                {!online ? t("common.offline") : t("common.online")}
                {pending > 0 ? ` · ${t("common.pending", { count: pending })}` : ""}
              </span>
              {online && pending > 0 && (
                <button
                  onClick={() => {
                    haptic("tap");
                    runSync("tap");
                  }}
                  className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-3 text-xs font-semibold hover:bg-current/10 active:scale-95 transition-transform touch:min-h-11"
                >
                  <RefreshCw className="h-3 w-3 shrink-0" /> {t("common.sync")}
                </button>
              )}
            </div>
          )}

          {/* Read-only offline fallback (Phase 3): what is on screen was not
              fetched just now (the device is offline, or the refresh failed),
              so it is labelled with WHEN it was fetched. Past the trust
              horizon the wording escalates from "saved copy" to a warning,
              because a route that old has probably been re-sequenced and
              driving off it sends the tech to the wrong houses. One line
              since QA row 20; tap the text for the saved-copy details. */}
          {freshness?.status === "cached" &&
            (() => {
              const headline = t(online ? "myDay.cachedRefreshFailed" : "myDay.cachedOffline", {
                age: cacheAgeText(t, freshness.ageMs),
              });
              const updated = t("myDay.lastUpdated", {
                when: new Date(freshness.fetchedAt).toLocaleString(locale, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                }),
              });
              const queued =
                !online && pending > 0 ? ` · ${t("common.pending", { count: pending })}` : "";
              const warning = freshness.beyondTrustHorizon
                ? ` · ${t("myDay.routeMayHaveChanged")}`
                : "";
              return (
                <div
                  className={`flex min-h-9 items-center gap-2 rounded-md border ps-2.5 text-xs animate-fade-in ${
                    freshness.beyondTrustHorizon
                      ? "border-destructive/50 bg-destructive/10 text-destructive"
                      : "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  }`}
                  title={`${headline}${queued}. ${updated}${warning}`}
                >
                  {online ? (
                    <RefreshCw className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <WifiOff className="h-3.5 w-3.5 shrink-0" />
                  )}
                  {/* Popover draws no box, so this div is the flex item that shrinks. */}
                  <div className="min-w-0 flex-1">
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          aria-label={`${headline}${queued}. ${updated}${warning}`}
                          className="block w-full truncate py-1 text-start touch:min-h-11"
                        >
                          <span className="font-medium">
                            {headline}
                            {queued}
                          </span>
                          {warning ? (
                            <span className="font-medium">{warning}</span>
                          ) : (
                            <span className="opacity-90"> · {updated}</span>
                          )}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[min(18rem,calc(100vw-2rem))] space-y-1 p-3 text-sm">
                        <p>
                          {headline}
                          {queued}
                        </p>
                        <p>{updated}</p>
                        {freshness.beyondTrustHorizon && <p>{t("myDay.routeMayHaveChanged")}</p>}
                      </PopoverContent>
                    </Popover>
                  </div>
                  <button
                    onClick={() => {
                      haptic("tap");
                      refetch();
                    }}
                    className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-3 text-xs font-semibold hover:bg-current/10 active:scale-95 transition-transform touch:min-h-11"
                  >
                    <RefreshCw className="h-3 w-3 shrink-0" /> {t("common.retryShort")}
                  </button>
                </div>
              );
            })()}

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
                    ? `${staff.display_name}${staff.role ? ` · ${roleLabel(staff.role)}` : ""}`
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
                <div className="pointer-events-none flex min-h-11 items-center gap-2 rounded-lg border bg-background ps-3 pe-2">
                  <CalendarIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="whitespace-nowrap text-sm font-medium">
                    {/* The weekday is the first 47px to go, and only below
                        360px. At 320 the heading and the chip cannot both have
                        what they want, and a date without its weekday is still
                        a date -- whereas "My d…" is not a heading. Every real
                        phone in the 360-430 band keeps the full label. */}
                    <span className="max-[359px]:hidden">
                      {new Date(`${day}T00:00:00`).toLocaleDateString(locale, {
                        weekday: "short",
                      })}
                      {t("myDay.weekdaySeparator")}
                    </span>
                    {new Date(`${day}T00:00:00`).toLocaleDateString(locale, {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </div>
                <input
                  type="date"
                  aria-label={t("myDay.pickADay")}
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
                aria-label={t("myDay.pickADay")}
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

          {/* ── THE STATUS ROW ───────────────────────────────────────────
              Progress and the view: the date is in the row above. That is
              all, again (2026-10-08). The time clock and the lock-screen
              switch spent a day here as a chip and an icon, after two
              full-width cards before that; the owner took both off My Day.
              The clock is in the More sheet and the sidebar (TimeClock.tsx),
              with a slim reminder below when there is work today and nobody
              is on the clock, and the route on the lock screen is switched
              in Preferences and comes back by itself.

              One row at every width: progress left, List/Map right. At 320px
              the pill gives up width to the toggle, never the other way. */}
          {total > 0 && (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
              {/* PROGRESS LEFT, VIEW RIGHT.
                  The toggle used to lead the row and the progress followed it,
                  which put the control first and the fact second. The number
                  is what a technician reads at a glance between driveways; the
                  toggle is pressed a few times a day. min-w-0 so the pill
                  yields to the toggle rather than pushing it off the edge. */}
              <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg bg-muted/60 ps-3">
                {/* No shrink-0 since the missed count joined this line (QA
                    row 20): the bar still gives up its width first, because
                    flex-1 starts it at zero, and only at 320px with a busy
                    day does the text then end in an ellipsis. */}
                <div className="min-w-0 truncate text-xs font-medium">
                  {completedCount} {t("common.of")} {total} {t("common.done")}
                  {skippedCount > 0 && (
                    <span className="ms-1 font-normal text-muted-foreground">
                      · {t("myDay.skippedCount", { count: skippedCount })}
                    </span>
                  )}
                  {missedCount > 0 && (
                    <span className="ms-1 font-normal text-muted-foreground">
                      · {t("myDay.missedCount", { count: missedCount })}
                    </span>
                  )}
                </div>
                {/* The bar is the one thing here allowed to give up width, so
                    it is the only flex item without shrink-0. At 320px it
                    narrows to a sliver and the two numbers stay readable,
                    which is the right way round: the bar restates the
                    percentage, the percentage does not restate the bar. */}
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted-foreground/20">
                  {/* hs-meter: slides on transform, not width (styles.css). */}
                  <div
                    className="hs-meter h-full rounded-full bg-primary"
                    style={{ "--hs-meter": `${pct}%` } as CSSProperties}
                  />
                </div>
                {/* The percentage is also the way to the rule behind it. The
                    rule was a paragraph under this row on every visit to the
                    page (QA row 20: header and bars took most of a 390px
                    screen); it is one tap away now, and the glyph says so. */}
                <Popover>
                  <PopoverTrigger asChild>
                    {/* Named "How progress is counted 42%", not only the
                        first half: an aria-label that drops the number on
                        the button is axe's label-content-name-mismatch, and a
                        voice-control user says what they see. The number
                        stays last, so the row's text still ends in "%". */}
                    <button
                      type="button"
                      className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-md pe-2 ps-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      <span className="sr-only">{t("myDay.howProgressCounts")} </span>
                      {pct}%
                      <InfoIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="w-[min(18rem,calc(100vw-2rem))] p-3 text-sm"
                  >
                    {t("myDay.progressRule")}
                  </PopoverContent>
                </Popover>
              </div>

              {/* Labelled, not icon-only. "List" and "Map" next to the glyph
                  cost about 60px and remove the guess; the icons alone were a
                  list and a folded map, which are not far apart at 16px. Still
                  44px tall -- the height is now the padding plus the label
                  rather than a fixed square, so min-h-11 states it outright. */}
              <div
                className="flex shrink-0 rounded-lg border p-0.5"
                role="group"
                aria-label={t("myDay.view")}
              >
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
                    {v === "list" ? t("myDay.viewList") : t("myDay.viewMap")}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isOfficeRole && fieldStaff.length > 0 && (
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <label htmlFor="my-day-staff" className="shrink-0 text-muted-foreground">
                {t("myDay.viewing")}
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
                  {data?.staff && !previewing ? t("myDay.title") : t(trainerWords ? "myDay.selectTrainer" : "myDay.selectTechnician")}
                </option>
                {fieldStaff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.display_name}
                    {s.role ? ` · ${roleLabel(s.role)}` : ""}
                  </option>
                ))}
              </select>
              {previewing && (
                <span className="rounded-full border px-2 py-0.5 text-3xs uppercase tracking-wide text-muted-foreground">
                  {t("myDay.previewReadOnly")}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── NOT A STRETCHED PHONE COLUMN (QA row 35) ────────────────────────
          From `lg` the list is held to a reading column in the middle of the
          page: a stop card 1100px wide put the client's name at one edge of
          an iPad in landscape and the Start button at the other. The sticky
          bar above keeps running edge to edge and holds its contents to the
          same column. The map keeps the full width, which is what it is for. */}
      <div className={`space-y-3 pt-4 ${view === "map" ? "" : "lg:mx-auto lg:max-w-3xl"}`}>
        {/* No cards above the first stop, with one exception that earns its
            place: work today and nobody on the clock. "You're off the clock"
            and Clock in, one tap, queued with no signal. On the clock, or on
            any other day, it is not drawn and the list starts right here. */}
        {staff && !previewing && day === orgTodayIso && <OffTheClockBanner visitsToday={total} />}
        {/* The other exception: a shift open 12 hours or more. Asked, never
            closed for them (QA row 22, #438). Any day, because a shift left
            open overnight is still open whatever day is on screen. */}
        {staff && !previewing && <StillWorkingPrompt />}
        {!staff && !isOfficeRole && (
          <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
            {t("myDay.unlinkedStaff")}
          </div>
        )}

        {!staff && isOfficeRole && (
          <div className="rounded-lg border bg-card p-(--card-pad) text-center text-sm text-muted-foreground">
            {fieldStaff.length === 0 ? t(trainerWords ? "myDay.noTrainers" : "myDay.noTechnicians") : t(trainerWords ? "myDay.pickTrainer" : "myDay.pickTechnician")}
          </div>
        )}

        {staff && visits.length === 0 && (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            <p>
              {previewing
                ? t("myDay.previewNothingScheduled", {
                    name: staff.display_name,
                    day: formatDay(day, locale),
                  })
                : t("myDay.nothingScheduled")}
            </p>
            {!previewing && nextWorkday && (
              <p className="mt-2 text-xs">
                {t("myDay.nextWorkdayHint", { day: formatDay(nextWorkday.date, locale) })}
              </p>
            )}
            <Button asChild variant="outline" size="sm" className="mt-4">
              {/* /routes is OFFICE-ONLY. ROUTE_ROLES does not grant it to a
                  tech, so RoleGuard bounced them straight back here with a red
                  "You don't have access to that page" — the only action on the
                  screen was a dead end for the only role the screen is for.
                  /my-schedule is their own forward view and they can open it. */}
              <Link to="/my-schedule">{t("myDay.viewMySchedule")}</Link>
            </Button>
          </div>
        )}

        {view === "map" ? (
          <MyDayMap
            visits={visits}
            staffName={data?.staff?.display_name ?? t("myDay.myRoute")}
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
          <ol ref={motionList} className="motion-list space-y-3">
            {visits.map((v: any, idx: number) => (
              <VisitCard
                key={v.id}
                visit={v}
                dayVisits={visits}
                index={idx + 1}
                day={day}
                preview={previewing}
                canText={data?.canText === true}
                onLogExpense={previewing ? undefined : () => setExpenseOpen(true)}
              />
            ))}
          </ol>
        )}
        {view === "list" && canceledVisits.length > 0 && (
          <details className="rounded-lg border bg-card px-(--card-pad) text-sm text-muted-foreground">
            <summary className="flex min-h-11 cursor-pointer items-center">
              {t("myDay.canceledStops", { count: canceledVisits.length })}
            </summary>
            <p className="pb-2 text-xs">{t("myDay.canceledStopsHint")}</p>
            <ul className="space-y-1 pb-3">
              {canceledVisits.map(
                (v: { id: string; clients?: { display_name?: string | null } | null }) => (
                  <li key={v.id} className="min-w-0 truncate">
                    <bdi>{v.clients?.display_name ?? t("myDay.aVisit")}</bdi>
                  </li>
                ),
              )}
            </ul>
          </details>
        )}
      </div>

      {!previewing && (
        <LogExpenseSheet
          open={expenseOpen}
          onOpenChange={setExpenseOpen}
          organizationId={orgId}
          staffId={staff?.id ?? null}
        />
      )}

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

             Starting at the sidebar's own width variable fixes both at once:
             the bar spans the content column and mx-auto centres within it.
             The variable is the docked width, so on the icon rail the bar
             starts at the rail's edge rather than 16rem in. */
          /* Opaque, like the sticky header above. At 70% with a blur, the
             "In progress" label's blue measured 2.67:1 whenever a dark
             primary button scrolled under it (axe, /my-day at 1280px,
             main 7d6274f), and 4.5:1 or better everywhere else, so its
             contrast depended on the scroll position. */
          data-bottom-chrome=""
          className={`fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] ${nextUpClearOfSidebar} ${nextUpAboveTabBar}`}
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
                {activeVisit ? t("myDay.inProgress") : t("myDay.nextUp")}
                {/* A visit the office added after routing has no stop number
                    (sequence is null), and this printed "NEXT UP · #" with
                    nothing after it. No number, no "#". */}
                {nextUp.sequence != null && ` · #${nextUp.sequence}`}
              </div>
              {/* The customer's name in its own direction, as on the card. */}
              <div dir="auto" className="truncate text-sm font-semibold rtl:text-right">
                {nextUp.clients?.display_name}
              </div>
            </div>
            <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-md">
              {activeVisit ? t("myDay.resume") : t("myDay.jump")}{" "}
              <ArrowDown className="h-4 w-4 shrink-0" />
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
  const { t } = useTranslation();
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
      <div className="rounded-xl border bg-card p-(--card-pad) text-center text-sm text-muted-foreground">
        {visits.length === 0 ? t("map.nothingScheduled") : t("map.noCoordinates")}
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
            {t("map.loading")}
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
          {t("map.unmapped", { missing: visits.length - mappable.length, total: visits.length })}
        </div>
      )}
    </div>
  );
}

/** The age of the saved copy, in the tech's language. The buckets are
 *  read-cache-policy's, so this and the English `formatCacheAge` agree. */
function cacheAgeText(t: TFunction, ageMs: number): string {
  const age = cacheAgeParts(ageMs);
  return "count" in age
    ? t(`cacheAge.${age.unit}`, { count: age.count })
    : t(`cacheAge.${age.unit}`);
}

/** A skip reason code in the tech's language. A walk uses the walker labels
 *  (`walkSkipReason.<code>`), a lesson the trainer's (`lessonSkipReason.<code>`),
 *  a sit the sitter's (`sitSkipReason.<code>`). An unknown code is shown as-is. */
function skipReasonLabel(t: TFunction, code: string, line?: string): string {
  if (line === "pet_sitting") {
    const english = SIT_SKIP_REASON_LABELS[code as keyof typeof SIT_SKIP_REASON_LABELS];
    if (english) return t(`sitSkipReason.${code}`, { defaultValue: english });
  }
  if (line === "mobile_grooming") return t(`groomSkipReason.${code}`, { defaultValue: code });
  if (line === "dog_walking") {
    const english = WALK_SKIP_REASON_LABELS[code as keyof typeof WALK_SKIP_REASON_LABELS];
    if (english) return t(`walkSkipReason.${code}`, { defaultValue: english });
  }
  if (line === "training") {
    const english = LESSON_SKIP_REASON_LABELS[code as keyof typeof LESSON_SKIP_REASON_LABELS];
    if (english) return t(`lessonSkipReason.${code}`, { defaultValue: english });
  }
  const english = SKIP_REASON_LABELS[code as keyof typeof SKIP_REASON_LABELS];
  return english ? t(`skipReason.${code}`, { defaultValue: english }) : code;
}

/** A service line in the tech's language. One literal key per line, so
 *  tests/en-and-es-have-the-same-keys.test.ts can see every one of them. */
function serviceLineName(t: TFunction, line: ServiceLine): string {
  switch (line) {
    case "pet_waste":
      return t("serviceLine.pet_waste");
    case "dog_walking":
      return t("serviceLine.dog_walking");
    case "pet_sitting":
      return t("serviceLine.pet_sitting");
    case "mobile_grooming":
      return t("serviceLine.mobile_grooming");
    case "training":
      return t("serviceLine.training");
    default:
      return t("serviceLine.other");
  }
}

/** What the badge says when the status came from the device's queue rather than
 *  the server (`queuedStatus.*`). "Syncing" rather than "queued": the work is
 *  done, the tech can move on, and the only thing outstanding is the device
 *  telling the office. */
function statusBadge(status: string, queuedSync: LifecycleKind | undefined, t: TFunction) {
  const map: Record<string, string> = {
    scheduled: "bg-muted text-muted-foreground",
    // 700/800 on a /15 tint: the 600s were 3.16 (emerald) and 4.39 (blue)
    // on their own tints, and amber-700 4.48 (axe, gaps-r2-11 part 2).
    in_progress: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
    completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    skipped: "bg-amber-500/15 text-amber-800 dark:text-amber-400",
    canceled: "bg-destructive/10 text-destructive",
  };
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${map[status] ?? "bg-muted"}`}
    >
      {queuedSync
        ? t(`queuedStatus.${queuedSync}`)
        : t(`status.${status}`, { defaultValue: status.replace("_", " ") })}
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

/** Severity per hazard flag. The words are `hazard.<key>` in lib/i18n. */
const HAZARD_SEVERITY: Record<HazardKey, "critical" | "warn"> = {
  do_not_enter_if_dog_out: "critical",
  aggressive_dog: "critical",
  escape_risk: "critical",
  invisible_fence: "warn",
  dog_in_yard_during_service: "warn",
  bees_wasps: "warn",
  sharp_objects: "warn",
  slippery_surfaces: "warn",
};

function HazardBanner({ property, petWaste = true }: { property: any; petWaste?: boolean }) {
  const { t } = useTranslation();
  if (!property) return null;
  const active = (Object.keys(HAZARD_SEVERITY) as HazardKey[]).filter((k) => property[k]);
  const notes = property.hazard_notes as string | undefined;
  if (active.length === 0 && !notes) return null;
  const critical = active.filter((k) => HAZARD_SEVERITY[k] === "critical");
  const warn = active.filter((k) => HAZARD_SEVERITY[k] === "warn");
  return (
    <div className="mb-3 space-y-2">
      {critical.length > 0 && (
        <div className="rounded-md border-2 border-destructive bg-destructive/10 p-3">
          <div className="text-xs font-bold uppercase tracking-wide text-destructive">
            ⚠ {t("hazard.heading")}
          </div>
          <ul className="mt-1 space-y-0.5 text-sm font-semibold text-destructive">
            {critical.map((k) => (
              <li key={k}>
                •{" "}
                {t(
                  !petWaste &&
                    [
                      "do_not_enter_if_dog_out",
                      "aggressive_dog",
                      "escape_risk",
                      "invisible_fence",
                      "dog_in_yard_during_service",
                    ].includes(k)
                    ? `workerHazard.${k}`
                    : `hazard.${k}`,
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warn.length > 0 && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            {warn.map((k) => (
              <span key={k}>
                ⚠{" "}
                {t(
                  !petWaste &&
                    [
                      "do_not_enter_if_dog_out",
                      "aggressive_dog",
                      "escape_risk",
                      "invisible_fence",
                      "dog_in_yard_during_service",
                    ].includes(k)
                    ? `workerHazard.${k}`
                    : `hazard.${k}`,
                )}
              </span>
            ))}
          </div>
        </div>
      )}
      {notes && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-800 dark:text-amber-300">
          <span className="font-semibold">{t("hazard.notes")}</span> <bdi>{notes}</bdi>
        </div>
      )}
    </div>
  );
}

function ElapsedTimer({ startedAt }: { startedAt: string }) {
  const tz = useOrgTimezone();
  const { t } = useTranslation();
  const locale = useIntlLocale();
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
        {t("when.over8h", {
          time: sameDay
            ? orgLocalTime(startedAt, tz, locale)
            : orgLocalDayTime(startedAt, tz, locale),
        })}
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
  const { t } = useTranslation();
  const [imgFailed, setImgFailed] = useState(false);
  const state = imgFailed ? "error" : status;

  useEffect(() => {
    onUrl?.(imgFailed ? null : (url ?? null));
  }, [url, imgFailed, onUrl]);

  if (state === "error") {
    return (
      <div
        className="flex h-14 w-14 flex-col items-center justify-center rounded border bg-muted/50 text-center text-3xs leading-tight text-muted-foreground"
        title={t("photo.unavailableTitle")}
      >
        <span>{t("photo.unavailableLine1")}</span>
        <span>{t("photo.unavailableLine2")}</span>
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
      aria-label={t("photo.open")}
    >
      {/* A phone photo is 12 megapixels drawn 56px square. Sized, so the
          card never reflows when it arrives; lazy, so a long day does not
          decode every stop's photos up front; async, so decoding one never
          holds up a frame. */}
      <img
        src={url}
        alt={t("photo.alt")}
        width={56}
        height={56}
        loading="lazy"
        decoding="async"
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

/** "HH:MM[:SS]" wall-clock (property service window) → "8:00 AM", or
 *  "8:00 a.m." for a Spanish-speaking tech. formatClock does the work; this
 *  keeps the old "" for a value that is not a clock at all. */
function fmtWindowTime(hhmm: string, locale?: string): string {
  if (!/^(\d{1,2}):(\d{2})/.test(hhmm)) return "";
  return formatClock(hhmm, locale);
}

/** The best per-card time label: a computed ETA if the route was optimized,
 *  else the property's configured service window, else nothing. ETAs are
 *  instants, rendered on the ORG's clock; the window fallback is a `time`
 *  column and stays timezone-free. */
function visitWindowLabel(visit: any, tz: string, t: TFunction, locale?: string): string | null {
  // A booked start (a groom at 09:00) beats the route planner's estimate (#654).
  const eta = visitEta(visit, tz);
  if (eta.start) {
    const start = orgLocalTime(eta.start, tz, locale);
    const end = eta.end ? orgLocalTime(eta.end, tz, locale) : "";
    if (start) return end ? t("when.etaRange", { start, end }) : t("when.eta", { start });
  }
  const p = visit?.properties;
  const early = p?.earliest_service_time ? fmtWindowTime(p.earliest_service_time, locale) : "";
  const late = p?.latest_service_time ? fmtWindowTime(p.latest_service_time, locale) : "";
  if (early && late) return t("when.window", { early, late });
  if (early) return t("when.after", { time: early });
  if (late) return t("when.by", { time: late });
  return null;
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
          {/* A code is read left to right in every language: "*1234#" in an
              Arabic card would otherwise have its * and # moved to the far
              ends by the bidi algorithm. Free text (where the key is) keeps
              its own direction instead. */}
          {mono ? <span dir="ltr">{value}</span> : <bdi>{value}</bdi>}
        </div>
      </div>
    </div>
  );
}

function VisitCard({
  visit,
  dayVisits = [],
  index,
  day,
  preview = false,
  canText = false,
  onLogExpense,
}: {
  visit: any;
  /** The whole day, for a group walk's pickup order (WalkMeta). */
  dayVisits?: any[];
  index: number;
  day: string;
  preview?: boolean;
  /** The business has a texting number of its own (getMyDay). Without one,
   *  "Text reminder" could only fail, so it is not drawn. */
  canText?: boolean;
  /** Opens the page's one "Log an expense" sheet. Absent while previewing. */
  onLogExpense?: () => void;
}) {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const locale = useIntlLocale();
  // Whether THIS STOP is pet waste (#560): its own service's line, and for a
  // visit with no service, whether the business runs pet waste. A walk, a
  // sit, a groom or a lesson in a business that also scoops gets no yard
  // outline prompt, no stations, no DNA and the neutral hazard and photo
  // words (PET_WASTE_MODULES), the same as in a business that never scoops.
  const { petWaste: businessRunsPetWaste, lines: businessLines } = useServiceLines();
  const petWaste = isYardVisit(visit.services?.service_line, businessRunsPetWaste);
  const smsFn = useServerFn(sendVisitStatusSms);
  const onMyWayFn = useServerFn(sendOnMyWayMessage);
  const { role } = useMyRole();
  // Dispatcher schedules/routes but never performs field work — start/complete
  // is silently rejected server-side, which made those buttons look broken.
  // Preview mode (office role viewing another tech's day) also disables actions.
  const canPerformVisit = !preview && role !== "dispatcher";
  const isGroom = visit.services?.service_line === "mobile_grooming";

  const actions = useOfflineVisitActions(visit.id, visit.organization_id as string | undefined);
  // Billing an add-on is the one action on this card that is NOT queued when
  // the signal drops — start/complete/skip/photo all go to IndexedDB, this
  // goes straight to the server. The tech has no way to know that, so the card
  // has to say it. (Q-11 is whether it should queue at all; until that is
  // answered, refusing honestly beats failing with a network error.)
  const cardOnline = useOnline();
  const tz = useOrgTimezone();
  // A dog walk reads as a walk (components/my-day/WalkParts.tsx). Every other
  // stop, pet waste included, keeps its card exactly as it was.
  const walk = isWalkVisit(visit);
  const walkReport = useWalkReport(visit.id);
  // End walk with nothing in the report asks first (#610). It never refuses.
  const { confirm: confirmEndWalk, dialog: endWalkDialog } = useConfirmDialog();
  // A pet sitting visit reads as a sit (components/my-day/SitParts.tsx): the
  // stay, the pets' care, the care log. Its note for the client is the walk
  // report's note.
  const sit = isSitVisit(visit);
  const sitPets = useSitPets(visit);
  const sitCare = useSitCare(visit, sit);

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
  const dnaEnrolled = petWaste && !!visit.clients?.dna_compliance_enabled;
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
      toast.success(t("addon.billed"));
      setShowAddon(false);
      setAddonSvcId("");
      setAddonQty("1");
    },
    onError: (e: Error) => toast.error(readableError(e, t("common.notSaved"))),
  });
  const [reason, setReason] = useState("");
  const [reasonCode, setReasonCode] = useState("other");
  // What the tech tells the office on completion, why there is no photo when
  // the business requires one, and which checklist items were checked. All
  // three travel with the queued action.
  const { requireCompletionPhoto, checklist: orgChecklist } = useOrgFieldRules();
  // Only what THIS stop is asked (#565): the every-visit items and its own
  // line's. complete_visit filters the same way: no service is the business's
  // only line, or pet waste when it runs more than one.
  const visitLine = checklistLineOf(visit.services?.service_line, businessLines);
  const checklist = useMemo(
    () => checklistForLine(orgChecklist, visitLine),
    [orgChecklist, visitLine],
  );
  const [checkedItems, setCheckedItems] = useState<string[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noPhotoOpen, setNoPhotoOpen] = useState(false);
  const [noPhotoReason, setNoPhotoReason] = useState("");
  const [uploading, setUploading] = useState(false);
  // What this card has just done that the day's data has not caught up with:
  // a Start, a completion photo. Live, the refetch is in flight; queued, the
  // queue's change event is. Either way the card's one button moves on at
  // once instead of going back a step for a second (src/lib/visit-step.ts).
  const [startedHere, setStartedHere] = useState(false);
  const [completionPhotoHere, setCompletionPhotoHere] = useState(false);
  const [photoKind, setPhotoKind] = useState<PhotoKind>("completion");
  // Before a visit is started, a photo is the yard as found, so the picker
  // shows Before until the tech picks something else (#439: it opened on
  // Completion, and a "before" shot got filed as the finished yard). Once the
  // visit is under way it is `photoKind` again, which opens on Completion.
  const [photoKindChosen, setPhotoKindChosen] = useState(false);
  const shownPhotoKind: PhotoKind = !photoKindChosen
    ? defaultPhotoKind(visit.status, startedHere)
    : photoKind;
  // Which photo the in-app viewer is showing, and the signed URLs the
  // thumbnails have already fetched. Keyed by photo id rather than index so a
  // photo arriving mid-render cannot shift somebody else's URL onto it.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string | null>>({});
  const setPhotoUrl = useCallback((id: string, url: string | null) => {
    setPhotoUrls((m) => (m[id] === url ? m : { ...m, [id]: url }));
  }, []);
  const [pendingLocal, setPendingLocal] = useState(0);
  // Cash or checks this tech has queued here and the server has not seen, so
  // the card stops offering money that is already on its way to the office.
  const [queuedCollected, setQueuedCollected] = useState(0);
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
            queuedCollectionCents(visit.id, uid),
          ]),
        )
        .then(([pending, photos, collected]) => {
          if (cancelled) return;
          setPendingLocal(pending);
          setQueuedCompletionPhotos(photos);
          setQueuedCollected(collected);
        })
        .catch(() => {
          // No identity means no queue of our own to report.
          if (cancelled) return;
          setPendingLocal(0);
          setQueuedCompletionPhotos(0);
          setQueuedCollected(0);
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

  // ── The money, for the tech ───────────────────────────────────────────────
  // How the customer pays and what they owe come from my_day_stop_facts (a
  // tech cannot read invoices). What this tech has queued here counts as
  // already waiting, so a second tap in a dead zone is offered only what is
  // left.
  const facts = (visit.stop_facts ?? null) as StopFacts | null;
  const effectiveFacts = facts
    ? { ...facts, awaitingCents: facts.awaitingCents + queuedCollected }
    : null;
  const orgToday = useOrgToday();
  // The window record_field_collection allows: this visit's day is today or
  // one of the three before it, on the org's calendar. Outside it the button
  // would only queue a refusal.
  const inCollectWindow =
    day <= orgToday && daysBetweenOrgDays(day, orgToday) <= 3 && visit.status !== "canceled";
  const mayCollect = canPerformVisit && inCollectWindow;
  const [showCollect, setShowCollect] = useState(false);
  const collectFn = useServerFn(recordFieldCollection);
  const collect = useMutation({
    mutationFn: async (a: CollectAnswer) => {
      // Minted once, before the first attempt: the replay of a request that
      // landed after its deadline carries the same key and finds its row.
      const clientKey = newClientKey();
      return runOrQueue({
        online: !isDefinitelyOffline(),
        label: "Record collection",
        send: () => collectFn({ data: { visitId: visit.id, ...a, clientKey } }),
        queue: async () => {
          await enqueueAction({
            kind: "collection",
            visitId: visit.id,
            ...a,
            clientKey,
            userId: await resolveOfflineUserId(),
          });
        },
      });
    },
    onSuccess: (r) => {
      haptic("success");
      toast.success(r.queued ? t("pay.queuedToast") : t("pay.savedToast"));
      setShowCollect(false);
      if (!r.queued) invalidate();
    },
    onError: (e: Error) => {
      haptic("error");
      // The balance moved since the card loaded (the office applied a
      // payment, or another collection is waiting): say the most it can be,
      // in the tech's language.
      const owed = moreThanOwedFromRefusal(e.message);
      toast.error(
        owed != null
          ? t("pay.moreThanDue", { amount: formatMoney(owed, locale) })
          : readableError(e, t("common.notSaved")),
      );
    },
  });

  const start = useMutation({
    mutationFn: () => actions.start(),
    onSuccess: (r) => {
      haptic("select");
      // The owner's vaccine Start rule is "warn" (#729): started, and said so.
      const missing = petsMissingVaccines(
        (r.result as { vaccineWarnings?: MissingVaccine[] } | undefined)?.vaccineWarnings,
      );
      if (missing.length > 0)
        toast.warning(t("visit.vaccineStartWarn", { pets: missing.join(", ") }));
      else toast.success(r.queued ? t("visit.startQueued") : t("visit.started"));
      if (!r.queued) invalidate();
      // The button moves on to its next step now, not when the refetch (or
      // the queue's change event) lands. It does NOT open the camera: that
      // is the next tap's, if the visit needs a photo (src/lib/visit-step.ts).
      setStartedHere(true);
    },
    onError: (e: Error) => {
      haptic("error");
      // The owner's vaccine Start rule is "block" (#729).
      toast.error(
        isVaccineStartBlocked(e)
          ? t("visit.vaccineStartBlocked")
          : readableError(e, t("common.notSaved")),
      );
    },
  });
  const completeToast = (r: { queued: boolean; result?: unknown }) => {
    if (r.queued) return t("visit.completeQueued");
    const summary = (r.result as any)?.notificationSummary as
      { sent?: string[]; pending?: boolean } | undefined;
    const sent = summary?.sent ?? [];
    const labels = sent
      .map((name) =>
        name === "completion_email"
          ? t("visit.noticeCompletionEmail")
          : name === "push"
            ? t("visit.noticePush")
            : name === "review_sms"
              ? t("visit.noticeReviewSms")
              : name === "review_email"
                ? t("visit.noticeReviewEmail")
                : name,
      )
      .join(", ");
    if (summary?.pending) {
      return sent.length > 0
        ? t("visit.completedWithNoticesPending", { notices: labels })
        : t("visit.completedNoticePending");
    }
    if (sent.length === 0) return t("visit.completedNoNotices");
    return t("visit.completedWithNotices", { notices: labels });
  };
  const complete = useMutation({
    mutationFn: async () => {
      // A walk's report goes first, so the completion email is written from
      // it (#410). Queued, the completion queues behind it, never ahead.
      const reportQueued = (walk || sit) && (await walkReport.send()).queued;
      // A sit's care entries still on the device go first as well (#411).
      const careQueued = sit && (await sitCare.hasQueued());
      return actions.complete({
        note: note.trim() || undefined,
        noPhotoReason: photoOnFile ? undefined : noPhotoReason.trim() || undefined,
        // Only ids still on the owner's list: a tick left over from an item
        // the owner has since removed means nothing to complete_visit.
        checkedItems:
          checklist.length > 0
            ? checkedItems.filter((id) => checklist.some((i) => i.id === id))
            : undefined,
        queueOnly: reportQueued || careQueued,
      });
    },
    onSuccess: (r) => {
      haptic("success");
      showCompletionCheck();
      toast.success(completeToast(r));
      walkReport.reset();
      setCheckedItems([]);
      setNote("");
      setNoteOpen(false);
      setNoPhotoReason("");
      setNoPhotoOpen(false);
      if (!r.queued) invalidate();
    },
    onError: (e: Error) => {
      haptic("error");
      toast.error(readableError(e, t("common.notSaved")));
    },
  });
  const skip = useMutation({
    mutationFn: () => actions.skip(reason, reasonCode),
    onSuccess: (r) => {
      haptic("warning");
      toast.success(r.queued ? t("visit.skipQueued") : t("visit.markedSkipped"));
      setShowSkip(false);
      if (!r.queued) invalidate();
    },
    onError: (e: Error) => {
      haptic("error");
      toast.error(readableError(e, t("skip.notSaved")));
    },
  });
  // Text if it can go, email if not; the result says which.
  const onMyWay = useMutation({
    mutationFn: () => onMyWayFn({ data: { visitId: visit.id, trigger: "button" } }),
    onSuccess: (r) => {
      haptic("select");
      toast.success(
        r.sent && r.channel === "email" ? t("visit.onMyWayEmailed") : t("visit.onMyWayTexted"),
      );
    },
    onError: (e: Error) => {
      haptic("error");
      toast.error(readableError(e, t("common.notSaved")));
    },
  });
  // Navigate tells the customer too, once per visit, when the owner has
  // turned it on (Settings → Automation). Fire-and-forget: the map opens
  // whatever happens here, and offline it is not attempted at all, because an
  // "on my way" that arrives when signal returns, after the visit, is worse
  // than none.
  const announceOnNavigate = () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    onMyWayFn({ data: { visitId: visit.id, trigger: "navigate" } })
      .then((r) => {
        if (r.sent)
          toast.success(
            r.channel === "email" ? t("visit.onMyWayEmailed") : t("visit.onMyWayTexted"),
          );
      })
      .catch((e) => console.warn("on-my-way on navigate failed", visit.id, e));
  };
  const sms = useMutation({
    mutationFn: (kind: "reminder" | "completed") => smsFn({ data: { visitId: visit.id, kind } }),
    onSuccess: () => {
      haptic("select");
      toast.success(t("visit.smsSent"));
    },
    onError: (e: Error) => {
      haptic("error");
      toast.error(readableError(e, t("common.notSaved")));
    },
  });

  const uploadPhoto = async (file: File, kindOverride?: PhotoKind): Promise<boolean> => {
    const photoKind_ = kindOverride ?? shownPhotoKind;
    setUploading(true);
    try {
      const r = await actions.uploadPhoto(file, photoKind_);
      haptic("tap");
      // The kind in the picker's own words ("Gate latched", "Terminado"), so
      // the toast names the photo the way the tech just chose it.
      const kind =
        !petWaste && photoKind_ === "gate"
          ? t("workerNeutral.gate")
          : t(`photoKind.${photoKind_}`, { defaultValue: photoKindLabel(photoKind_) });
      toast.success(
        r.queued ? t("photo.queuedToast", { kind }) : t("photo.uploadedToast", { kind }),
      );
      if (!r.queued) invalidate();
      // Live only. A queued one is counted by queuedCompletionPhotos, which
      // also lets go of it if the queue gives up on it -- a flag here would
      // not, and would hold Complete open on a photo the server never got.
      if (!r.queued && photoKind_ === "completion") setCompletionPhotoHere(true);
      // Back to the kind that finishes the visit. The picker used to keep
      // whatever was chosen last, so a tech who shot a Before filed every
      // photo after it as a Before too — including the one they took to
      // finish the job. The Complete button stayed locked, the hint below it
      // kept asking for a completion photo, and the only clue that anything
      // was wrong was the word "Before" in a toast that had already gone.
      setPhotoKind("completion");
      setPhotoKindChosen(false);
      return true;
    } catch (e: any) {
      haptic("error");
      toast.error(readableError(e, t("photo.uploadFailed")));
      return false;
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
  const photoOnFile = hasCompletionPhoto || hasQueuedCompletionPhoto || completionPhotoHere;
  // The rule complete_visit enforces: a photo, or no photo required, or a
  // stated reason there is none.
  const photoRuleMet = photoOnFile || !requireCompletionPhoto || noPhotoReason.trim().length >= 3;
  // The rule complete_visit enforces for the checklist: every required item
  // checked. The server refuses otherwise, and a refused REPLAY is not a
  // network error, so letting Complete through offline would queue a
  // completion that is dead-lettered on reconnect.
  const uncheckedRequired = missingRequired(checklist, checkedItems);
  const checklistRuleMet = uncheckedRequired.length === 0;
  const done = visit.status === "completed";
  const skipped = visit.status === "skipped";
  const inProg = visit.status === "in_progress";
  const scheduled = visit.status === "scheduled";
  // Auto-marked missed overnight. Still completable — see the note on the
  // Complete button — because the work may well have been done.
  const missed = visit.status === "missed";
  const finalStatus = done || skipped;
  // A completed card shows what was checked: the server's record once it has
  // one, and until then the answers waiting in the offline queue, drawn
  // against the list they were given for.
  const completedAnswers = done
    ? (parseAnswers(visit.visit_checklist) ??
      (visit.queuedCheckedItems ? answersFor(checklist, visit.queuedCheckedItems) : null))
    : null;
  const p = visit.properties;
  // Waste stations only exist on commercial or multi-unit properties. On a
  // residential card there are never any, so the button never appears.
  // And only on a pet-waste stop: a walker at an apartment complex has no bags
  // to count.
  const hasStations = petWaste && (p?.account_type === "commercial" || !!p?.has_units);
  const windowLabel = visitWindowLabel(visit, tz, t, locale);
  const service = visitServiceLabel(visit.services);
  const walkStop = service?.line === "dog_walking";
  // A stop that is not pet waste and has no line of its own (no service, or
  // "other") gets the sitter's list, which has no gate or yard in it.
  const skipLine =
    !petWaste && (!service || service.line === "other") ? "pet_sitting" : service?.line;
  const skipCodes = techSkipReasonCodes(skipLine);

  // ── ONE BUTTON WALKS THE VISIT (src/lib/visit-step.ts) ─────────────────
  //
  // Start, then "Take completion photo" where the business requires one and
  // there is none, then Complete: the same button, in the same place, with a
  // new label at each step. Nothing opens the camera but a tap on the photo
  // step. #357 had Start open it by itself and put a second "Take photo to
  // complete" button beside a greyed Complete; the owner asked for this.
  //
  // Under way: started on the server, in the queue, or on this card a moment
  // ago. A missed visit counts -- complete_visit still accepts it.
  const underWay = inProg || missed || (scheduled && startedHere);
  const step = visitStep({
    status: visit.status,
    startedHere,
    requireCompletionPhoto,
    photoOnFile,
    noPhotoReasonGiven: noPhotoReason.trim().length >= 3,
    canPerform: canPerformVisit,
  });
  // The web's camera is the file input below; this is who is waiting on it.
  const webCapture = useRef<((f: File | null) => void) | null>(null);
  const pickFromWebInput = () =>
    new Promise<File | null>((resolve) => {
      webCapture.current?.(null);
      webCapture.current = resolve;
      fileInput.current?.click();
    });

  // The camera, because the tech tapped for it. Saved as the completion
  // photo, live or queued; the button then reads Complete. Not held "busy"
  // while the camera is open: a browser may decline to open the picker, and
  // a button disabled until a picker that never opened answers would be a
  // dead card. A second tap re-asks instead (pickFromWebInput lets the first
  // wait go); while the photo uploads, `uploading` holds the button.
  const tapPhotoStep = async () => {
    setPhotoKind("completion");
    await takeCompletionPhoto({
      capture: () => captureCompletionFile(pickFromWebInput),
      upload: (file) => uploadPhoto(file, "completion"),
    });
  };

  const tapStep = async () => {
    if (!step) return;
    if (!canPerformVisit) {
      toast.error(
        step === "start" ? t("visit.notAuthorizedStart") : t("visit.notAuthorizedComplete"),
      );
      return;
    }
    // End walk with nothing in the report asks first (#610). Cancel leaves the
    // walk open to fill it in; End anyway goes on. It never refuses.
    if (
      step === "complete" &&
      walk &&
      !(await confirmEndWithEmptyReport(walkReport, () =>
        confirmEndWalk({
          title: t("walk.emptyReportTitle"),
          description: t("walk.emptyReportBody"),
          confirmLabel: t("walk.endAnyway"),
          cancelLabel: t("walk.addReport"),
        }),
      ))
    )
      return;
    // A stop on a later day asks first (#654, F-23). Completing ahead is
    // allowed, a tech who got ahead; one stray tap is not.
    if (
      step === "complete" &&
      isFutureVisit(visit.scheduled_on, orgToday) &&
      !(await confirmEndWalk({
        title: t("visit.earlyCompleteTitle"),
        description: t("visit.earlyCompleteBody", {
          day: formatDay(visit.scheduled_on, locale, tz),
        }),
        confirmLabel: t("visit.earlyCompleteConfirm"),
        cancelLabel: t("common.cancel"),
      }))
    )
      return;
    void runVisitStep(step, {
      start: () => start.mutate(),
      photo: () => {
        haptic("tap");
        return tapPhotoStep();
      },
      complete: () => complete.mutate(),
    });
  };

  // Why the button is grey, as a title (a tooltip, for a mouse) and, for a
  // phone, as the line under it.
  const stepDisabled =
    !canPerformVisit ||
    (step === "start" && start.isPending) ||
    (step === "photo" && uploading) ||
    (step === "complete" &&
      (!photoRuleMet ||
        !checklistRuleMet ||
        complete.isPending ||
        // `missed` belongs here. complete_visit has accepted
        // ('scheduled','in_progress','missed') since 20260804060000 --
        // widened deliberately, so a tech who did the work and forgot to
        // close it can come back to yesterday and record it. There are
        // 2,001 missed visits in production.
        (!inProg && !scheduled && !missed)));
  const stepTitle = !canPerformVisit
    ? step === "start"
      ? t("visit.notAuthorizedStartTitle")
      : t("visit.notAuthorizedCompleteTitle")
    : step === "complete" && !photoRuleMet
      ? t("visit.needCompletionPhotoTitle")
      : step === "complete" && !checklistRuleMet
        ? t("visit.needChecklistTitle")
        : "";
  const stepLabel =
    step === "start"
      ? walk
        ? t("walk.start")
        : sit
          ? sitStepLabel(t, visit.sit_facts, "start")
          : t("myDay.start")
      : step === "photo"
        ? uploading
          ? t("photo.uploading")
          : t("visit.takeCompletionPhotoStep")
        : walk
          ? t("walk.end")
          : sit
            ? sitStepLabel(t, visit.sit_facts, "end")
            : t("myDay.complete");

  // The owner's checklist, as rows. Each row is the label AND the box, 44px
  // tall at every width, so a gloved thumb anywhere on the line ticks it --
  // the box alone is 16px. The label wraps rather than truncates: it is a
  // sentence the owner wrote to be read, and at 320px a long one has to stay
  // inside the card.
  const checklistRows = () =>
    checklist.map((item) => {
      const id = `checklist-card-${visit.id}-${item.id}`;
      const on = checkedItems.includes(item.id);
      return (
        <label
          key={item.id}
          htmlFor={id}
          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 active:bg-accent"
        >
          <Checkbox
            id={id}
            checked={on}
            onCheckedChange={(v) =>
              setCheckedItems((prev) =>
                v === true
                  ? [...prev.filter((x) => x !== item.id), item.id]
                  : prev.filter((x) => x !== item.id),
              )
            }
          />
          <span className="min-w-0 flex-1 text-sm leading-snug [overflow-wrap:anywhere]">
            <bdi>{item.label}</bdi>
            {item.required && (
              <span className="text-xs text-muted-foreground"> · {t("visit.required")}</span>
            )}
          </span>
        </label>
      );
    });

  // The photo control appears in two places — on the card once the visit is
  // under way, behind More before that — so it is written once. A FUNCTION
  // and not a component: an inline component is a new type on every render, which would
  // unmount and remount the select and close it under the tech's thumb.
  const photoCapture = () => (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={shownPhotoKind}
        onChange={(e) => {
          setPhotoKind(e.target.value as PhotoKind);
          setPhotoKindChosen(true);
        }}
        // MEASURED 2026-08-19: 40px, four short of the floor, on the
        // screen a technician uses outdoors with gloves on.
        className="h-11 rounded-md border bg-background px-3 text-sm"
        aria-label={t("photo.type")}
      >
        {PHOTO_KIND_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {!petWaste && o.value === "gate"
              ? t("workerNeutral.gate")
              : t(`photoKind.${o.value}`, { defaultValue: o.label })}
          </option>
        ))}
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
          } catch (e) {
            // A cancelled camera is a no; anything else falls through to
            // the web input.
            if (/cancel/i.test(String((e as { message?: string })?.message ?? e))) return;
          }
          fileInput.current?.click();
        }}
      >
        <Camera className="me-1.5 h-4 w-4 shrink-0" />
        {uploading ? t("photo.uploading") : t("photo.take")}
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
      // No entrance of its own: the list it is in (motion-list) animates a
      // stop added mid-session and leaves the day's first paint alone. No
      // shadow transition either: box-shadow is a repaint on every frame.
      className={`scroll-mt-40 rounded-xl border bg-card p-4 shadow-sm ${inProg ? "ring-2 ring-blue-500/40 shadow-md" : ""}`}
    >
      {!collapsed && <HazardBanner property={p} petWaste={petWaste} />}
      {!preview && <EnRouteLocationChip visit={visit} />}

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
            <span className="sr-only">{t("visit.stop", { number: visit.sequence ?? index })}</span>
            {statusBadge(visit.status, visit.queuedSync, t)}
            {isGroom && Number(visit.duration_min) > 0 && (
              <span dir="ltr" className="font-medium text-foreground">
                {t("visit.appointmentMinutes", { minutes: visit.duration_min })}
              </span>
            )}
            {isGroom && visit.start_time && (
              <span className="font-medium text-foreground">
                {t("groom.startsAt", {
                  time: formatClock(String(visit.start_time).slice(0, 5), locale),
                })}
              </span>
            )}
            {service && (
              // What this stop is: the line in the tech's language, then the
              // business's own name for it, untranslated and in its own
              // direction. The seeded "Pet waste removal" is ours, so the
              // translated line says it alone.
              <span className="min-w-0 truncate font-medium text-foreground">
                {serviceLineName(t, service.line)}
                {service.ownName && (
                  <>
                    {" · "}
                    <bdi>{service.ownName}</bdi>
                  </>
                )}
              </span>
            )}
            <TrainingSessionBadge visitId={visit.id} serviceLine={service?.line} />
            {visit.zones?.name && <span className="truncate">{visit.zones.name}</span>}
            {pendingLocal > 0 && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-3xs font-medium text-amber-700 dark:text-amber-400">
                {t("visit.queuedCount", { count: pendingLocal })}
              </span>
            )}
            {inProg && visit.started_at && walk && <WalkTimer startedAt={visit.started_at} />}
            {inProg && visit.started_at && !walk && (
              // Larger + bolder than the meta row: techs read this outdoors
              // in sunlight (P2 field-readiness).
              <span className="inline-flex items-center gap-1 text-sm font-semibold text-blue-700 dark:text-blue-300">
                <Timer className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
            {/* <bdi>: an address or a name is the customer's text, in
                whatever script they wrote it. Isolated, it keeps its own
                order ("12 Elm St.", "Smith (rental)") inside an Arabic card
                instead of borrowing the card's right-to-left. */}
            <bdi>{p?.street ?? visit.clients?.display_name ?? t("visit.fallbackTitle")}</bdi>
          </div>
          {/* All the customer's own text, so it takes ITS direction, not the
              page's (dir="auto"): in Arabic a long English name truncates at
              its own end -- "Chicago 60611 · Chesterfield Prop…" -- instead
              of losing its first word off the left. Still right-aligned there,
              under the address. */}
          <div dir="auto" className="truncate text-sm text-muted-foreground rtl:text-right">
            {[p?.city, p?.postal_code].filter(Boolean).join(" ")}
            {p?.city || p?.postal_code ? " · " : ""}
            {visit.clients?.display_name ?? t("visit.fallbackClient")}
          </div>
          {!collapsed && (
            <TrainingProgressPanel visitId={visit.id} serviceLine={service?.line} />
          )}

          {/* When this stop is expected, and how big the yard is — one line of
              context, wrapping rather than stacking.

              Yard size used to sit in the bordered access block below with the
              gate code and the key. It is not a credential: nobody squints at
              "Extra large" through a windscreen, and on a property with no
              code and no key it was the block's only occupant, which drew a
              framed panel around one word. The block is for things you have to
              read correctly to get in. */}
          {(windowLabel || p?.yard_size) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {windowLabel && (
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  {windowLabel}
                </span>
              )}
              {p?.yard_size && (
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Ruler className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {t("yard.label", {
                    size:
                      p.yard_size in YARD_SIZE_LABELS
                        ? t(`yard.${p.yard_size}`, {
                            defaultValue: YARD_SIZE_LABELS[p.yard_size as YardSizeCategory],
                          })
                        : p.yard_size,
                  })}
                </span>
              )}
            </div>
          )}
          {walk && <WalkMeta visit={visit} dayVisits={dayVisits} />}
          {sit && <SitMeta visit={visit} locale={locale} />}
          {/* The stay's notes from booking, before anything else about the
              night, and outside the collapse so a folded card still shows
              them (#618). */}
          {sit && <SitStayNotes visit={visit} />}

          {!collapsed && (
            <>
              {/* A groom leads with each pet: muzzle, bite history, vaccines on
                  this date, and what was done last time. */}
              {isGroom && (
                <GroomPetPanel
                  visitId={visit.id}
                  dogs={p?.dogs}
                  facts={visit.groom_pets}
                  bookedDogIds={visit.groom_dog_ids}
                  locale={locale}
                  canWrite={underWay && canPerformVisit}
                />
              )}
              {/* The customer's answer to "on my way": ENT, the dogs are in;
                  DNE, do not enter. Above the dogs and the gate code, because
                  it is what decides whether those get used at all. */}
              {visit.gate_reply && !done && !skipped && (
                <div
                  role="status"
                  className={`mt-2.5 flex items-start gap-2 rounded-lg border p-2.5 text-sm font-medium ${
                    visit.gate_reply === "do_not_enter"
                      ? "border-destructive/40 bg-destructive/10 text-destructive"
                      : "border-emerald-600/30 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300"
                  }`}
                >
                  {visit.gate_reply === "do_not_enter" ? (
                    <Ban className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0">
                    {visit.gate_reply === "do_not_enter"
                      ? t("visit.customerSaysDoNotEnter")
                      : t(sit ? "visit.customerSaysPetsSecured" : "visit.customerSaysDogsSecured")}
                    {visit.gate_reply_at
                      ? ` (${orgLocalTime(visit.gate_reply_at, tz, locale)})`
                      : ""}
                  </span>
                </div>
              )}
              {/* Dogs on site (H1 safety gap): name + temperament belongs next
                  to hazards, on residential cards too, so the tech knows what
                  they're walking into. Never silent: the priced count when
                  there are no dog records, "No dogs on file" when there is
                  neither -- see DogsLine. */}
              {sit ? (
                <>
                  <SitPetsCare pets={sitPets} tz={tz} locale={locale} />
                  <SitEmergencyFacts emergency={sitEmergency(visit.clients)} locale={locale} />
                </>
              ) : (
                <DogsLine dogs={p?.dogs} dogCount={facts?.dogCount} pets={service?.line === "pet_sitting"} />
              )}
              {isGroom && visit.groom_summary && (
                <p className="mt-1 min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  <bdi>{visit.groom_summary}</bdi>
                </p>
              )}
              {/* The household's last visit note, for grooms from before
                  per-pet notes. Each pet's own history replaces it. */}
              {isGroom &&
                visit.prior_groom_note &&
                !(visit.groom_pets ?? []).some(
                  (pet: { history: unknown[] }) => pet.history.length > 0,
                ) && (
                  <div className="mt-2 rounded-lg border bg-muted/30 p-2.5 text-sm">
                    <div className="text-xs font-medium text-muted-foreground">
                      {t("visit.priorGroom")}
                      {visit.prior_groom_on ? (
                        <span className="ms-1 font-normal">
                          {formatDay(visit.prior_groom_on, locale)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                      <bdi>{visit.prior_groom_note}</bdi>
                    </p>
                  </div>
                )}

              {(walk || sit) && <WalkAccess property={p} />}
              {/* Getting in. One block, bordered, at a size that survives
                  sunlight and gloves — see AccessFact. */}
              {sit && <SitCodesHint visit={visit} locale={locale} />}
              {(p?.gate_code || p?.lock_box_code || p?.key_location || p?.alarm_notes) && (
                <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-lg border bg-muted/30 p-2.5">
                  {p?.gate_code && (
                    <AccessFact icon={Fence} label={t("access.gate")} value={p.gate_code} mono />
                  )}
                  {p?.lock_box_code && (
                    <AccessFact
                      icon={LockKeyhole}
                      label={t("access.lockBox")}
                      value={p.lock_box_code}
                      mono
                    />
                  )}
                  {p?.key_location && (
                    <div className="col-span-2">
                      <AccessFact icon={KeyRound} label={t("access.key")} value={p.key_location} />
                    </div>
                  )}
                  {p?.alarm_notes && (
                    <div className="col-span-2">
                      <AccessFact icon={BellRing} label={t("access.alarm")} value={p.alarm_notes} />
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
              {/* The yard's sketched outline, as a drawing; the map loads only
                  when it is opened. "No yard outline yet" when nobody has
                  sketched one, rather than nothing. */}
              <YardOutline
                boundary={p?.boundary}
                areaSqm={p?.boundary_area_sqm}
                title={p?.street ?? visit.clients?.display_name ?? t("visit.fallbackTitle")}
                locale={locale}
                promptWhenMissing={petWaste}
              />
              {/* What the office sees on the client's stations panel: how many,
                  which, and when each was last serviced. */}
              {hasStations && <StationsSummary stations={p?.waste_stations} locale={locale} />}
              {/* How this customer pays and what they owe. Absent only when the
                  day was fetched without the facts (an older saved copy). */}
              {effectiveFacts && (
                <PaymentLine
                  facts={effectiveFacts}
                  locale={locale}
                  // On a stop not yet started the button waits under More
                  // options with the other occasional actions; once the visit
                  // is under way or done, it is here beside what is owed.
                  onCollect={
                    mayCollect && !showCollect && !scheduled
                      ? () => setShowCollect(true)
                      : undefined
                  }
                />
              )}
              {effectiveFacts && mayCollect && showCollect && (
                <div className="mt-2">
                  <CollectForm
                    idPrefix={`collect-${visit.id}`}
                    dueCents={dueCents(effectiveFacts)}
                    locale={locale}
                    pending={collect.isPending}
                    onSubmit={(a) => collect.mutate(a)}
                    onCancel={() => setShowCollect(false)}
                  />
                </div>
              )}
              {skipped && (
                <div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  {t("visit.skipped")}
                  {/* The TIME it was skipped, which for a queued skip replayed
                      on reconnect is hours before the row was written. Null on
                      every skip recorded before `skipped_at` existed, so it is
                      rendered only when present rather than falling back to a
                      row timestamp that would mean something else. */}
                  {visit.skipped_at
                    ? t("visit.skippedAt", { time: orgLocalTime(visit.skipped_at, tz, locale) })
                    : ""}
                  {visit.skip_reason_code
                    ? ` (${skipReasonLabel(t, visit.skip_reason_code, skipLine)})`
                    : ""}
                  {visit.skip_reason ? ": " : ""}
                  {visit.skip_reason ? <bdi>{visit.skip_reason}</bdi> : null}
                </div>
              )}
            </>
          )}
        </div>

        {finalStatus && (
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={collapsed ? t("visit.expand") : t("visit.collapse")}
          >
            {collapsed ? (
              <ChevronDown className="h-5 w-5 shrink-0" />
            ) : (
              <ChevronUp className="h-5 w-5 shrink-0" />
            )}
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
              onClick={announceOnNavigate}
              className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border bg-background px-3 text-sm font-semibold transition-colors hover:bg-accent active:bg-accent ${
                visit.clients?.primary_phone ? "" : "col-span-2"
              }`}
            >
              <Navigation className="h-4 w-4 shrink-0" aria-hidden="true" /> {t("visit.navigate")}
            </a>
          )}
          {visit.clients?.primary_phone && (
            <a
              href={`tel:${visit.clients.primary_phone}`}
              className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border bg-background px-3 text-sm font-semibold transition-colors hover:bg-accent active:bg-accent ${
                p?.street ? "" : "col-span-2"
              }`}
            >
              <Phone className="h-4 w-4 shrink-0" aria-hidden="true" /> {t("myDay.call")}
            </a>
          )}
        </div>
      )}

      {/* On a stop not yet started it waits under More options with the
          other occasional actions; once the visit is under way or done, it
          is here on the card. */}
      {!collapsed && !scheduled && visit.client_id && (
        <Link
          to="/clients/$clientId"
          params={{ clientId: visit.client_id }}
          className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border bg-background px-3 text-sm font-semibold transition-colors hover:bg-accent active:bg-accent"
        >
          <ListIcon className="h-4 w-4 shrink-0" aria-hidden="true" /> {t("visit.clientInfo")}
        </Link>
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
              <span className="pointer-events-none absolute -bottom-1 -end-1 rounded bg-background px-1 text-3xs uppercase text-muted-foreground shadow-sm">
                {!petWaste && ph.kind === "gate"
                  ? t("workerNeutral.gate")
                  : t(`photoKind.${ph.kind}`, { defaultValue: photoKindLabel(ph.kind) })}
              </span>
            </div>
          ))}
        </div>
      )}

      {!collapsed && completedAnswers && completedAnswers.length > 0 && (
        <div className="mt-3">
          <VisitChecklistAnswers answers={completedAnswers} />
        </div>
      )}

      <PhotoLightbox
        photos={photos.map((ph: any) => ({ url: photoUrls[ph.id] ?? null, kind: ph.kind }))}
        openIndex={lightboxIndex}
        onClose={() => setLightboxIndex(null)}
        staff
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
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              // The button's photo step is waiting on this picker: hand it
              // the file (or the cancel) and let it upload the photo.
              const waiting = webCapture.current;
              if (waiting) {
                webCapture.current = null;
                waiting(f);
                return;
              }
              if (f) uploadPhoto(f);
            }}
            ref={(el) => {
              fileInput.current = el;
              if (el && !el.dataset.cancelWired) {
                el.dataset.cancelWired = "1";
                el.addEventListener("cancel", () => {
                  const waiting = webCapture.current;
                  webCapture.current = null;
                  waiting?.(null);
                });
              }
            }}
          />

          {/* ── THE ONE BUTTON ─────────────────────────────────────────────
              Start, then "Take completion photo" (only where the business
              requires one and there is none), then Complete -- this one
              element, in this one place, its label and its action moving on
              with the visit (src/lib/visit-step.ts). Nothing beside it does
              the same job. The camera opens only on a tap at the photo step;
              Start never opens it, and nor does the lock screen, which lands
              here. The label may wrap: "Take completion photo" in Spanish or
              Arabic is longer than a 320px card. */}
          {step && (
            <Button
              type="button"
              className="h-auto min-h-12 w-full min-w-0 whitespace-normal py-2 text-base"
              disabled={stepDisabled}
              title={stepTitle}
              data-visit-step={step}
              onClick={tapStep}
            >
              {step === "photo" && <Camera className="h-4 w-4 shrink-0" aria-hidden="true" />}
              {stepLabel}
            </Button>
          )}

          {/* Why the button is grey, UNDER it: `title` is a tooltip, and a
              phone has no hover. One sentence with a singular and a plural
              (visit.tickRequired_one/_other). */}
          {step === "complete" && canPerformVisit && !checklistRuleMet && (
            <p className="-mt-1 text-center text-xs text-muted-foreground">
              {t("visit.tickRequired", { count: uncheckedRequired.length })}
            </p>
          )}
          {/* No photo, and a reason why: secondary, under the photo step, as
              it has always been. A reason long enough for complete_visit and
              the button above moves on to Complete; the box stays open so
              the tech can still read and change what they wrote. */}
          {underWay && canPerformVisit && requireCompletionPhoto && !photoOnFile && (
            <div className="-mt-1">
              {noPhotoOpen ? (
                <div>
                  <Label htmlFor={`no-photo-${visit.id}`} className="text-xs">
                    {t("visit.whyNoPhoto")}
                  </Label>
                  <Input
                    id={`no-photo-${visit.id}`}
                    maxLength={300}
                    placeholder={t("visit.noPhotoPlaceholder")}
                    value={noPhotoReason}
                    onChange={(e) => setNoPhotoReason(e.target.value)}
                  />
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 w-full text-xs text-muted-foreground"
                  onClick={() => setNoPhotoOpen(true)}
                >
                  {t("visit.cantTakePhoto")}
                </Button>
              )}
            </div>
          )}

          {/* The other photo kinds -- before, gate latched, a problem -- with
              their own picker, where they have always been. Secondary
              (outline): the completion photo the visit needs is the button
              above. */}
          {underWay && photoCapture()}

          {/* The owner's checklist is visible on the open stop before Complete
              can be pressed. Complete waits for its required items. Absent
              entirely for an org with no checklist. */}
          {canPerformVisit && checklist.length > 0 && (
            <fieldset className="space-y-0.5 rounded-lg border p-1.5">
              <legend className="px-1.5 text-xs font-semibold uppercase text-muted-foreground">
                {t("visit.checklist")}
              </legend>
              {checklistRows()}
            </fieldset>
          )}

          {walk && underWay && canPerformVisit && (
            <WalkReportFields visitId={visit.id} report={walkReport} />
          )}
          {walk && endWalkDialog}

          {sit && underWay && canPerformVisit && (
            <>
              <SitCareLog visit={visit} pets={sitPets} care={sitCare} tz={tz} locale={locale} />
              <SitNoteField visitId={visit.id} report={walkReport} />
            </>
          )}

          {underWay && canPerformVisit && (
            <div className="space-y-2">
              {noteOpen ? (
                <div>
                  <Label htmlFor={`visit-note-${visit.id}`} className="text-xs">
                    {t("visit.noteLabel")}
                  </Label>
                  <Textarea
                    id={`visit-note-${visit.id}`}
                    // Typed text takes the direction of its first letter, so
                    // an English note in the Arabic app reads left to right.
                    dir="auto"
                    rows={2}
                    maxLength={1000}
                    placeholder={t(
                      petWaste ? "visit.notePlaceholder" : "workerNeutral.notePlaceholder",
                    )}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 w-full text-sm text-muted-foreground"
                  onClick={() => setNoteOpen(true)}
                >
                  {t("visit.addNote")}
                </Button>
              )}
            </div>
          )}

          {missed && <p className="text-xs text-muted-foreground">{t("visit.missedNote")}</p>}

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
                {t("myDay.stations")}
              </Button>
            )}
            {(inProg || missed) && dnaEnrolled && canPerformVisit && (
              <Button variant="outline" className="h-11" onClick={() => setShowDna((s) => !s)}>
                {t("visit.dnaSample")}
              </Button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setShowMore((m) => !m)}
            aria-expanded={showMore}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {showMore ? t("visit.fewerOptions") : t("visit.moreOptions")}
            {showMore ? (
              <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}
          </button>

          {showMore && (
            <div className="space-y-3 rounded-lg border bg-muted/20 p-2.5">
              {scheduled && photoCapture()}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-11 px-4"
                  onClick={() => setShowSkip((s) => !s)}
                >
                  {t("myDay.skip")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 px-4 sm:h-8 sm:px-3"
                  onClick={() => setShowAddon((s) => !s)}
                >
                  + {t("visit.addOn")}
                </Button>
                {/* Cash or a check handed over before the visit started.
                    Opens the same form, beside what is owed, up the card. */}
                {scheduled &&
                  mayCollect &&
                  effectiveFacts &&
                  dueCents(effectiveFacts) > 0 &&
                  !showCollect && (
                    <Button
                      size="sm"
                      variant="outline"
                      // 44px at every width: a crew iPad is a finger too.
                      className="h-11 px-4"
                      onClick={() => setShowCollect(true)}
                    >
                      {t("pay.collect")}
                    </Button>
                  )}
                {scheduled && dnaEnrolled && canPerformVisit && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-11 px-4 sm:h-8 sm:px-3"
                    onClick={() => setShowDna((s) => !s)}
                  >
                    {t("visit.dnaSample")}
                  </Button>
                )}
                {scheduled && visit.client_id && (
                  <Link
                    to="/clients/$clientId"
                    params={{ clientId: visit.client_id }}
                    className="inline-flex h-11 items-center justify-center gap-1.5 rounded-md border bg-background px-4 text-sm font-medium transition-colors hover:bg-accent sm:h-8 sm:px-3"
                  >
                    <ListIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {t("visit.clientInfo")}
                  </Link>
                )}
                {canText && visit.clients?.primary_phone && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-11 px-4 sm:h-8 sm:px-3"
                    disabled={sms.isPending}
                    onClick={() => sms.mutate("reminder")}
                  >
                    {t("visit.textReminder")}
                  </Button>
                )}
                {/* Not gated on a phone number: with no phone, or no texting
                    consent, it goes by email. */}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 px-4 sm:h-8 sm:px-3"
                  disabled={onMyWay.isPending}
                  onClick={() => onMyWay.mutate()}
                >
                  {t("visit.sendOnMyWay")}
                </Button>
                {/* Not about this stop: the dump fee or the tank of fuel
                    between stops. Here because More options is where a tech
                    already looks for the occasional thing. Always 44px -- this
                    is the phone's button, and an iPad is a phone for a thumb. */}
                {onLogExpense && (
                  <Button size="sm" variant="outline" className="h-11 px-4" onClick={onLogExpense}>
                    <ReceiptText className="me-1.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    {t("expense.logAnExpense")}
                  </Button>
                )}
              </div>
            </div>
          )}

          {showSkip && (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  {t("skip.reason")}
                </label>
                <select
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value as any)}
                  className="mt-1 h-11 w-full rounded-md border bg-background px-3 text-sm"
                >
                  {skipCodes.map((c) => (
                    <option key={c} value={c}>
                      {skipReasonLabel(t, c, skipLine)}
                    </option>
                  ))}
                </select>
              </div>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("skip.detailsPlaceholder")}
                rows={2}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!reason.trim() || skip.isPending}
                  onClick={() => skip.mutate()}
                >
                  {t("skip.confirm")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowSkip(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
              <p className="text-2xs text-muted-foreground">{t("skip.billingNote")}</p>
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
                    {cardOnline ? t("addon.noneSetUp") : t("addon.offlineNoList")}
                  </div>
                );
              }
              return (
                <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                  <div className="text-xs font-medium text-muted-foreground">
                    {t("addon.heading")}
                  </div>
                  {/* Six columns at every width gave the quantity box and the
                      Bill button one column each — about 38px on the one
                      screen in this product that is a phone screen by
                      definition, for the control that charges a card. Below
                      `sm` the service picker takes the row and quantity sits
                      beside a full-width Bill. */}
                  <div className="grid grid-cols-6 gap-2">
                    <select
                      className="col-span-6 h-11 rounded-md border bg-background px-2 text-sm sm:col-span-4"
                      aria-label={t("addon.selectService")}
                      value={addonSvcId}
                      onChange={(e) => setAddonSvcId(e.target.value)}
                    >
                      <option value="">{t("addon.selectService")}</option>
                      {addonServices.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}: {formatMoney(s.unit_price_cents, locale)}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min="1"
                      className="col-span-2 h-11 rounded-md border bg-background px-2 text-sm sm:col-span-1"
                      aria-label={t("addon.quantity")}
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
                          className="col-span-4 min-h-11 sm:col-span-1"
                          disabled={!addonSvcId || !svc || addonMut.isPending || !cardOnline}
                        >
                          {addonMut.isPending ? "…" : t("addon.bill")}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {t("addon.confirmTitle", {
                              amount: formatMoney(totalCents, locale),
                              client: visit.clients?.display_name ?? t("addon.thisClient"),
                            })}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {svc
                              ? `${
                                  qtyNum > 1
                                    ? t("addon.atCatalogPriceQty", {
                                        service: svc.name,
                                        quantity: qtyNum,
                                      })
                                    : t("addon.atCatalogPrice", { service: svc.name })
                                } `
                              : ""}
                            {t("addon.officeWillReview")}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                          <AlertDialogAction
                            disabled={addonMut.isPending}
                            onClick={() => {
                              if (!svc) {
                                toast.error(t("addon.noLongerAvailable"));
                                return;
                              }
                              addonMut.mutate();
                            }}
                          >
                            {t("addon.billIt")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                  {svc && (
                    <p className="text-2xs font-medium">
                      {t("addon.total", { amount: formatMoney(totalCents, locale) })}
                    </p>
                  )}
                  {!cardOnline && (
                    // The list can still be on screen from a fetch made while
                    // the signal was good; React Query keeps it in memory. So
                    // the Bill button looks live, and pressing it used to fail
                    // with a raw network error on a real charge.
                    <p className="text-2xs font-medium text-amber-600 dark:text-amber-500">
                      {t("addon.offlineNotQueued")}
                    </p>
                  )}
                  <p className="text-2xs text-muted-foreground">{t("addon.howCharged")}</p>
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
  const { t } = useTranslation();
  const [kind, setKind] = useState<"pile_sample" | "cheek_swab">("pile_sample");
  const [where, setWhere] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      logFn({ data: { visitId, sampleKind: kind, locationNote: where.trim() || undefined } }),
    onSuccess: () => {
      toast.success(t("dna.logged"));
      onDone();
    },
    onError: (e: Error) => toast.error(readableError(e, t("common.notSaved"))),
  });

  return (
    <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="text-xs font-medium text-muted-foreground">{t("dna.heading")}</div>
      <div className="flex gap-2">
        <select
          className="h-9 flex-1 rounded-md border bg-background px-2 text-sm"
          aria-label={t("dna.sampleKind")}
          value={kind}
          onChange={(e) => setKind(e.target.value as "pile_sample" | "cheek_swab")}
        >
          <option value="pile_sample">{t("dna.pileSample")}</option>
          <option value="cheek_swab">{t("dna.cheekSwab")}</option>
        </select>
      </div>
      <input
        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
        maxLength={300}
        placeholder={hasUnits ? t("dna.wherePlaceholderUnits") : t("dna.wherePlaceholder")}
        value={where}
        onChange={(e) => setWhere(e.target.value)}
      />
      {!online && (
        // Same honesty as the field add-on charge: this is not one of the
        // queued actions, and a live-looking button that fails with a raw
        // network error is worse than one that says why.
        <p className="text-2xs font-medium text-amber-600 dark:text-amber-500">
          {t("dna.offline")}
        </p>
      )}
      <Button size="sm" disabled={mut.isPending || !online} onClick={() => mut.mutate()}>
        {mut.isPending ? t("common.logging") : t("dna.log")}
      </Button>
      <p className="text-2xs text-muted-foreground">{t("dna.footnote")}</p>
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
  const { t } = useTranslation();
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
      toast.success(r.queued ? t("stations.queuedToast") : t("stations.logged"));
      // Only when it actually landed. Refetching after a queue write would show
      // the tech the server's copy — no log for this station — directly
      // contradicting the toast that just said it was saved.
      if (!r.queued) qc.invalidateQueries({ queryKey: ["visit-stations", visitId] });
    },
    onError: (e: Error) => toast.error(readableError(e, t("common.notSaved"))),
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
          ? t("stations.loading")
          : online
            ? t("stations.couldNotLoad")
            : t("stations.noSavedCopy")}
      </div>
    );
  }

  if (stations.length === 0) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        {t("stations.noneConfigured")}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="text-xs font-medium text-muted-foreground">{t("stations.heading")}</div>
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
  const { t } = useTranslation();
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
            {t("stations.queued")}
          </span>
        ) : (
          existing && (
            <span className="shrink-0 text-2xs text-emerald-600">{t("stations.saved")}</span>
          )
        )}
      </div>
      {station.location_description && (
        <div className="text-2xs text-muted-foreground">{station.location_description}</div>
      )}
      <div className="mt-2 grid grid-cols-6 gap-2 text-xs">
        <label className="col-span-2">
          <span className="block text-2xs text-muted-foreground">
            {t("stations.bagsCollected")}
          </span>
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
          <span className="block text-2xs text-muted-foreground">
            {t("stations.refillBagsAdded")}
          </span>
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
          <span>{t("stations.linerReplaced")}</span>
        </label>
        <input
          className="col-span-6 h-9 rounded-md border bg-background px-2 disabled:opacity-60"
          placeholder={t("stations.notesPlaceholder")}
          value={notes}
          disabled={readOnly}
          onChange={(e) => setNotes(e.target.value)}
        />
        {readOnly ? (
          <p className="col-span-6 text-2xs text-muted-foreground">{t("stations.readOnly")}</p>
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
            {existing ? t("common.update") : t("common.save")}
          </Button>
        )}
      </div>
    </div>
  );
}
