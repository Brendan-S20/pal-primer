// QA-P4, the second half — the network call hiding inside the offline path.
//
// Every queued action records who made it. `lib/offline/queue.ts` explains why
// at length: replay runs as whoever is signed in at the time, so an unowned
// action is one the wrong tech can replay, and the v1→v2 schema bump DROPPED
// existing rows rather than guess an owner.
//
// The owner was read with `supabase.auth.getSession()`. That reads from local
// storage — except when the stored access token has expired, in which case
// supabase-js refreshes it OVER THE NETWORK first. Offline, that request
// hangs.
//
// Which means the ownership lookup, sitting on the path whose entire purpose
// is to work without a network, could block the queue write indefinitely. And
// it does so in exactly the circumstance the queue exists for: a tech who has
// been out of signal long enough for their token to age out. A short dead zone
// worked; an hour in a yard did not.
//
// This is the second unbounded network dependency on that path, after the
// request itself. Both had the same shape — code only ever reached when
// offline, quietly depending on being online.
//
// ── THIS FUNCTION WAS ALREADY NAMED, AND NEVER WRITTEN ────────────────────
//
// `read-cache.ts` documents `rememberLastUser` as:
//
//     Read ONLY when the network is gone and Supabase can no longer answer
//     who is signed in — see resolveOfflineUserId.
//
// There was no `resolveOfflineUserId`. The storage half existed and was
// maintained; the reader the comment promised did not, so the fallback the
// comment described could never happen. That is the failure this ledger keeps
// finding — a written claim treated as a fact — and the fix is to write the
// function the comment names rather than a differently-named one beside it.
//
// It also matters that it reuses LAST_USER_KEY rather than a key of its own.
// That key is cleared by `clearPersistedReadCaches`, which sign-out calls
// FIRST, precisely so the next tech to unlock a shared crew tablet cannot
// inherit the previous one's identity. A second key would not be cleared, and
// the shared-tablet case is the one where getting the owner wrong is worst.

import { supabase } from "@/integrations/supabase/client";
import { readLastUser, rememberLastUser } from "@/lib/offline/read-cache";
import { withDeadline, ActionTimeout } from "@/lib/offline/run-or-queue";

/** Short: this is a local-storage read in every case that matters. A second is
 *  already generous, and waiting longer is waiting on a token refresh that
 *  cannot succeed. */
export const OWNER_DEADLINE_MS = 1_000;

/**
 * Who owns the action about to be queued.
 *
 * Bounded, because this runs on the offline path. The live session wins when
 * it answers; the remembered id covers the case where `getSession` is off
 * refreshing a token against a network that is not there.
 */
export async function resolveOfflineUserId(
  deadlineMs: number = OWNER_DEADLINE_MS,
): Promise<string> {
  try {
    const { data } = await withDeadline(supabase.auth.getSession(), deadlineMs, "session lookup");
    const id = data.session?.user?.id;
    if (id) {
      // Keep the fallback fresh on every successful read, so it is never
      // staler than the last time this device saw a session.
      rememberLastUser(id);
      return id;
    }
  } catch (e) {
    // A real auth error is not a connectivity problem and must surface.
    if (!(e instanceof ActionTimeout)) throw e;
  }

  const remembered = readLastUser();
  if (remembered) return remembered;

  // No session and nothing remembered — a device that has never completed an
  // authenticated load. Refusing is deliberate: work that cannot be attributed
  // is worse than work that was never accepted, because the tech finds out now
  // rather than when it silently fails to replay. Same call the v2 migration
  // made when it dropped unowned rows.
  //
  // The wording has to tell them what to do. "Not signed in", while they are
  // looking at their own day, is not believable and sends them to support.
  throw new Error(
    "Can't save this offline because your sign-in couldn't be confirmed. Open the app once with signal, then try again.",
  );
}
