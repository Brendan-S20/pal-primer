import { toast } from "sonner";
import { isStaleWriteError } from "@/lib/stale-write";

/**
 * Show a failed save. A save refused because somebody else changed the record
 * first (#655) stays up until it is dealt with and offers Reload, which
 * fetches the record again so the next attempt starts from what is there now.
 * Anything else is shown as it always was.
 */
export function toastSaveError(e: unknown, reload: () => unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  if (!isStaleWriteError(e)) {
    toast.error(message);
    return;
  }
  toast.error(message, {
    duration: Infinity,
    action: { label: "Reload", onClick: () => void reload() },
  });
}
