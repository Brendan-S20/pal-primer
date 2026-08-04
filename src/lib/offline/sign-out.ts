// Sign-out for a device that holds queued field work.
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
//
// `clearQueueForUser` was written, documented as "Called on sign-out", and
// never called by anything. `signOutAndClearDevice` swept localStorage only,
// despite its own comment promising to "destroy the persisted day". So on a
// shared crew tablet, signing out left behind:
//
//   - every queued start / complete / skip the tech had not yet synced, and
//   - the photo BLOBS attached to them — pictures of customers' back yards,
//     gates and houses — sitting in IndexedDB under the next person's session.
//
// The read cache had exactly this defect and it was fixed (BUG-43). This
// store, holding strictly more sensitive data, was left.
//
// ── WHY IT IS FLUSH-THEN-CLEAR, AND NOT JUST CLEAR ────────────────────────
//
// Clearing alone is a data-loss bug wearing a privacy fix's clothes: a tech
// who finishes a route in a dead zone, walks into the office and signs out
// would lose the entire afternoon, with nothing on screen to say so. So we try
// to sync first, and only what genuinely cannot be synced is discarded — and
// discarding is never silent, it needs a yes.
//
// The order is deliberate: flush, count what is LEFT, ask, clear, then sign
// out. The clear happens before `supabase.auth.signOut()` for the same reason
// the read-cache clear does — a signOut that hangs on a bad connection must
// still leave the device clean.

import { countPending, clearQueueForUser } from "./queue";
import { syncQueue, type SyncCallers } from "./sync";
import { signOutAndClearDevice } from "./read-cache";
import { resolveOfflineUserId } from "./action-owner";
import { withDeadline } from "./run-or-queue";

/** A whole flush, not one action.
 *
 *  `syncQueue` gives each action REPLAY_DEADLINE_MS (60s) and stops at the
 *  first failure, so an unattended replay can afford to wait. A person tapping
 *  "Sign out" cannot: a minute of a dead button is indistinguishable from a
 *  broken app, and they will kill it. This bound means the worst case is a
 *  short wait followed by an honest question about what is left. */
export const SIGN_OUT_FLUSH_DEADLINE_MS = 15_000;

export interface SignOutOutcome {
  /** False only when the user was ASKED about discarding queued work and said
   *  no. They stay signed in with their queue intact. */
  signedOut: boolean;
  /** Actions that reached the server during the flush. */
  synced: number;
  /** Actions dropped unsynced, with the user's consent. */
  discarded: number;
  /** Photos whose bytes were already gone, and actions the server refused
   *  MAX_ATTEMPTS times. Both are LOSSES the flush itself caused, and the flush
   *  used to report only `succeeded` — so a tech whose one bad action
   *  dead-lettered during the sign-out flush saw "Synced 3 queued actions",
   *  was signed out, and never learned the fourth was gone. `remaining` is 0 by
   *  then, so the confirm never fires either. sync.ts:103 says these are
   *  "surfaced separately so a loss is never reported as a sync"; this is the
   *  caller that was not surfacing them. */
  lost: number;
  /** The flush never ran — no network, or no callers were supplied. */
  flushSkipped: boolean;
}

/**
 * Sync what can be synced, ask about the rest, then wipe this user's queue and
 * sign out.
 *
 * `confirmDiscard` is what makes the loss consensual. Without it, unsynced work
 * is KEPT and sign-out is refused, because the default for "I can't ask" has to
 * be "don't destroy it" — the tech is the only person who can redo the work.
 */
export async function flushThenClearAndSignOut(opts: {
  callers?: SyncCallers;
  confirmDiscard?: (remaining: number) => boolean | Promise<boolean>;
}): Promise<SignOutOutcome> {
  const userId = await ownerOrNull();
  if (!userId) {
    // No session and nothing remembered: there is no queue that could belong to
    // anyone here, so there is nothing to flush and nothing to consent to.
    await signOutAndClearDevice();
    return { signedOut: true, synced: 0, discarded: 0, lost: 0, flushSkipped: true };
  }

  let synced = 0;
  let lost = 0;
  let flushSkipped = true;

  const online = typeof navigator === "undefined" || navigator.onLine;
  const pending = await countPending(userId);
  if (pending > 0 && opts.callers && online) {
    flushSkipped = false;
    try {
      const res = await withDeadline(
        syncQueue(opts.callers, userId),
        SIGN_OUT_FLUSH_DEADLINE_MS,
        "sign-out flush",
      );
      synced = res.succeeded;
      lost = res.dropped + res.deadLettered;
      if (res.alreadyRunning) {
        // Another replay is mid-flight. Its rows are seconds from landing, and
        // `remaining` below would count them as unsynced — so the tech would be
        // asked to discard work that was about to succeed, and consent obtained
        // on a false premise is worse than no consent. Refuse instead.
        return { signedOut: false, synced: 0, discarded: 0, lost: 0, flushSkipped: false };
      }
    } catch {
      // The deadline, or a replay that threw past `syncQueue`'s own handling.
      // Either way the queue is re-counted below, so the number we ask about is
      // what is actually still there — not what we predicted would be.
      //
      // A timed-out flush keeps running in the background; the clear below may
      // therefore delete a row whose replay is still in flight. That replay
      // still lands server-side, which is strictly better than the alternative
      // (the action was headed for the bin anyway), and `deleteAction` on an
      // already-deleted key is a no-op.
    }
  }

  const remaining = await countPending(userId);
  if (remaining > 0) {
    if (!opts.confirmDiscard) return { signedOut: false, synced, discarded: 0, lost, flushSkipped };
    const ok = await opts.confirmDiscard(remaining);
    if (!ok) return { signedOut: false, synced, discarded: 0, lost, flushSkipped };
  }

  // Actions AND the photo blobs they point at. This is the part that never ran.
  await clearQueueForUser(userId);
  await signOutAndClearDevice();
  return { signedOut: true, synced, discarded: remaining, lost, flushSkipped };
}

/** Who is signing out, or null if this device cannot say.
 *
 *  `resolveOfflineUserId` throws when there is no session and nothing
 *  remembered, which is the right answer when it guards a WRITE — work that
 *  cannot be attributed should be refused. Here it is the opposite: an
 *  unattributable device has no queue to protect, and refusing to sign out
 *  because we don't know who you are would strand someone on a tablet. */
async function ownerOrNull(): Promise<string | null> {
  try {
    return await resolveOfflineUserId();
  } catch {
    return null;
  }
}
