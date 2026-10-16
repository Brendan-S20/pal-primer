// The bound server-fn callers the offline queue replays with.
//
// One set, used by both of the things that replay: the app-wide replay in
// components/QueueSync.tsx and the sign-out flush in useOfflineSignOut. They
// were two hand-written copies (My Day's and the sign-out hook's), and every
// queue kind had to be added to both. A kind missing from either is an action
// that path cannot send: the replay would refuse it on every reconnect, and the
// flush would ask the tech to discard it on the way out the door.

import { useMemo } from "react";
import { useServerFn } from "@tanstack/react-start";
import { startVisit, completeVisit, skipVisit, recordVisitPhoto } from "@/lib/my-day.functions";
import { logStationService } from "@/lib/stations.functions";
import { clockIn, clockOut } from "@/lib/time-clock.functions";
import { recordFieldCollection } from "@/lib/field-collections.functions";
import { createExpense } from "@/lib/expenses.functions";
import { recordWalkReport } from "@/lib/walk-report.functions";
import type { SyncCallers } from "@/lib/offline/sync";

export function useSyncCallers(): SyncCallers {
  const walkReportFn = useServerFn(recordWalkReport);
  const startFn = useServerFn(startVisit);
  const completeFn = useServerFn(completeVisit);
  const skipFn = useServerFn(skipVisit);
  const photoFn = useServerFn(recordVisitPhoto);
  const stationFn = useServerFn(logStationService);
  const clockInFn = useServerFn(clockIn);
  const clockOutFn = useServerFn(clockOut);
  const collectionFn = useServerFn(recordFieldCollection);
  const expenseFn = useServerFn(createExpense);
  return useMemo(
    () => ({
      startVisit: startFn,
      completeVisit: completeFn,
      skipVisit: skipFn,
      recordVisitPhoto: photoFn,
      logStationService: stationFn,
      clockIn: clockInFn,
      clockOut: clockOutFn,
      recordFieldCollection: collectionFn,
      createExpense: expenseFn,
      recordWalkReport: walkReportFn,
    }),
    [
      walkReportFn,
      startFn,
      completeFn,
      skipFn,
      photoFn,
      stationFn,
      clockInFn,
      clockOutFn,
      collectionFn,
      expenseFn,
    ],
  );
}
