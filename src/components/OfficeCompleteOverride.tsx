// The office's Complete asks what the tech's does (#658, F-15): a completion
// photo when the business requires one, and the required checklist items for
// the visit's line. When one is missing, the database refuses without a
// reason, and this asks the person for one:
//
//   const { askWhy, dialog } = useOfficeCompleteOverride();
//   ...
//   mutationFn: (early) => completeFromOffice(
//     (overrideReason) => doComplete({ data: { visitId, confirmedEarly: early, overrideReason } }),
//     askWhy,
//   ),
//   onSuccess: (done) => { if (!done) return; ... }
//   ...
//   return <>{dialog}...</>
//
// Saying why is the override: it is recorded on the visit and on the
// client's timeline. Cancelling leaves the visit as it was.
import { useCallback, useId, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type OfficeCompleteResult = { ok: true } | { ok: false; needsOverride: string };

/** Runs an office Complete, asking why when the database says the photo or
 *  the checklist is missing. Resolves true when the visit was completed and
 *  false when the person cancelled.
 *
 *  `checkBlock` runs first, before anything is saved: the owner's BLOCK
 *  warning (useCompletionBlockWarning, #851 follow-up). Cancel there ends it
 *  here with nothing written; Continue goes on, and `call` is told so the
 *  timeline records that the warning was seen. */
export async function completeFromOffice(
  call: (overrideReason?: string, blockAcknowledged?: boolean) => Promise<OfficeCompleteResult>,
  askWhy: (missing: string) => Promise<string | null>,
  checkBlock?: () => Promise<"clear" | "acknowledged" | "cancelled">,
): Promise<boolean> {
  const block = checkBlock ? await checkBlock() : "clear";
  if (block === "cancelled") return false;
  const acknowledged = block === "acknowledged" ? true : undefined;
  const first = await call(undefined, acknowledged);
  if (first.ok) return true;
  const why = await askWhy(first.needsOverride);
  if (!why) return false;
  const second = await call(why, acknowledged);
  if (!second.ok) throw new Error(second.needsOverride);
  return true;
}

export function useOfficeCompleteOverride() {
  const [missing, setMissing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const resolver = useRef<(v: string | null) => void>(() => {});
  const fieldId = useId();

  const askWhy = useCallback((what: string): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
      setReason("");
      setMissing(what);
    });
  }, []);

  function settle(value: string | null) {
    resolver.current(value);
    resolver.current = () => {};
    setMissing(null);
  }

  const trimmed = reason.trim();
  const dialog = (
    <AlertDialog open={missing != null} onOpenChange={(o) => !o && settle(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Complete without the tech&apos;s proof?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p className="break-words">{missing}</p>
              <p>
                A tech can&apos;t complete it like this. If you know the work was done, say why and
                it is recorded on the visit and the client&apos;s timeline.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor={fieldId}>Why</Label>
          <Textarea
            id={fieldId}
            value={reason}
            maxLength={250}
            rows={3}
            autoFocus
            // A solid field, and a placeholder that says it is an example:
            // light text on a transparent box read as already filled in (#789).
            className="bg-background"
            placeholder="For example: client confirmed by phone; tech's phone died"
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(null)}>Cancel</AlertDialogCancel>
          <Button disabled={!trimmed} onClick={() => settle(trimmed)}>
            Complete anyway
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { askWhy, dialog };
}
