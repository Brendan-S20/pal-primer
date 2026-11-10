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
    onError: (e) =>
      notify.error(e?.message || "That didn't save. Check your connection and try again."),
  };
}
