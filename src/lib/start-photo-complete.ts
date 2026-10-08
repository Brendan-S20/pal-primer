// Start leads straight into the completion photo, and the photo finishes the
// visit.
//
// The owner, after the 2026-10-08 TestFlight build: a stop is Start, take the
// photo, Complete, every time, so the app should run them as one motion
// rather than three buttons found one after another. Where the business
// requires a completion photo (organizations.require_completion_photo, on by
// default):
//
//   Start ──► the camera opens on its own ──► photo saved ──► Complete
//                      │                            │
//                      └ cancel: the visit stays    └ a checklist? It comes
//                        started, and the card        first, and Complete
//                        says "Take photo to          waits for its required
//                        complete"                    items
//
// Where it does not, Start does not open the camera and Complete stays a
// button. Every step goes through the same offline-aware actions the buttons
// use (useOfflineVisitActions: runOrQueue, then IndexedDB), so in a dead zone
// the start, the photo and the completion are queued in that order and
// replayed in that order (the sync driver sends photos before the completion
// that needs them).
//
// The steps are passed in, so the order and every branch are tested without
// a camera (tests/start-leads-into-the-photo.test.ts).

import { missingRequired, type ChecklistItem } from "@/lib/visit-checklist";

/** Does a Start on this visit go straight on to the camera. */
export function startOpensCamera(opts: {
  requireCompletionPhoto: boolean;
  /** A completion photo is already on the visit, or queued for it. */
  photoOnFile: boolean;
  /** This person may complete the visit (not a preview, not a dispatcher). */
  canPerform: boolean;
}): boolean {
  return opts.canPerform && opts.requireCompletionPhoto && !opts.photoOnFile;
}

/** After the photo: complete at once, or show the checklist first. Any list
 *  at all is shown, so the optional items get their tick too; Complete on it
 *  waits only for the required ones. */
export function afterPhoto(checklist: readonly ChecklistItem[]): "complete" | "checklist" {
  return checklist.length > 0 ? "checklist" : "complete";
}

/** The ticks a checklist answer needs before it can complete. */
export function checklistReady(checklist: readonly ChecklistItem[], checked: string[]): boolean {
  return missingRequired([...checklist], checked).length === 0;
}

export type PhotoToCompleteSteps = {
  /** Open the camera. A file, or null when the tech cancelled. */
  capture: () => Promise<File | null>;
  /** Save it as the completion photo, live or queued. */
  upload: (file: File) => Promise<{ queued: boolean }>;
  /** The org's checklist, [] for none. */
  checklist: readonly ChecklistItem[];
  /** Show the checklist; the ids ticked, or null when it was put away. */
  askChecklist: () => Promise<string[] | null>;
  /** Complete, live or queued, with the ids ticked (when there is a list). */
  complete: (checkedItems?: string[]) => Promise<{ queued: boolean }>;
};

export type PhotoToCompleteOutcome =
  /** The camera was cancelled, or the photo could not be saved: the visit
   *  stays started and the card offers "Take photo to complete". */
  | "awaiting_photo"
  /** The photo is saved; the checklist was put away. Complete is a button. */
  | "awaiting_checklist"
  | "completed";

/**
 * Photo, then (checklist, then) Complete. What "Take photo to complete"
 * runs, and what Start runs after it succeeds. An upload that fails is
 * reported to `onUploadError` and leaves the visit started; a Complete that
 * fails throws, so the caller's own error handling says why.
 */
export async function photoThenComplete(
  steps: PhotoToCompleteSteps,
  onUploadError?: (e: unknown) => void,
): Promise<PhotoToCompleteOutcome> {
  const file = await steps.capture();
  if (!file) return "awaiting_photo";
  try {
    await steps.upload(file);
  } catch (e) {
    onUploadError?.(e);
    return "awaiting_photo";
  }
  let checked: string[] | undefined;
  if (afterPhoto(steps.checklist) === "checklist") {
    const answer = await steps.askChecklist();
    if (!answer || !checklistReady(steps.checklist, answer)) return "awaiting_checklist";
    // Only ids still on the owner's list.
    checked = answer.filter((id) => steps.checklist.some((i) => i.id === id));
  }
  await steps.complete(checked);
  return "completed";
}

/**
 * Start, and where the business requires a photo, the rest of it. Start
 * failing throws (nothing else is attempted); after a Start that worked,
 * live or queued, the photo step runs.
 */
export async function startThenPhotoThenComplete(
  start: () => Promise<{ queued: boolean }>,
  opensCamera: boolean,
  steps: PhotoToCompleteSteps,
  onUploadError?: (e: unknown) => void,
): Promise<"started" | PhotoToCompleteOutcome> {
  await start();
  if (!opensCamera) return "started";
  return photoThenComplete(steps, onUploadError);
}
