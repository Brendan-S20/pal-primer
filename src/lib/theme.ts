// ── LIGHT, DARK, OR WHATEVER THIS DEVICE IS SET TO ───────────────────────
//
// styles.css has had a full `.dark` palette, and the components `dark:`
// variants, for as long as this repo has existed, and nothing ever added the
// `dark` class: there was no switch and the app did not follow the phone, so
// it was always light (launch pass, 2026-10, recommendation 15).
//
// This is the switch. It is a DEVICE preference, stored beside language and
// haptics in localStorage, because it is about the screen in your hand: the
// owner's laptop in the evening and the same owner's phone in a sunny driveway
// want different answers, and neither should change it for a technician.
//
// ── WHY THE DEFAULT IS "light" AND NOT "system" ──────────────────────────
//
// Dark mode has never been reviewed page by page; it could not be, because it
// could not be turned on. Defaulting to "system" would switch every phone set
// to dark onto that unreviewed palette the day this ships, without anybody
// choosing it. "light" keeps today's app for everyone who does nothing, and
// "System" is one tap away. Flip DEFAULT_THEME once dark has had its review.

export type ThemePref = "system" | "light" | "dark";

export const THEME_KEY = "scoop:theme";
export const DEFAULT_THEME: ThemePref = "light";
export const THEME_PREFS: readonly ThemePref[] = ["system", "light", "dark"];

function isPref(v: unknown): v is ThemePref {
  return v === "system" || v === "light" || v === "dark";
}

export function readThemePref(): ThemePref {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return isPref(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Does this preference come out dark, on a device that does or does not
 *  prefer dark? Pure, so the decision is testable without a browser. */
export function resolvesDark(pref: ThemePref, systemPrefersDark: boolean): boolean {
  return pref === "dark" || (pref === "system" && systemPrefersDark);
}

const systemQuery = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

/** Put the class on <html>, where `@custom-variant dark (&:is(.dark *))`
 *  looks for it, and tell the browser so form controls and scrollbars match. */
export function applyTheme(pref: ThemePref): void {
  if (typeof document === "undefined") return;
  const dark = resolvesDark(pref, !!systemQuery()?.matches);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
}

export function setThemePref(pref: ThemePref): void {
  try {
    window.localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* private mode: it still applies for this visit */
  }
  applyTheme(pref);
}

/** Follow the device while the preference is "system": a phone that flips to
 *  dark at sunset flips the app with it. Returns the unsubscribe. */
export function followSystemTheme(): () => void {
  const mq = systemQuery();
  if (!mq) return () => {};
  const onChange = () => {
    if (readThemePref() === "system") applyTheme("system");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Is the dark class on <html> right now? What is painted, not what is
 *  stored: the boot script and applyTheme are what put it there. */
export function isDarkApplied(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

/** Call `onChange` whenever <html> gains or loses the dark class, whichever
 *  path did it (setThemePref, followSystemTheme, the boot script). For things
 *  our CSS cannot reach, like Stripe's iframes, that have to be told. Watches
 *  the class rather than wrapping applyTheme so no caller can be missed.
 *  Returns the unsubscribe. */
export function watchDarkTheme(onChange: (dark: boolean) => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => {};
  }
  let dark = isDarkApplied();
  const observer = new MutationObserver(() => {
    const now = isDarkApplied();
    if (now === dark) return;
    dark = now;
    onChange(now);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/**
 * The same decision, as a string of JavaScript run in <head> before the first
 * paint. Without it a dark-mode user sees a white flash on every load: the
 * page paints light, React hydrates, and only then does an effect add the
 * class. Kept beside applyTheme so the two cannot disagree, and covered by
 * tests/the-dark-palette-nobody-could-turn-on.test.ts, which runs it.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  THEME_KEY,
)});if(p!=="system"&&p!=="light"&&p!=="dark")p=${JSON.stringify(
  DEFAULT_THEME,
)};var d=p==="dark"||(p==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;if(d)r.classList.add("dark");r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;
