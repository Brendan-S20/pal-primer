/**
 * Which way a navigation should move, decided from nothing but the two paths
 * and what the history did. Pure, so the whole decision is unit-tested
 * (tests/an-app-that-moves.test.ts) and the DOM glue in page-transitions.ts
 * only has to carry the answer to <html data-nav-dir>.
 *
 *   forward  deeper: /clients -> /clients/123. The new page comes in from
 *            the END edge (right in English, left in Arabic; styles.css
 *            flips it with --motion-dir, so this file never says "right").
 *   back     shallower, or the history went back. The page leaves toward the
 *            end edge and the previous one is underneath.
 *   none     no transition at all. This includes every move between
 *            top-level sections and every tap on the tab bar or the sidebar:
 *            a native app switches tabs in place, it does not slide or fade
 *            between them. Until 2026-10-08 a tab switch crossfaded, which
 *            on the owner's iPhone read as the app hesitating on every tab
 *            tap, and a view transition swallows taps for as long as it runs,
 *            so tapping two tabs quickly lost the second one.
 */
export type NavDirection = "forward" | "back" | "none";

export type NavInput = {
  /** Pathname being left; undefined on the first load. */
  fromPath: string | undefined;
  toPath: string;
  /** Did this navigation come from the history (back/forward button, an
   *  edge swipe, Android's back key) rather than a link or a push? */
  isPop: boolean;
  /** TanStack's `__TSR_index` on each side, when known. Only consulted for a
   *  pop: a link that happens to go up a level is still a push. */
  fromIndex?: number;
  toIndex?: number;
  /** The browser or WKWebView already animated this navigation itself (an
   *  iOS edge swipe, Safari's two-finger back). Animating again on top of
   *  that is the double animation the swipe-back would otherwise get. */
  uaTransitioned: boolean;
  /** prefers-reduced-motion: reduce. */
  reducedMotion: boolean;
  /** The navigation came from the app's own navigation chrome (the bottom
   *  tab bar, its More sheet, the sidebar) rather than from a link in a page.
   *  Those are tab switches whatever the two URLs look like: tapping Clients
   *  while on /clients/123 is not "going back" in a native app, it is
   *  changing tab. */
  fromNavChrome?: boolean;
};

const segments = (path: string) => path.split("/").filter(Boolean);

/** `a` is a strict ancestor of `b`: /clients of /clients/123. */
function isAncestor(a: string[], b: string[]): boolean {
  return a.length < b.length && a.every((s, i) => s === b[i]);
}

export function navDirection(i: NavInput): NavDirection {
  if (i.reducedMotion || i.uaTransitioned) return "none";
  if (i.fromPath === undefined) return "none";
  const from = segments(i.fromPath);
  const to = segments(i.toPath);
  if (from.join("/") === to.join("/")) return "none";

  // Two top-level sections: the tab bar and the sidebar move between these,
  // and there is no back stack between tabs in a native app either.
  if (from.length <= 1 && to.length <= 1) return "none";
  // A tap on the tab bar or the sidebar is a tab switch, wherever it starts.
  // A history pop is still a pop: the back key from /clients/123 slides.
  if (i.fromNavChrome && !i.isPop) return "none";

  // The history knows which way it went, and that beats the shape of the
  // URLs: going back from /clients (reached by a link) to /clients/123 is
  // still BACK, even though the URL got deeper.
  if (i.isPop && i.fromIndex !== undefined && i.toIndex !== undefined) {
    if (i.toIndex < i.fromIndex) return "back";
    if (i.toIndex > i.fromIndex) return "forward";
  }

  if (isAncestor(to, from)) return "back";
  if (isAncestor(from, to)) return "forward";
  if (to.length < from.length) return "back";
  // Same depth in another section (a client's page to one of their
  // invoices) or deeper: a link was followed, so it is a step forward.
  return "forward";
}

/**
 * Should the custom animation stand aside because the platform animated this
 * history traversal already?
 *
 * `hasUAVisualTransition` is the standard answer (PopStateEvent and the
 * Navigation API's NavigateEvent both carry it), and `true` is always
 * believed.
 *
 * On iOS nothing else is. The native app turns on WKWebView's edge swipe
 * (ios/App/App/HSBridgeViewController.swift,
 * allowsBackForwardNavigationGestures), and Safari has the same gesture; both
 * slide a snapshot of the previous page in with the finger and then fire
 * popstate. Whether a given WebKit reports that as `true`, `false` or not at
 * all is not something this code can verify from here, and a wrong `false`
 * is a page that slides in twice. So on iOS EVERY history traversal is taken
 * as already animated: the cost is that a back made by a button that calls
 * history.back() gets no slide on an iPhone, which is invisible next to the
 * swipe that is the normal way back there. Elsewhere (Chrome's back button,
 * Android's back key) an absent or `false` answer means nobody animated it,
 * and the page slides back.
 */
export function uaAlreadyAnimated(
  hasUAVisualTransition: boolean | undefined,
  isIOS: boolean,
): boolean {
  if (hasUAVisualTransition === true) return true;
  return isIOS;
}
