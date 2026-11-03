import { Button } from "@/components/ui/button";

/**
 * Said when a form opened on what was typed last time (useFormDraft,
 * gaps-r2-12), with the one way back to an empty form. Office screens only,
 * so English.
 */
export function DraftRestoredNotice({ onDiscard }: { onDiscard: () => void }) {
  return (
    <div
      role="status"
      data-draft-restored
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/40 p-3 text-sm"
    >
      <p className="min-w-0">
        We kept what you typed here last time on this device. It stays until you save or sign out.
      </p>
      <Button type="button" variant="outline" size="sm" onClick={onDiscard}>
        Discard draft
      </Button>
    </div>
  );
}
