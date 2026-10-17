/**
 * Which shape the office sidebar takes, as one pure answer, so the
 * breakpoints can be tested without a browser (ui/sidebar.tsx reads it).
 *
 *   sheet   below where it docks, or on a touch screen when the tech tab bar
 *           is the navigation there (`lg-mouse`, useTabletTier). Opened from
 *           a menu button, over the page.
 *   rail    docked, below 1280px, when the shell asks for it: icons with
 *           tooltips, 48px wide (60 on a touch screen), and the labelled
 *           panel opens over the page (QA row 34: at 820px the full column
 *           left the page 564px).
 *   column  docked at 1280px and up: the full 256px column, as before.
 */
export const SIDEBAR_RAIL_BELOW = 1280;

export type SidebarDocksFrom = "md" | "lg-mouse";
export type SidebarShape = "sheet" | "rail" | "column";

/** The width from which a sidebar with this `docksFrom` docks. */
export function sidebarDockEdge(docksFrom: SidebarDocksFrom): number {
  return docksFrom === "lg-mouse" ? 1024 : 768;
}

export function sidebarShape(o: {
  /** Viewport narrower than sidebarDockEdge(docksFrom). */
  belowDock: boolean;
  /** `(pointer: coarse)`: the CSS half of `lg-mouse` is `lg:mouse:`. */
  coarsePointer: boolean;
  /** Viewport narrower than SIDEBAR_RAIL_BELOW. */
  belowRail: boolean;
  docksFrom: SidebarDocksFrom;
  railBelowXl: boolean;
}): SidebarShape {
  if (o.belowDock || (o.docksFrom === "lg-mouse" && o.coarsePointer)) return "sheet";
  if (o.railBelowXl && o.belowRail) return "rail";
  return "column";
}
