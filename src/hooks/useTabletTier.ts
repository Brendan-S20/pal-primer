import { useMyRole, type AppRole } from "@/hooks/useMyRole";

/**
 * Q-2, answered in v1.1 and never built: a real tablet tier at 768–1024px.
 *
 * ── WHY A BREAKPOINT MOVE WAS NEVER THE ANSWER ────────────────────────────
 *
 * This app had ONE breakpoint. The bottom tab bar is `md:hidden`, so it
 * vanished at exactly 768px — and a crew tablet is 768–1024. A tech on the
 * tablet the offline cache was written for got the desktop sidebar and none of
 * the tech navigation.
 *
 * Pushing the bar to `lg:hidden` looks like a one-word fix and is not: the
 * dispatch board renders from `md` up and belongs on an iPad, where a
 * dispatcher genuinely uses it. Widening the bar to 1024 for everyone would
 * put a phone tab bar under a working dispatch board.
 *
 * The two halves want different answers because WIDTH IS BEING USED AS A PROXY
 * FOR ROLE, and it is the wrong proxy. What actually differs at 800px is not
 * the screen, it is who is holding it:
 *
 *   * a TECH on a crew tablet wants the tech tab bar — My Day, Schedule, More
 *     — and has no use for a sidebar of office destinations they cannot open;
 *   * a DISPATCHER or office user on an iPad wants the board and the sidebar,
 *     and a bottom tab bar would cover the board they are dragging visits on.
 *
 * So the tablet tier is defined by both: below `md` everyone gets the bar, and
 * through the tablet range only the field roles do.
 *
 * ── ONE DEFINITION, BECAUSE TWO WOULD DRIFT ───────────────────────────────
 *
 * The bar's visibility and the main content's bottom padding MUST agree. The
 * padding is `pb-[4.5rem] md:pb-8` — it stops clearing the bar at exactly the
 * point the bar used to disappear. Widen one without the other and the tab bar
 * sits on top of the last row of content, which on My Day is the Complete
 * button. That is why both read this hook instead of each writing a class.
 */

/** Roles that work from a vehicle rather than a desk. */
const FIELD_ROLES: readonly AppRole[] = ["tech"];

/**
 * ── AND ON EVERY TOUCH SCREEN, WHATEVER ITS WIDTH (QA row 35) ─────────────
 *
 * The bar used to stop at `lg` for a tech too, so an iPad in landscape
 * (1180 or 1366px) gave the tech the office sidebar: a column of
 * destinations they cannot open, at 32px rows, instead of the four tabs
 * they use on the phone in the same hand. Width was again standing in for
 * the question, which is whether a finger is holding it.
 *
 * So for a field role the bar is hidden from `lg` only on a device whose
 * primary pointer is a mouse: `lg:mouse:hidden`. On a coarse pointer it
 * stays at every width. Plain CSS rather than a JS media query, so the
 * first paint is already right and the hook stays a pure function of the
 * role (tests drive it without a renderer).
 */
export type TabletTier = {
  /** Whether the bottom tab bar is shown through the 768–1024px range, and
   *  at every width on a touch screen. */
  barThroughTablet: boolean;
  /** Tailwind class hiding the bar once nav lives in the sidebar instead. */
  barHiddenFrom: "md:hidden" | "lg:mouse:hidden";
  /** Bottom padding for the scroll container, so content clears the bar for
   *  exactly as long as the bar is there. */
  mainBottomPadding: string;
};

export function useTabletTier(): TabletTier {
  const { role } = useMyRole();
  // While the role is still loading it is null, and the safe default is the
  // narrower rule: showing the bar to a desk user for a moment is a cosmetic
  // flicker, hiding it from a tech mid-visit loses their navigation.
  const fieldRole = role === null || FIELD_ROLES.includes(role);

  return fieldRole
    ? {
        barThroughTablet: true,
        barHiddenFrom: "lg:mouse:hidden",
        mainBottomPadding: "pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:mouse:pb-8",
      }
    : {
        barThroughTablet: false,
        barHiddenFrom: "md:hidden",
        mainBottomPadding: "pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-8",
      };
}

/**
 * Where the docked sidebar starts, given where the tab bar stops.
 *
 * ── TWO NAVIGATIONS AT 768 ────────────────────────────────────────────────
 *
 * The tier above moved the tab bar's edge to `lg` for a tech and nothing moved
 * the sidebar's: it still docked at `md`, from ui/sidebar.tsx's own 768. So
 * from 768 to 1023 a tech had both — the docked column of office
 * destinations the note at the top of this file says they have no use for,
 * and the tab bar under it. Reported from a 768px tablet on 2026-09-27.
 *
 * The rule is "exactly one", so the sidebar docks where the bar is hidden:
 * `lg-mouse` (from `lg`, and only with a mouse) when the bar reaches through
 * the tablet range and across every touch screen, `md` otherwise.
 *
 * `barRendered` is a separate argument because the tier is not the whole
 * answer. The bar does not render while the role is unknown (MobileTabBar
 * returns null for it), nor for anyone who switched phone navigation to the
 * side in Preferences — and in both cases the sidebar IS the navigation, so
 * it must keep docking at `md` or 768–1023 would have none at all.
 */
export function sidebarDocksFrom(tier: TabletTier, barRendered: boolean): "md" | "lg-mouse" {
  return barRendered && tier.barHiddenFrom === "lg:mouse:hidden" ? "lg-mouse" : "md";
}
