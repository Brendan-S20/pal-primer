// Whether this phone shows the route on the lock screen at all.
//
// One switch: "Route on the lock screen" on Settings → Preferences. (It had
// a second face, an icon in My Day's status row, from 2026-10-07 until the
// owner took it off My Day on 2026-10-08.) On, and the route goes back on the
// lock screen by itself whenever the app opens mid-day; off, and it never
// does.
//
// Per device, like everything else on Preferences: a Live Activity belongs
// to the phone it is drawn on, and a tech with an iPad on the dash and a
// phone in a pocket may well want it on one and not the other.

import { useCallback, useEffect, useState } from "react";

const KEY = "hs:route-on-lock-screen";
/** Fired on this window after a write; `storage` covers other tabs. */
export const ROUTE_ON_LOCK_SCREEN_EVENT = "houndstack:route-on-lock-screen";

/** On unless this phone has said otherwise: the route starting by itself is
 *  the feature, and a tech who never touches the switch should get it. */
export function readRouteOnLockScreen(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeRouteOnLockScreen(on: boolean) {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice lasts as long as this page does.
  }
  window.dispatchEvent(new Event(ROUTE_ON_LOCK_SCREEN_EVENT));
}

/**
 * The preference, kept current across both of its controls.
 *
 * Starts from the default and reads storage on the first effect, for the
 * reason useHeaderPrefs gives: this renders during SSR, where there is no
 * storage, and a value read while rendering would not match the client's.
 */
export function useRouteOnLockScreen(): {
  on: boolean;
  set: (on: boolean) => void;
  /** False until storage has been read. Nothing should ACT on `on` before
   *  then: a phone that said no would read as yes for one frame. */
  ready: boolean;
} {
  const [on, setOn] = useState(true);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const load = () => {
      setOn(readRouteOnLockScreen());
      setReady(true);
    };
    load();
    window.addEventListener(ROUTE_ON_LOCK_SCREEN_EVENT, load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener(ROUTE_ON_LOCK_SCREEN_EVENT, load);
      window.removeEventListener("storage", load);
    };
  }, []);
  const set = useCallback((next: boolean) => {
    setOn(next);
    writeRouteOnLockScreen(next);
  }, []);
  return { on, set, ready };
}
