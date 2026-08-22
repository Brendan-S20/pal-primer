import { useCallback, useEffect, useState } from "react";
import { readLastUser } from "@/lib/offline/read-cache";
import {
  DEFAULT_HEADER_PREFS,
  HEADER_PREFS_EVENT,
  readHeaderPrefs,
  writeHeaderPrefs,
  type HeaderPrefs,
} from "@/lib/header-prefs";

/**
 * Read and set the current person's header preferences.
 *
 * Starts from the DEFAULTS rather than from storage, and fills in on the
 * first effect. That is deliberate: this renders during SSR and during the
 * native shell's prerendered /auth shell, where `localStorage` does not
 * exist, and a hook that reads it while rendering produces server markup that
 * disagrees with the client's — a hydration mismatch whose symptom is React
 * silently throwing the server tree away. One frame of the default header is
 * cheaper than that, and the default is "show everything", so the frame that
 * flashes is the fuller one rather than a gap.
 */
export function useHeaderPrefs(): {
  prefs: HeaderPrefs;
  setPref: (key: keyof HeaderPrefs, value: boolean) => void;
} {
  const [prefs, setPrefs] = useState<HeaderPrefs>(DEFAULT_HEADER_PREFS);

  useEffect(() => {
    const load = () => setPrefs(readHeaderPrefs(readLastUser()));
    load();
    window.addEventListener(HEADER_PREFS_EVENT, load);
    // `storage` covers the other-tab case; the custom event covers this one.
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener(HEADER_PREFS_EVENT, load);
      window.removeEventListener("storage", load);
    };
  }, []);

  const setPref = useCallback((key: keyof HeaderPrefs, value: boolean) => {
    const userId = readLastUser();
    const next = { ...readHeaderPrefs(userId), [key]: value };
    setPrefs(next);
    writeHeaderPrefs(userId, next);
  }, []);

  return { prefs, setPref };
}
