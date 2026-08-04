import { useEffect, useState } from "react";
import { countPending } from "./queue";
import { resolveOfflineUserId } from "./action-owner";

export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
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
    return () => {
      cancelled = true;
      window.removeEventListener("offline-queue-change", refresh);
      window.removeEventListener("online", refresh);
    };
  }, []);
  return n;
}
