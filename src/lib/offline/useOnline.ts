import { useEffect, useState } from "react";
import { countPending } from "./queue";
import { resolveOfflineUserId } from "./action-owner";
import { CONNECTIVITY_CHANGE, isDefinitelyOffline } from "./connectivity";
import { LAST_REQUEST_CHANGE, lastRequestOutcome, type RequestOutcome } from "./last-request";

/**
 * What every offline INDICATOR in the app renders from.
 *
 * It used to read `navigator.onLine` and nothing else, while the action path
 * has asked `isDefinitelyOffline()` -- which also consults @capacitor/network
 * -- since the day connectivity.ts was written. That module's own header says
 * why the difference matters:
 *
 *   "in a WKWebView `navigator.onLine` is not refreshed reliably while the app
 *    is suspended, so a van that drove through a dead zone with the app
 *    backgrounded can resume reporting `onLine === true` against no connection
 *    at all. That is the exact moment this app most needs the honest answer,
 *    because it is when a tech opens the phone to close out a stop."
 *
 * In that state the work was still queued correctly -- and the tech was told
 * nothing. The red Offline banner did not appear. The stale-data banner read
 * "Couldn't refresh" rather than "Offline". And on the add-on and DNA panels,
 * `cardOnline` said online, which SUPPRESSED the "this charge is not queued,
 * bill it when you have signal" warning and left the Bill button live -- the
 * precise outcome that warning exists to prevent, on a real charge.
 *
 * Now the same answer as the action path, so what a tech is told matches what
 * the app is about to do.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : !isDefinitelyOffline(),
  );
  useEffect(() => {
    const refresh = () => setOnline(!isDefinitelyOffline());
    refresh();
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    // The native listener's answer, which arrives after mount on a cold start
    // and again on every resume.
    window.addEventListener(CONNECTIVITY_CHANGE, refresh);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
      window.removeEventListener(CONNECTIVITY_CHANGE, refresh);
    };
  }, []);
  return online;
}

export function usePendingCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      // Resolved the same way the sync loop resolves it — session first, then
      // the remembered id when the network is gone — so the badge counts
      // exactly the actions the Sync button will replay. Counting the whole
      // store instead showed a shared tablet the previous tech's backlog, which
      // no amount of syncing could clear.
      resolveOfflineUserId()
        .then((userId) => countPending(userId))
        .then((c) => {
          if (!cancelled) setN(c);
        })
        .catch(() => {
          if (!cancelled) setN(0);
        });
    };
    refresh();
    window.addEventListener("offline-queue-change", refresh);
    window.addEventListener("online", refresh);
    // Coming back on native does not fire a browser `online` event, so without
    // this the pending badge stays stale until something else re-renders.
    window.addEventListener(CONNECTIVITY_CHANGE, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("offline-queue-change", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener(CONNECTIVITY_CHANGE, refresh);
    };
  }, []);
  return n;
}

/** Whether the last request a tech was waiting on got through (R2-53). See
 *  last-request.ts: an interface that is up is not a server that answers. */
export function useLastRequestOutcome(): RequestOutcome | null {
  const [outcome, setOutcome] = useState<RequestOutcome | null>(() => lastRequestOutcome());
  useEffect(() => {
    const refresh = () => setOutcome(lastRequestOutcome());
    refresh();
    window.addEventListener(LAST_REQUEST_CHANGE, refresh);
    return () => window.removeEventListener(LAST_REQUEST_CHANGE, refresh);
  }, []);
  return outcome;
}
