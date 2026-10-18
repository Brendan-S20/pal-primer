/**
 * Which shape the office sidebar takes, as one pure answer, so the
 * breakpoints can be tested without a browser (ui/sidebar.tsx reads it).
 *
 *   sheet   below where it docks, or on a touch screen when the tech tab bar
 *           is the navigation there (`lg-mouse`, useTabletTier). Opened from
 *           a menu button, over the page. The office shell docks from `md`,
 *           so for an owner or dispatcher this is a question of width only:
 *           a 1032px iPad and a 1032px mouse window get the same sidebar.
 *   rail    docked, below 1024px, when the shell asks for it: icons with
 *           tooltips, 48px wide (60 on a touch screen), and the labelled
 *           panel opens over the page (QA row 34: at 820px the full column
 *           left the page 564px).
 *   column  docked from 1024px: the full 256px column, which the toggle
 *           collapses to the same icon width beside the page. Which of the
 *           two it is, is the person's choice (sidebarExpanded, below).
 *
 * Until #499 the rail ran to 1280, so every iPad in landscape loaded the
 * rail and an expanded choice lasted until the next route change. At 1024
 * the column leaves the page 768px, the width of an iPad in portrait, which
 * the pages in the tablet set already lay out for.
 */
export const SIDEBAR_RAIL_BELOW = 1024;

/** With no saved choice the column loads expanded from here, collapsed to
 *  the icons below it (#499: an iPad Air in landscape is 1180). */
export const SIDEBAR_EXPANDED_FROM = 1180;

export type SidebarDocksFrom = "md" | "lg-mouse";
export type SidebarShape = "sheet" | "rail" | "column";

/** The width from which a sidebar with this `docksFrom` docks. */
export function sidebarDockEdge(docksFrom: SidebarDocksFrom): number {
  return docksFrom === "lg-mouse" ? 1024 : 768;
}

export function sidebarShape(o: {
  /** Viewport narrower than sidebarDockEdge(docksFrom). */
  belowDock: boolean;
  /** `(pointer: coarse)`: the CSS half of `lg-mouse` is `lg:mouse:`. Only
   *  read for `lg-mouse`, the tech with the tab bar. */
  coarsePointer: boolean;
  /** Viewport narrower than SIDEBAR_RAIL_BELOW. */
  belowRail: boolean;
  docksFrom: SidebarDocksFrom;
  railBelowLg: boolean;
}): SidebarShape {
  if (o.belowDock || (o.docksFrom === "lg-mouse" && o.coarsePointer)) return "sheet";
  if (o.railBelowLg && o.belowRail) return "rail";
  return "column";
}

/**
 * Whether the docked column is expanded, for a shell that remembers it.
 * The saved choice wins at every width the column is drawn; with none, the
 * column is expanded from SIDEBAR_EXPANDED_FROM and the icons below it.
 */
export function sidebarExpanded(o: {
  /** readSidebarExpanded(): true, false, or null for no choice yet. */
  saved: boolean | null;
  /** Viewport narrower than SIDEBAR_EXPANDED_FROM. */
  belowExpandedDefault: boolean;
}): boolean {
  return o.saved ?? !o.belowExpandedDefault;
}

/**
 * The choice is a device preference, not a secret, so it survives sign out:
 * the read cache sweep (lib/offline/read-cache.ts) removes only its own
 * `hs:offline-reads:` keys. localStorage rather than the `sidebar_state`
 * cookie because the signed-in shell is client only (`ssr: false`), so the
 * provider can read it in its first render and no server ever needs it.
 */
export const SIDEBAR_EXPANDED_KEY = "hs.sidebar.expanded";

type ChoiceStore = Pick<Storage, "getItem" | "setItem">;

function deviceStore(): ChoiceStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Safari with storage blocked throws on the property itself.
    return null;
  }
}

/** The saved choice, or null when there is none or it cannot be read. */
export function readSidebarExpanded(store: ChoiceStore | null = deviceStore()): boolean | null {
  if (!store) return null;
  try {
    const value = store.getItem(SIDEBAR_EXPANDED_KEY);
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}

/** Best effort: a full or blocked store keeps the choice for this visit only. */
export function writeSidebarExpanded(
  expanded: boolean,
  store: ChoiceStore | null = deviceStore(),
): void {
  if (!store) return;
  try {
    store.setItem(SIDEBAR_EXPANDED_KEY, expanded ? "1" : "0");
  } catch {
    /* best effort */
  }
}
