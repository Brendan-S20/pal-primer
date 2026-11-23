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
//
// It is asked only when the business requires the proof: with Require a
// completion photo off and no required checklist item, office_complete_visit
// does not refuse, and the office's Complete is one confirmation (#915). A
// new business that only walks, sits, grooms or trains starts with the photo
// rule off; one that scoops keeps it on (lib/new-business-defaults.ts).
import { useCallback, useId, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { useOfflineVisitActions } from "@/lib/offline/useOfflineVisitActions";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** What the dialog resolves with when a completion photo was just added:
 *  complete again, no reason needed. */
export const PHOTO_ADDED = Symbol("photo-added");
type WhyAnswer = string | null | typeof PHOTO_ADDED;

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
  askWhy: (missing: string, visitId?: string) => Promise<WhyAnswer>,
  checkBlock?: () => Promise<"clear" | "acknowledged" | "cancelled">,
  visitId?: string,
): Promise<boolean> {
  const block = checkBlock ? await checkBlock() : "clear";
  if (block === "cancelled") return false;
  const acknowledged = block === "acknowledged" ? true : undefined;
  let first = await call(undefined, acknowledged);
  if (first.ok) return true;
  let why = await askWhy(first.needsOverride, visitId);
  // A photo added in the dialog: ask the database again before asking why.
  while (why === PHOTO_ADDED) {
    first = await call(undefined, acknowledged);
    if (first.ok) return true;
    why = await askWhy(first.needsOverride, visitId);
  }
  if (!why) return false;
  const second = await call(why, acknowledged);
  if (!second.ok) throw new Error(second.needsOverride);
  return true;
}

export function useOfficeCompleteOverride() {
  const [missing, setMissing] = useState<string | null>(null);
  const [visitId, setVisitId] = useState<string | undefined>();
  const [reason, setReason] = useState("");
  const resolver = useRef<(v: WhyAnswer) => void>(() => {});
  const fieldId = useId();

  const askWhy = useCallback((what: string, forVisitId?: string): Promise<WhyAnswer> => {
    return new Promise<WhyAnswer>((resolve) => {
      resolver.current = resolve;
      setReason("");
      setVisitId(forVisitId);
      setMissing(what);
    });
  }, []);

  function settle(value: WhyAnswer) {
    resolver.current(value);
    resolver.current = () => {};
    setMissing(null);
  }

  const trimmed = reason.trim();
  const dialog = (
    <AlertDialog open={missing != null} onOpenChange={(o) => !o && settle(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          {/* Says what is missing, that the business's own setting is why
              it is asked, and where that setting lives: "Complete without
              the tech's proof?" read as a failed complete to an owner who
              had never seen the setting (#915). */}
          <AlertDialogTitle>Complete without the required proof?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p className="break-words font-medium text-foreground">{missing}</p>
              <p>
                Your business requires this before a visit is completed. If the work was done, say
                why: it is recorded on the visit and the client&apos;s timeline.
              </p>
              <p>
                To stop asking, change <span className="font-medium">Finishing a visit</span> in
                Settings &rarr; Business defaults.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* The fix first: the missing photo can be added right here. */}
        {visitId && missing && /photo/i.test(missing) && (
          <CompletionPhotoButton visitId={visitId} onAdded={() => settle(PHOTO_ADDED)} />
        )}
        <div className="space-y-2">
          <Label htmlFor={fieldId}>Why is it missing?</Label>
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
          {/* A plain button, not AlertDialogCancel: Cancel closes by settling
              the promise itself rather than relying on the dialog's own
              close, so it cannot be left open behind a drawer (#1012). */}
          <Button type="button" variant="outline" onClick={() => settle(null)}>
            Cancel
          </Button>
          <Button disabled={!trimmed} onClick={() => settle(trimmed)}>
            Complete with this reason
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { askWhy, dialog };
}

/** Adds the photo the business requires, typed Completion, from the dialog
 *  that asks for it. Online it uploads and the completion is tried again;
 *  offline the photo is queued and the dialog says it will not count yet. */
function CompletionPhotoButton({ visitId, onAdded }: { visitId: string; onAdded: () => void }) {
  const actions = useOfflineVisitActions(visitId, undefined);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const inputId = useId();

  async function add(file: File) {
    setBusy(true);
    setNote(null);
    try {
      const r = await actions.uploadPhoto(file, "completion");
      if (r.queued) {
        setNote(
          "You're offline. The photo is saved and uploads when you're back online. It will not count until then.",
        );
        return;
      }
      onAdded();
    } catch (e) {
      setNote(e instanceof Error && e.message ? e.message : "The photo did not upload. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <input
        id={inputId}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        data-testid="completion-photo-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void add(f);
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="outline"
        className="w-full touch:min-h-11"
        disabled={busy}
        onClick={() => document.getElementById(inputId)?.click()}
      >
        <Camera className="mr-1.5 h-4 w-4 shrink-0" />
        {busy ? "Uploading…" : "Add completion photo"}
      </Button>
      {note && (
        <p role="alert" className="text-xs text-destructive">
          {note}
        </p>
      )}
    </div>
  );
}
