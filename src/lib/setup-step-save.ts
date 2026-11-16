// How a setup step saves: one contract for every form on /setup.
//
//   - The step advances ONLY when its save succeeded (onSaved runs from
//     onSuccess, never from onSettled).
//   - A failure is said on screen, with the server's own sentence.
//   - The lists Settings reads are refreshed after success AND failure. A step
//     with more than one write (step 1 writes service lines, then the
//     business, then the time zone) can fail part-way with the first write
//     saved; refreshing only on success left Settings showing the old answer
//     over a saved new one, which reads exactly like "it didn't save".
//
//   - A failure is never ONLY a toast (#881). A toast is four seconds at the
//     top of the screen; an owner who pressed Save and looked down at the
//     form for the result missed it, and reported "nothing happened". So a
//     form can take the same sentence through `onFailed` and keep it on
//     screen, next to its Save, until the next try.
//   - And it is a sentence. A request the platform cut off (a timeout, a
//     worker error) answers with an HTML error page, and that page's markup
//     WAS the toast. readableSaveError turns anything that is not a sentence
//     into one.
//
// Plain options for useMutation, so it is tested with react-query's own
// MutationObserver and no DOM (tests/what-onboarding-saves-settings-shows).

import type { MutationOptions, QueryClient, QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";

export type StepNotify = {
  success: (message: string) => void;
  error: (message: string) => void;
};

const toasts: StepNotify = {
  success: (m) => void toast.success(m),
  error: (m) => void toast.error(m),
};

export const SAVE_FAILED_FALLBACK = "That didn't save. Check your connection and try again.";

export const SAVE_NO_ANSWER =
  "That didn't save: the server didn't answer in time. What you typed is still here. Try again.";

/** The sentence a failed save shows: the server's own words when it sent
 *  words, else one that says what happened and that nothing typed was lost. */
export function readableSaveError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const message = (raw ?? "").trim();
  if (!message) return SAVE_FAILED_FALLBACK;
  // An error PAGE, not an error message: markup, or a gateway's status line.
  if (/<\/?(html|body|head|title|div|h1|p)\b|<!doctype/i.test(message)) return SAVE_NO_ANSWER;
  if (/^(504|502|503)\b|gateway time-?out|worker (exceeded|threw)/i.test(message)) {
    return SAVE_NO_ANSWER;
  }
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

export function stepSave<T>(args: {
  qc: QueryClient;
  save: () => Promise<T>;
  /** Every query key a screen showing this value reads. */
  refresh: readonly QueryKey[];
  /** A success message, or a function of the result for one that varies. */
  saved?: string | ((result: T) => void);
  /** Advance the step. Only ever called after a successful save. */
  onSaved: (result: T) => void;
  notify?: StepNotify;
  /** The same sentence as the toast, for a form that keeps it on screen. */
  onFailed?: (message: string) => void;
}): MutationOptions<T, Error, void> {
  const notify = args.notify ?? toasts;
  return {
    mutationFn: () => args.save(),
    onSettled: () => {
      for (const queryKey of args.refresh) void args.qc.invalidateQueries({ queryKey });
    },
    onSuccess: (result) => {
      if (typeof args.saved === "string") notify.success(args.saved);
      else args.saved?.(result);
      args.onSaved(result);
    },
    onError: (e) => {
      const message = readableSaveError(e);
      notify.error(message);
      args.onFailed?.(message);
    },
  };
}
