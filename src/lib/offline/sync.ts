// Sync driver — replays queued visit actions when the browser comes back
// online. Callers pass in bound server-fn callers (from `useServerFn`) so
// this module stays free of TanStack imports and remains easy to unit-test.

import { supabase } from "@/integrations/supabase/client";
import { isDefinitelyOffline } from "./connectivity";
import type { PhotoKind } from "@/lib/photo-kinds";
import { isTransportFailure, withDeadline } from "@/lib/offline/run-or-queue";
import {
  deleteAction,
  deletePhoto,
  recordAttempt,
  getPhoto,
  listPending,
  type PendingAction,
} from "./queue";

export interface SyncCallers {
  startVisit: (args: { data: { visitId: string; startedAt?: string } }) => Promise<unknown>;
  completeVisit: (args: {
    data: {
      visitId: string;
      completedAt?: string;
      note?: string;
      noPhotoReason?: string;
      checkedItems?: string[];
    };
  }) => Promise<unknown>;
  skipVisit: (args: {
    data: { visitId: string; reason: string; code: any; skippedAt?: string };
  }) => Promise<unknown>;
  recordVisitPhoto: (args: {
    data: { visitId: string; storagePath: string; kind: PhotoKind };
  }) => Promise<unknown>;
  logStationService: (args: {
    data: {
      visitId: string;
      wasteStationId: string;
      bagsCollected: number;
      linerReplaced: boolean;
      refillBagsAdded: number;
      notes?: string;
      servicedAt?: string;
    };
  }) => Promise<unknown>;
  /** Cash or a check taken at a stop, waiting for the office to confirm. */
  recordFieldCollection: (args: {
    data: {
      visitId: string;
      amountCents: number;
      method: "cash" | "check";
      reference?: string;
      clientKey: string;
      collectedAt?: string;
    };
  }) => Promise<unknown>;
  /** The time clock. `at` is the tap time; the SQL decides whether to believe
   *  it, as complete_visit does with `completedAt`. */
  clockIn: (args: { data: { at?: string } }) => Promise<unknown>;
  clockOut: (args: { data: { at?: string } }) => Promise<unknown>;
}

async function runOne(action: PendingAction, callers: SyncCallers): Promise<void> {
  switch (action.kind) {
    // `action.ts` is when the tech DID this, not when we got signal back.
    //
    // Without it, complete_visit stamped completed_at = now() and labelled the
    // row `tech_live` — so a visit finished at 9:15am in a dead zone and synced
    // at 4pm was recorded as a 4pm completion that we claimed to have measured.
    // Every offline visit in a day clustered onto whenever signal returned, in
    // the wrong order, feeding the completion rate, the progress bar, route
    // timing and the time the customer is shown.
    case "start":
      await callers.startVisit({
        data: { visitId: action.visitId, startedAt: new Date(action.ts).toISOString() },
      });
      return;
    case "complete":
      await callers.completeVisit({
        data: {
          visitId: action.visitId,
          completedAt: new Date(action.ts).toISOString(),
          note: action.note,
          noPhotoReason: action.noPhotoReason,
          // What the tech checked, carried exactly as the note is. Dropping it
          // here would turn every queued completion on a checklist org into a
          // refusal on replay: not a network error, so it burns attempts and
          // is dead-lettered, and the work the tech did is undone on screen.
          checkedItems: action.checkedItems,
        },
      });
      return;
    case "skip":
      // The third lifecycle action, and it sat directly under the comment
      // above asserting that `action.ts` is when the tech DID this — while
      // passing no timestamp. A skip queued at 9:15 in a dead zone was recorded
      // as a 4pm skip, which is what the skip-billing rules and the day's
      // figures then read.
      await callers.skipVisit({
        data: {
          visitId: action.visitId,
          reason: action.reason,
          code: action.code,
          skippedAt: new Date(action.ts).toISOString(),
        },
      });
      return;
    case "station":
      // The bag counts a commercial account is invoiced against, so the same
      // rule as the three above applies with more force: `serviced_at` is what
      // an HOA disputing a month of visits is answered with, and a replay that
      // stamped 4pm on work done at 9:15 in a basement garage would answer it
      // wrongly and confidently. `log_station_service` hardcoded now() until
      // the migration that added `_serviced_at`; without passing it here that
      // parameter would exist and never be used.
      await callers.logStationService({
        data: {
          visitId: action.visitId,
          wasteStationId: action.wasteStationId,
          bagsCollected: action.bagsCollected,
          linerReplaced: action.linerReplaced,
          refillBagsAdded: action.refillBagsAdded,
          notes: action.notes,
          servicedAt: new Date(action.ts).toISOString(),
        },
      });
      return;
    case "collection":
      // Same rule again: the money changed hands at the gate at 9:15, not on
      // the highway at 4. And the same key every attempt, so a request that
      // landed before its deadline is found rather than recorded twice.
      await callers.recordFieldCollection({
        data: {
          visitId: action.visitId,
          amountCents: action.amountCents,
          method: action.method,
          reference: action.reference,
          clientKey: action.clientKey,
          collectedAt: new Date(action.ts).toISOString(),
        },
      });
      return;
    case "clock_in":
      // Same rule as the four above. A clock-in queued at 7:02 in the yard and
      // synced at 7:40 on the highway started the shift at 7:02.
      await callers.clockIn({ data: { at: new Date(action.ts).toISOString() } });
      return;
    case "clock_out":
      await callers.clockOut({ data: { at: new Date(action.ts).toISOString() } });
      return;
    case "photo": {
      const photo = await getPhoto(action.photoId);
      // A missing blob is DATA LOSS, not a no-op. It used to `return`, which the
      // caller read as success — so the one path where a photo had been
      // destroyed was also the path that reported "synced". Say so instead.
      if (!photo) throw new MissingPhotoError(action.photoId);
      // The action's OWN id, not the clock.
      //
      // `Date.now()` made every attempt at the same photo a different object.
      // The upload is not the last step — `recordVisitPhoto` follows it — so any
      // failure after the bytes land (a refused insert, a dropped connection, a
      // deadline) leaves that object in storage and retries to a FRESH path.
      // Nothing references the first, nothing ever collects it, and the org is
      // billed for it. This loop retries up to MAX_ATTEMPTS, so one stubborn
      // photo could leave five copies of itself behind and then dead-letter,
      // taking the only reference with it.
      //
      // Keyed on the action, the retry rewrites the SAME object — which is also
      // why upsert has to be true. With `upsert: false` a retry after a
      // successful upload fails on "already exists", turning a recoverable
      // record-step failure into a permanent one.
      const path = `${action.organizationId}/${action.visitId}/${action.uploadKey ?? action.id}.${photo.ext}`;
      const { error } = await supabase.storage
        .from("visit-photos")
        .upload(path, photo.blob, { contentType: photo.contentType, upsert: true });
      if (error) throw error;
      await callers.recordVisitPhoto({
        data: { visitId: action.visitId, storagePath: path, kind: action.photoKind },
      });
      // Only now. Everything above can throw, and until this line the blob is
      // the only copy that exists.
      await deletePhoto(action.photoId);
      return;
    }
  }
}

let running = false;

/** The blob a queued photo points at is gone. Unrecoverable, so retrying it for
 *  ever would wedge everything behind it — it is dropped and COUNTED, never
 *  folded into the success total. */
export class MissingPhotoError extends Error {
  constructor(photoId: string) {
    super(`Queued photo ${photoId} is missing from device storage`);
    this.name = "MissingPhotoError";
  }
}

export interface SyncResult {
  attempted: number;
  succeeded: number;
  failed: number;
  /** Actions discarded because they can never succeed. Surfaced separately so
   *  a loss is never reported as a sync. */
  dropped: number;
  /** Actions the server refused MAX_ATTEMPTS times in a row while the device
   *  was online. Given up on, so the queue behind them can move. */
  deadLettered: number;
  /** WHICH visits those were, so the message that asks a person to redo
   *  physical work can name the door they have to go back to.
   *
   *  It used to say "2 queued actions the server kept refusing have been
   *  discarded so the rest could sync. Check the visit and redo it if needed"
   *  -- the only message in this app that asks somebody to drive somewhere
   *  again, and the least specific one in it. The action is in hand at the
   *  point of the decision; it just was not carried out. */
  deadLetteredVisitIds: string[];
  /** Same, for a photo whose bytes are gone from this device. */
  droppedVisitIds: string[];
  /** ANOTHER replay was already in flight, so this call did nothing.
   *
   *  Without this a caller cannot tell "I flushed and nothing succeeded" from
   *  "I never ran" — both are all-zeros. Sign-out reads that difference: it
   *  asks the tech to discard whatever is left, and a queue that is mid-replay
   *  is not left, it is seconds from landing. Discarding it would destroy work
   *  the background loop was about to sync, with the tech's consent obtained
   *  under a false premise. */
  alreadyRunning: boolean;
}

/** How many server refusals before an action is given up on.
 *
 *  Only failures that happened WHILE ONLINE count. A tech in a dead zone can
 *  retry all day without burning the budget — losing their work because the
 *  yard has no signal is the opposite of what this is for. The heuristic is
 *  `navigator.onLine`, which is honest about reachability rather than about
 *  whether the server is healthy, so a server outage lasting five sync cycles
 *  could still discard work. That is the residual risk, stated rather than
 *  hidden; five cycles of a reachable-but-refusing server is also a fair
 *  description of "this will never succeed".
 *
 *  The alternative — the previous behaviour — is one bad action blocking a
 *  tech's entire day with nothing on screen to explain it. */
export const MAX_ATTEMPTS = 5;

/** Longer than a field action's own deadline: a replay runs unattended, with
 *  nobody watching a button, so there is no impatience to serve — only the
 *  need to never wait for ever. Photos ride this path too. */
export const REPLAY_DEADLINE_MS = 60_000;

export async function syncQueue(callers: SyncCallers, userId: string): Promise<SyncResult> {
  if (running) {
    return {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      dropped: 0,
      deadLettered: 0,
      deadLetteredVisitIds: [],
      droppedVisitIds: [],
      alreadyRunning: true,
    };
  }
  running = true;
  const result: SyncResult = {
    alreadyRunning: false,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    dropped: 0,
    deadLettered: 0,
    deadLetteredVisitIds: [],
    droppedVisitIds: [],
  };
  // Sets rather than a guarded push, so the dead-letter branch stays the three
  // flat statements it has always been: delete, count, continue. A nested `if`
  // in there also defeats the extraction in tests/offline-dead-letter.test.ts,
  // which reads the branch as source and checks it continues rather than
  // breaking -- a rule worth keeping legible.
  // `undefined` is a clock tap, which belongs to no visit. Filtered out when
  // the ids are handed back, so the flat branches below need no guard.
  const deadLetteredVisits = new Set<string | undefined>();
  const droppedVisits = new Set<string | undefined>();
  try {
    // Only this user's actions. Replaying another tech's work under the
    // signed-in tech's identity fails every authorization check and wedges the
    // queue for the person actually holding the device.
    const pending = await listPending(userId);
    for (const action of pending) {
      result.attempted++;
      try {
        // QA-P4: a deadline, for the same reason the WRITE path needed one.
        // `runOne` had none, so a replay against a network that reports itself
        // up but answers nothing hung for ever — and because `running` is only
        // cleared in the `finally` below, the whole sync loop was wedged for
        // the rest of the session. Every later call returned zeros
        // immediately. The queue would fill and never drain, silently, which
        // is the same outcome for the tech as never queueing at all.
        await withDeadline(runOne(action, callers), REPLAY_DEADLINE_MS, `replay ${action.kind}`);
        await deleteAction(action.id);
        result.succeeded++;
      } catch (e) {
        if (e instanceof MissingPhotoError) {
          // Nothing to retry — the bytes are gone. Drop it so the rest of the
          // queue can move, and report it as a loss rather than a success.
          await deleteAction(action.id);
          result.dropped++;
          droppedVisits.add(action.visitId);
          console.error("offline sync dropped an action", action, e);
          continue;
        }
        // A failure with no network is not the action's fault. Only count it
        // against the action when the device believes it can reach the server
        // AND the failure was the server's answer rather than the absence of
        // one.
        //
        // The second half is new, and it closes the residual risk this comment
        // used to state and accept: `navigator.onLine` can be true while
        // nothing is reachable, so five cycles in a dead zone could burn an
        // action's whole budget and DISCARD a tech's work for a network
        // problem. A transport failure or a timeout is not evidence that an
        // action will never succeed — it is evidence that we could not ask.
        const online = !isDefinitelyOffline();
        if (online && !isTransportFailure(e)) {
          const attempts = await recordAttempt(action.id);
          if (attempts >= MAX_ATTEMPTS) {
            // Give up on THIS action so everything queued behind it can move.
            // Reported separately and loudly: the tech is the only person who
            // can redo the work, and silently discarding it would be worse
            // than the blockage this replaces.
            await deleteAction(action.id);
            if (action.kind === "photo") await deletePhoto(action.photoId);
            result.deadLettered++;
            deadLetteredVisits.add(action.visitId);
            console.error("offline sync gave up on an action", action, e);
            continue;
          }
        }
        result.failed++;
        console.warn("offline sync failed", action, e);
        // Stop on failure so we don't hammer a broken network / server. The
        // remaining items will retry on the next online event.
        break;
      }
    }
  } finally {
    running = false;
  }
  const isVisitId = (id: string | undefined): id is string => typeof id === "string";
  result.deadLetteredVisitIds = [...deadLetteredVisits].filter(isVisitId);
  result.droppedVisitIds = [...droppedVisits].filter(isVisitId);
  return result;
}
