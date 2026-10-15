import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PAGE_BLEED_TOP,
  PAGE_BLEED_X,
  PAGE_GUTTER_X,
  useInPageShell,
} from "@/components/PageShell";
import { nativeTopBarStyle } from "@/lib/native-build";
import { cn } from "@/lib/utils";

/**
 * LOADING STATES IN THE SHAPE OF THE PAGE THEY STAND IN FOR.
 *
 * A spinner, or "Loading…" in the corner, tells you something is happening
 * and nothing about what. Then the data lands and the page assembles itself
 * around you: the heading drops, the list pushes the footer down, the button
 * you were reaching for moves. Each skeleton here draws the boxes the real
 * page will draw, at the sizes it will draw them, so when the data arrives
 * the text fills in where the grey was and nothing else on the screen moves.
 * tests/viewports/an-app-that-moves.spec.ts holds /clients to that, by
 * bounding box.
 *
 * Two rules every skeleton keeps:
 *
 *   * It is a `role="status"` region named "Loading" in the reader's
 *     language, and its boxes are aria-hidden. A screen reader hears one
 *     word, not forty empty divs.
 *   * It carries no text of the page's own and nothing a sweep could mistake
 *     for the page: tests/viewports' settle() proves a surface rendered by a
 *     locator and a fixture string only the real page draws, so a skeleton
 *     can never pass for a loaded page, and it is gone before anything is
 *     measured.
 *
 * Each one pulses (ui/skeleton.tsx); under reduced motion the pulse is held
 * still by the rule in styles.css. And each one waits 160ms before it is
 * drawn (styles.css, SKELETONS), so a page whose data answers quickly goes
 * straight from nothing to content without a grey flash in between. The
 * router's pending page is the exception: the router has already waited
 * 300ms before mounting it, so it is drawn at once (`immediate`).
 */

function Bone({ className }: { className?: string }) {
  return <Skeleton aria-hidden="true" data-skeleton="" className={className} />;
}

function Region({
  label,
  className,
  immediate = false,
  children,
}: {
  label?: string;
  className?: string;
  /** Drawn at once rather than after --skeleton-delay: only for a skeleton
   *  something else has already waited for. */
  immediate?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label ?? t("common.loading")}
      data-skeleton-region=""
      data-skeleton-now={immediate ? "" : undefined}
      className={className}
    >
      {children}
    </div>
  );
}

export { Region as SkeletonRegion };

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** A heading and the line under it, at the sizes every page heading uses. */
function HeadingBones({ wide = false }: { wide?: boolean }) {
  return (
    <div className="space-y-2">
      {/* text-2xl is a 2rem line box. */}
      <Bone className={cn("h-8", wide ? "w-64 max-w-full" : "w-40")} />
      <Bone className="h-4 w-56 max-w-full" />
    </div>
  );
}

// ── THE ROUTER'S PENDING PAGE ────────────────────────────────────────────

/**
 * What the router shows in place of a page whose code or beforeLoad is still
 * loading after 300ms (src/router.tsx, defaultPendingComponent). Generic,
 * because it stands in for every page: a heading, a row of tiles and a list,
 * which is the shape most of them are.
 *
 * Inside the signed-in shell it is already in the page column. Before the
 * shell exists (a public page, or the first load of the shell itself) it
 * puts the same gutter on itself, so it is still where the page will be.
 */
export function RoutePending() {
  const inShell = useInPageShell();
  const body = (
    <Region immediate className="space-y-6">
      <HeadingBones />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {range(4).map((i) => (
          <Bone key={i} className="h-24 rounded-lg" />
        ))}
      </div>
      <div className="space-y-3">
        {range(5).map((i) => (
          <Bone key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    </Region>
  );
  return inShell ? body : <div className={`min-w-0 pt-4 sm:pt-5 ${PAGE_GUTTER_X}`}>{body}</div>;
}

/**
 * The signed-in shell while it is still deciding who you are (the
 * _authenticated route's beforeLoad: the session, the second step, your
 * organisation). That route is client-only, so this is ALSO what the server
 * sends for every signed-in URL and what a cold launch of the native app
 * paints under the splash: a sidebar where the sidebar will be, a header
 * where the header will be, and a page skeleton in the column.
 *
 * Before this the shell rendered nothing at all in that window, which was a
 * blank cream page on the web and, in the app, a blank screen between the
 * splash and the first route.
 */
export function ShellPending() {
  return (
    <div className="flex min-h-screen w-full bg-background">
      <div aria-hidden="true" className="hidden w-64 shrink-0 border-e bg-sidebar md:block" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          aria-hidden="true"
          style={nativeTopBarStyle(3.5)}
          className="h-14 border-b bg-card/80 max-md:hidden"
        />
        <div
          aria-hidden="true"
          style={{ height: "env(safe-area-inset-top)" }}
          className="md:hidden"
        />
        <RoutePending />
      </div>
    </div>
  );
}

// ── DASHBOARD ────────────────────────────────────────────────────────────

/** One KPI value, in a KpiCard, while the summary loads. text-3xl is a
 *  2.25rem line box, so the tile is the same height with a number in it. */
export function KpiValueBone() {
  return <Bone className="h-9 w-24" />;
}

/** The dashboard before the organisation is known: header, four tiles, the
 *  map card and the side column, in the dashboard's own grid. */
export function DashboardSkeleton() {
  return (
    <Region className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <HeadingBones wide />
        <div className="flex gap-2">
          <Bone className="h-8 w-32 touch:h-11" />
          <Bone className="h-8 w-20 touch:h-11" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {range(4).map((i) => (
          <div key={i} className="rounded-lg border bg-card p-5">
            <Bone className="h-4 w-24" />
            <div className="mt-2">
              <KpiValueBone />
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 rounded-lg border bg-card p-4 lg:col-span-2">
          <Bone className="mb-3 h-5 w-28" />
          <Bone className="h-[380px] max-md:hidden" />
          <Bone className="h-4 w-48 md:hidden" />
        </div>
        <div className="min-w-0 space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <Bone className="mb-3 h-5 w-24" />
            <TechProgressBones />
          </div>
        </div>
      </div>
    </Region>
  );
}

/** The "Techs today" rows: a name, a count, a progress bar. */
export function TechProgressBones({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="space-y-3">
      {range(rows).map((i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <Bone className="h-5 w-32" />
            <Bone className="h-5 w-10 rounded-full" />
          </div>
          <Bone className="h-1.5 w-full rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** A short list of name-and-amount rows (Overdue invoices). */
export function LineBones({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="space-y-2">
      {range(rows).map((i) => (
        <div key={i} className="flex items-center justify-between gap-2">
          <Bone className="h-5 w-36" />
          <Bone className="h-5 w-16" />
        </div>
      ))}
    </div>
  );
}

// ── MY DAY ───────────────────────────────────────────────────────────────

/**
 * My Day before the day arrives: its own sticky bar (with the real title, so
 * the one word a tech is looking for does not move when the data lands), the
 * progress pill, and three stop cards shaped like VisitCard.
 *
 * The bar is built with the same bleed, inset and padding as the real one in
 * my-day.tsx, which is what keeps the title at the same pixel.
 */
export function MyDaySkeleton({ title, label }: { title: string; label: string }) {
  return (
    <Region label={label}>
      <div
        data-page-bleed=""
        className={`sticky top-[var(--hs-banner-h,0px)] z-30 border-b bg-background/80 backdrop-blur ${PAGE_BLEED_X} ${PAGE_BLEED_TOP}`}
        style={nativeTopBarStyle()}
      >
        <div className="space-y-3 py-3">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-bold tracking-tight md:text-xl md:font-semibold">
                {title}
              </h1>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Bone className="h-11 w-11" />
              <Bone className="h-11 w-28 rounded-lg md:h-10 md:w-36" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Bone className="h-10 min-w-0 flex-1 rounded-lg" />
            <Bone className="h-12 w-36 shrink-0 rounded-lg" />
          </div>
        </div>
      </div>
      <div className="space-y-3 pt-4">
        {range(3).map((i) => (
          <div key={i} className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <Bone className="h-10 w-10 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2">
                <Bone className="h-4 w-24" />
                <Bone className="h-6 w-3/4" />
                <Bone className="h-4 w-1/2" />
              </div>
            </div>
            <div className="mt-4 flex gap-2">
              <Bone className="h-11 flex-1" />
              <Bone className="h-11 w-24" />
            </div>
          </div>
        ))}
      </div>
    </Region>
  );
}

// ── MY SCHEDULE ──────────────────────────────────────────────────────────

/** Rows shaped like my-schedule.tsx's day links (min-h-16, p-3). */
export function ScheduleDaysSkeleton({ label }: { label: string }) {
  return (
    <Region label={label} className="space-y-2">
      {range(5).map((i) => (
        <div key={i} className="flex min-h-16 items-center gap-3 rounded-lg border bg-card p-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Bone className="h-5 w-40" />
            <Bone className="h-3 w-28" />
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Bone className="h-5 w-6" />
            <Bone className="h-3 w-10" />
          </div>
        </div>
      ))}
    </Region>
  );
}

// ── LISTS (Clients, Invoices) ────────────────────────────────────────────

/**
 * A list that is cards below a breakpoint and a table above it, which is
 * what both /clients (sm) and /invoices (md) are. The card and the table
 * row are drawn at the real ones' padding and line heights.
 */
export function ListSkeleton({
  breakpoint,
  rows = 6,
  columns = 6,
}: {
  /** Where the real page switches from cards to the table. */
  breakpoint: "sm" | "md";
  rows?: number;
  columns?: number;
}) {
  const cardsOnly = breakpoint === "sm" ? "space-y-3 sm:hidden" : "space-y-3 md:hidden";
  const tableOnly =
    breakpoint === "sm"
      ? "hidden overflow-hidden rounded-lg border bg-card sm:block"
      : "overflow-hidden rounded-xl border bg-card shadow-sm max-md:hidden";
  return (
    <Region>
      <div className={cardsOnly}>
        {range(Math.min(rows, 4)).map((i) => (
          <div key={i} className="rounded-lg border bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Bone className="h-5 w-3/5" />
                <Bone className="h-3 w-2/5" />
                <Bone className="h-3 w-1/4" />
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Bone className="h-3 w-12" />
                <Bone className="h-5 w-16" />
              </div>
            </div>
            <div className="mt-2 flex gap-3">
              <Bone className="h-3 w-12" />
              <Bone className="h-3 w-12" />
            </div>
          </div>
        ))}
      </div>
      <div className={tableOnly}>
        <div className="flex h-9 items-center gap-6 border-b bg-muted/40 px-4">
          {range(columns).map((i) => (
            <Bone key={i} className="h-3 flex-1" />
          ))}
        </div>
        {range(rows).map((i) => (
          <div
            key={i}
            className="flex h-[3.3rem] items-center gap-6 border-t px-4 first:border-t-0"
          >
            {range(columns).map((c) => (
              <Bone key={c} className={cn("h-4 flex-1", c === 0 && "flex-[2]")} />
            ))}
          </div>
        ))}
      </div>
    </Region>
  );
}

// ── A CLIENT'S PAGE ──────────────────────────────────────────────────────

/** Header card, the tab strip and the summary tab's two columns. */
export function ClientDetailSkeleton() {
  return (
    <Region className="space-y-6">
      <div className="rounded-lg border bg-card p-(--card-pad)">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Bone className="h-8 w-64 max-w-full" />
            <Bone className="h-4 w-48 max-w-full" />
          </div>
          <div className="flex gap-2">
            <Bone className="h-9 w-24 touch:h-11" />
            <Bone className="h-9 w-9 touch:h-11 touch:w-11" />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {range(4).map((i) => (
            <Bone key={i} className="h-12" />
          ))}
        </div>
      </div>
      <Bone className="h-9 w-full max-w-xl touch:h-11" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Bone className="h-48 rounded-lg" />
        <Bone className="h-48 rounded-lg" />
      </div>
    </Region>
  );
}
