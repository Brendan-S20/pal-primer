// One button walks the visit.
//
// The owner, on the build with #357 in it (2026-10-09): "When I start a visit,
// it auto-opens the camera. It's not supposed to do that. And it created
// another button for taking a completion picture, instead of keeping all the
// same button and following a workflow."
//
// So a stop card has ONE primary action, in one place, and it advances:
//
//   Start ──► Take completion photo ──► Complete
//                 │
//                 └ only where the business requires a completion photo
//                   (organizations.require_completion_photo) and the visit
//                   has none, live or queued, and no reason for not having
//                   one has been written under "Can't take a photo?"
//
// Each step is a tap. Nothing opens the camera but a tap on the photo step:
// not Start, not the lock screen. A photo taken, or not required, and the
// button after Start is Complete. The optional photo kinds (before, gate
// latched, ...) keep their own picker on the card.
//
// The step is read from the visit as My Day draws it — the server's status
// with every queued Start / Complete laid over it (useQueuedLifecycle) — and
// from the completion photos on file or waiting in the offline queue, so in a
// dead zone the button advances on the queued action exactly as it does on a
// live one.
//
// tests/one-button-walks-the-visit.test.ts.

export type VisitStep = "start" | "photo" | "complete";

export type VisitStepState = {
  /** visit.status as drawn: the server's, with queued actions applied. */
  status: string;
  /** Start succeeded (live or queued) on this card and the status has not
   *  caught up yet: the refetch is in flight. */
  startedHere?: boolean;
  requireCompletionPhoto: boolean;
  /** A completion photo is on the visit, or queued for it. */
  photoOnFile: boolean;
  /** "Can't take a photo?" has a reason long enough for complete_visit. */
  noPhotoReasonGiven: boolean;
  /** This person may perform the visit (not a preview, not a dispatcher). */
  canPerform: boolean;
};

/** The one thing the card's primary button does next, or null when the card
 *  has no primary action (completed, skipped, canceled). */
export function visitStep(s: VisitStepState): VisitStep | null {
  const underWay =
    s.status === "in_progress" ||
    s.status === "missed" ||
    (s.status === "scheduled" && !!s.startedHere);
  if (!underWay) return s.status === "scheduled" ? "start" : null;
  if (s.canPerform && s.requireCompletionPhoto && !s.photoOnFile && !s.noPhotoReasonGiven) {
    return "photo";
  }
  return "complete";
}

export type VisitStepHandlers = Record<VisitStep, () => unknown>;

/** What a tap on the button does at this step: that step's handler, and only
 *  that one. Start never reaches the camera; the photo step never completes. */
export function runVisitStep(step: VisitStep, handlers: VisitStepHandlers): unknown {
  return handlers[step]();
}

/**
 * The completion photo, from the camera the device has. Native (Capacitor
 * Camera, src/lib/native) inside the app; otherwise `pickFromWeb`, the card's
 * file input with capture="environment". Null when the tech cancelled.
 */
export async function captureCompletionFile(
  pickFromWeb: () => Promise<File | null>,
): Promise<File | null> {
  try {
    const { isNative, takePhotoNative } = await import("@/lib/native");
    if (isNative()) {
      try {
        const blob = await takePhotoNative();
        return blob
          ? new File([blob], `photo-${Date.now()}.jpg`, { type: blob.type || "image/jpeg" })
          : null;
      } catch (e) {
        // Capacitor rejects a cancelled camera ("User cancelled photos
        // app"); that is a no, not a reason to open a second picker.
        if (/cancel/i.test(String((e as { message?: string })?.message ?? e))) return null;
      }
    }
  } catch {
    /* the web input */
  }
  return pickFromWeb();
}

/** The photo step: the camera, then the upload as the completion photo.
 *  Never completes the visit — the button does that, as its next step. */
export async function takeCompletionPhoto(steps: {
  capture: () => Promise<File | null>;
  upload: (file: File) => Promise<boolean>;
}): Promise<"taken" | "cancelled" | "failed"> {
  const file = await steps.capture();
  if (!file) return "cancelled";
  return (await steps.upload(file)) ? "taken" : "failed";
}
