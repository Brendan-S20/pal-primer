// QA-P4 — why offline work never reached the durable queue.
//
// The queue, the replay loop, the dead-letter cap and the UI that reports it
// were all built and all correct. Nothing reached them: a tech tapped Start,
// the button went disabled and stayed disabled, no toast appeared, and
// `scoop-offline.actions` stayed at zero rows. Close the app and the work was
// gone.
//
// ── THE CAUSE: navigator.onLine IS NOT A CONNECTIVITY CHECK ───────────────
//
// The decision to queue was `if (navigator.onLine) { try the server } else
// { queue }`. That reads as though `onLine` answers "can I reach the server".
// It does not. It answers "does this device have a network interface that
// thinks it is up" — and the browser spec is explicit that a `true` value
// guarantees nothing. A phone showing one bar in a back yard, a van on a
// carrier that has dropped the data session, a café captive portal: all report
// `onLine === true`.
//
// In that state the request neither succeeds nor fails. It HANGS. And every
// symptom follows from the hang, not from the queue:
//
//   * no toast — the mutation never settled, so neither callback ran;
//   * the button stayed disabled — `isPending` never cleared;
//   * nothing was queued — the `catch` that queues was never reached;
//   * and when signal returned the visit DID start, because the original
//     request was still in flight the whole time.
//
// `onLine === false` is trustworthy (there is definitely no network). `true`
// is a guess. So it is still used to skip a pointless request, but it is no
// longer allowed to be the only thing standing between a tech and their work
// being recorded.
//
// ── THE FIX: A DEADLINE ───────────────────────────────────────────────────
//
// A request that has not answered within the deadline is treated exactly like
// a transport failure: queue it, tell the tech it is queued, release the
// button. The request is not cancelled — it may still land — and that is safe
// because every action this guards is idempotent at the database:
//
//   start_visit     started_at = COALESCE(started_at, now()), and the UPDATE
//                   is filtered to status IN ('scheduled','in_progress')
//   complete_visit  filtered to ('scheduled','in_progress','missed'), and
//                   returns early when nothing matched, so the finalize step
//                   cannot run twice
//   skip_visit      filtered to ('scheduled','in_progress')
//
// So the worst case is that the action applies once on the network and the
// replay finds nothing to do. Verified against the live definitions before
// this was written, because "queue it anyway" is only safe if that holds.
//
// ── WHAT MUST STILL FAIL LOUDLY ───────────────────────────────────────────
//
// A SERVER rejection is not a network problem. "Not authorized for this
// visit", a validation error, an RLS refusal — queueing those reports success
// for an action that will never apply, and the tech drives away believing the
// visit is recorded. Only transport failures and timeouts fall through.

/** How long a field action may wait before it is treated as unreachable.
 *
 *  Eight seconds is a compromise between two bad outcomes. Too short and a
 *  slow-but-working 3G connection queues actions that would have completed,
 *  which is harmless but makes the UI say "queued" when it did not need to.
 *  Too long and a tech stands at a gate watching a disabled button, which is
 *  the bug this is fixing. Eight seconds is longer than any successful call
 *  observed on this endpoint and short enough not to feel broken. */
export const ACTION_DEADLINE_MS = 8_000;

export class ActionTimeout extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not answer within ${ms}ms`);
    this.name = "ActionTimeout";
  }
}

/**
 * Resolve `p`, or reject with ActionTimeout after `ms`.
 *
 * The underlying promise is NOT cancelled — there is no way to cancel a
 * server function call from here, and pretending otherwise would be worse
 * than letting it land. See the idempotency note above for why letting it
 * land is safe.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ActionTimeout(label, ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Only TRANSPORT failures fall through to the offline queue.
 *
 * A timeout counts: an answer that never came is indistinguishable from a
 * connection that never opened, and the tech is standing in the same yard
 * either way.
 */
export function isTransportFailure(e: unknown): boolean {
  if (e instanceof ActionTimeout) return true;
  if (e instanceof TypeError) return true; // fetch() transport failure
  const msg = e instanceof Error ? e.message : String(e);
  return /failed to fetch|networkerror|load failed|network request failed|timeout|abort/i.test(msg);
}

export type RunOrQueueOptions = {
  /** `navigator.onLine`. False is trustworthy; true is a guess. */
  online: boolean;
  /** The network attempt. */
  send: () => Promise<unknown>;
  /** Write the action to the durable queue. Must not depend on the network. */
  queue: () => Promise<void>;
  /** Named in the timeout message and the log. */
  label: string;
  deadlineMs?: number;
};

/**
 * Do it now, or queue it — the one place that decision is made.
 *
 * This existed four times over in useOfflineVisitActions, once per action,
 * with the same eight lines copied each time. That is the shape this codebase
 * keeps finding (three copies of the royalty calculation, three of the
 * org-local-day formatter): the fix goes into one copy and the other three
 * keep the bug. A single implementation is also the only way any of it can be
 * tested without a browser.
 */
export async function runOrQueue<T = unknown>(
  o: Omit<RunOrQueueOptions, "send"> & { send: () => Promise<T> },
): Promise<{ queued: true } | { queued: false; result: T }> {
  if (o.online) {
    try {
      const result = await withDeadline(o.send(), o.deadlineMs ?? ACTION_DEADLINE_MS, o.label);
      return { queued: false, result };
    } catch (e) {
      // A server rejection is the tech's answer, not a network condition.
      if (!isTransportFailure(e)) throw e;
      console.warn(`[offline] ${o.label} unreachable, queueing`, e);
    }
  }
  await o.queue();
  return { queued: true };
}
