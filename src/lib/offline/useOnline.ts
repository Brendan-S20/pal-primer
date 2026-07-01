import { useEffect, useState } from "react";
import { countPending } from "./queue";

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
      countPending().then((c) => {
        if (!cancelled) setN(c);
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
