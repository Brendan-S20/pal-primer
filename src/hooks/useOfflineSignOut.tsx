// The sign-out every staff surface should call.
//
// `signOutAndClearDevice` cleared localStorage and left the IndexedDB action
// queue — unsynced visits and the photo blobs attached to them — on the device
// for the next person to unlock it. `flushThenClearAndSignOut` fixes that, but
// it needs two things a lib module cannot have: bound server-fn callers to
// replay with, and a way to ask a human whether losing work is acceptable.
// This hook supplies both, so a call site is still one `await`.
//
//   const { signOut, dialog } = useOfflineSignOut();
//   ...
//   if (await signOut()) window.location.href = "/auth";
//   ...
//   return <>{dialog}...</>

import { useCallback, useMemo } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { startVisit, completeVisit, skipVisit, recordVisitPhoto } from "@/lib/my-day.functions";
import { flushThenClearAndSignOut } from "@/lib/offline/sign-out";
import { useConfirmDialog } from "@/components/ConfirmDialog";

export function useOfflineSignOut() {
  const startFn = useServerFn(startVisit);
  const completeFn = useServerFn(completeVisit);
  const skipFn = useServerFn(skipVisit);
  const photoFn = useServerFn(recordVisitPhoto);
  const callers = useMemo(
    () => ({
      startVisit: startFn,
      completeVisit: completeFn,
      skipVisit: skipFn,
      recordVisitPhoto: photoFn,
    }),
    [startFn, completeFn, skipFn, photoFn],
  );

  const { confirm, dialog } = useConfirmDialog();

  /** Resolves true when the session actually ended. False means the tech chose
   *  to keep their unsynced work — do NOT navigate to /auth on false. */
  const signOut = useCallback(async (): Promise<boolean> => {
    const outcome = await flushThenClearAndSignOut({
      callers,
      confirmDiscard: (remaining) =>
        confirm({
          title: `${remaining} ${remaining === 1 ? "job hasn't" : "jobs haven't"} synced yet`,
          // Say what is lost and who can recover it. "Unsaved changes" would be
          // both vague and wrong: the work exists, it just only exists here.
          description: (
            <>
              <p>
                Signing out erases this device's copy, and{" "}
                {remaining === 1 ? "it" : "they"} can only be redone by hand.
              </p>
              <p>
                Stay signed in and reconnect if you can — the app will send{" "}
                {remaining === 1 ? "it" : "them"} on its own once you have signal.
              </p>
            </>
          ),
          confirmLabel: "Sign out and discard",
          cancelLabel: "Stay signed in",
          destructive: true,
        }),
    });

    if (outcome.synced > 0) {
      toast.success(
        `Synced ${outcome.synced} queued action${outcome.synced === 1 ? "" : "s"} before signing out`,
      );
    }
    return outcome.signedOut;
  }, [callers, confirm]);

  return { signOut, dialog };
}
