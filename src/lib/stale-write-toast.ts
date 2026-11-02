import { toast } from "sonner";
import { isStaleWriteError, STALE_WRITE_MESSAGE, STALE_WRITE_TITLE } from "@/lib/stale-write";

/**
 * A save failed. When it failed because somebody else saved first (#655),
 * say so and offer Reload, which fetches the record as it is now. Any other
 * failure is shown as it always was.
 */
export function toastSaveError(e: unknown, reload: () => void, fallback = "Could not save"): void {
  if (isStaleWriteError(e)) {
    toast.error(STALE_WRITE_TITLE, {
      description: STALE_WRITE_MESSAGE,
      duration: 20_000,
      action: { label: "Reload", onClick: reload },
    });
    return;
  }
  toast.error(e instanceof Error && e.message ? e.message : fallback);
}
