import { createContext, useContext, type ReactNode } from "react";

/**
 * THE ONE COLUMN every signed-in page is laid out in.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * The owner, 2026-10-02: "I am noticing a ton of inconsistency such as the
 * margins, padding, and overflow. The page widths should be identically the
 * same when viewing it on the same size screen."
 *
 * They were not. The shell already gave every page a padded 1600px column,
 * and then 21 of the 63 signed-in pages drew a column of their own inside it:
 * `mx-auto max-w-2xl` (672px, centred), `max-w-2xl` (672px, left), `3xl`,
 * `4xl`, `5xl`, `6xl`, and My Day's `-mx-4`, which cancelled 16px of a 24px
 * gutter and left it 8px out of line with everything else from 640px up.
 * Measured at 1920px: the content column started at seven different x
 * positions and ended at nine, and the heading sat at eight — 288px on
 * Clients, 752px on New client. Each wrapper was a reasonable reading measure
 * on its own; together they made neighbouring pages look like two products.
 *
 * So the column is decided HERE and nowhere else, and it is applied by the
 * layout (`src/routes/_authenticated/route.tsx`) around the router outlet —
 * not by each page — so a page cannot forget it, and its loading state, its
 * empty state and its error boundary sit in the same column as its content.
 * A page's own root element is a section inside this column, never a column.
 *
 * ── WHAT IT DECIDES ───────────────────────────────────────────────────────
 *
 *   * HORIZONTAL GUTTER — 1rem below `sm`, 1.5rem from it, plus the landscape
 *     safe-area inset on each side (0 on the web and in portrait). This was
 *     on <main> and moved here so the gutter and its inverse, PAGE_BLEED_X,
 *     are written next to each other.
 *   * MAX WIDTH — 1600px for a standard page. 1200 was tried first and wasted
 *     ~700px beside every table on a 1920 display; past 1600 a table row is
 *     wide enough that the eye loses its place between the label and the
 *     last column.
 *   * ANCHORING — the column is LEFT-aligned at the gutter, not centred. A
 *     centred cap moves the left edge as soon as the cap engages, and then a
 *     standard page and a wide page start at different x on the same screen —
 *     the exact inconsistency this file exists to remove. Anchored, the cap
 *     only ever moves the right edge.
 *   * VERTICAL RHYTHM — 1rem of top padding below `sm`, 1.25rem from it, and
 *     1.5rem between the page's top-level sections (`space-y-6`). Bottom
 *     padding stays on <main>, because it is reserved for the tab bar and that
 *     is the shell chrome's decision, not the page's.
 *
 * ── THE WIDE VARIANT ──────────────────────────────────────────────────────
 *
 * Some pages need every pixel: the dispatch board, the maps, My Day (whose
 * sticky bar and map run edge to edge). They declare it on their route:
 *
 *     export const Route = createFileRoute("/_authenticated/routes")({
 *       staticData: { pageWidth: "wide" },
 *       ...
 *     });
 *
 * Wide lifts the 1600px cap and NOTHING ELSE. Same gutter, same top padding,
 * same left edge — below roughly 1900px the two variants are the same box.
 *
 * ── WHAT A PAGE MUST NOT DO ───────────────────────────────────────────────
 *
 * Wrap its content in `mx-auto`, a `max-w-*`, a `container`, or horizontal
 * padding. Narrow content inside a section — a form's fields, a paragraph held
 * to a reading measure — is fine; a narrower COLUMN is not.
 * `tests/viewports/every-page-has-the-same-margins.spec.ts` measures every
 * page at 360 / 768 / 1280 / 1920 and fails one whose column, heading or
 * top-level sections do not start and end where every other page's do.
 */

export type PageWidth = "standard" | "wide";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Which column the page is laid out in. Omitted means "standard".
     *  See src/components/PageShell.tsx before choosing "wide". */
    pageWidth?: PageWidth;
  }
}

/** The page gutter. Literal strings, because Tailwind scans source for class
 *  names and cannot see an assembled one. */
export const PAGE_GUTTER_X =
  "pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] sm:pl-[calc(1.5rem+env(safe-area-inset-left))] sm:pr-[calc(1.5rem+env(safe-area-inset-right))]";

/**
 * A band that runs edge to edge — My Day's sticky bar — and then pads its
 * own contents back in by exactly the gutter, so what is inside it still
 * starts at the column's left edge. The negative margin and the padding are
 * the gutter and its inverse; they live here, beside PAGE_GUTTER_X, so they
 * cannot drift apart the way `-mx-4` against `sm:px-6` did.
 *
 * Mark the element `data-page-bleed` too: the margins spec then measures it
 * by its CONTENT box — where what is inside it starts and ends — so a bleed
 * that forgot to pad itself back in still fails.
 */
export const PAGE_BLEED_X =
  "-ml-[calc(1rem+env(safe-area-inset-left))] -mr-[calc(1rem+env(safe-area-inset-right))] sm:-ml-[calc(1.5rem+env(safe-area-inset-left))] sm:-mr-[calc(1.5rem+env(safe-area-inset-right))] " +
  PAGE_GUTTER_X;

/** Pulls a band up through the shell's top padding, so a sticky bar meets
 *  the header (or the top of the screen) with no strip above it. */
export const PAGE_BLEED_TOP = "-mt-4 sm:-mt-5";

const COLUMN: Record<PageWidth, string> = {
  standard: "w-full max-w-[1600px] space-y-6",
  wide: "w-full space-y-6",
};

/** True inside PageShell. Lets a component that can render either inside the
 *  column or before the shell exists (the router's pending skeleton) put the
 *  gutter on itself only when nothing else has. */
const InPageShell = createContext(false);
export const useInPageShell = () => useContext(InPageShell);

export function PageShell({
  width = "standard",
  children,
}: {
  width?: PageWidth;
  children: ReactNode;
}) {
  return (
    // data-vt="page": the region that slides during a page transition (see
    // the PAGE TRANSITIONS block in styles.css). The column, not <main>, so
    // the page moves and the shell's own padding and banners do not.
    <div data-vt="page" className={`min-w-0 pt-4 sm:pt-5 ${PAGE_GUTTER_X}`}>
      <div data-page-shell={width} className={COLUMN[width]}>
        <InPageShell.Provider value={true}>{children}</InPageShell.Provider>
      </div>
    </div>
  );
}
