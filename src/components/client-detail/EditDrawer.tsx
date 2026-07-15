// Shared edit surface for the client detail page (UX round 3): a centered
// modal dialog on desktop (drawers wasted space on large monitors), a
// full-screen sheet on mobile. One component, one behavior — every editor
// on the page inherits changes made here. Closing with unsaved changes asks
// first via a styled modal; children close through context so the guard
// applies to Cancel buttons too.
import { createContext, useContext, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";

const MODAL_SIZE_CLASS: Record<DrawerSize, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-2xl",
  lg: "sm:max-w-4xl",
};

export type DrawerSize = "sm" | "md" | "lg";

// Children (DrawerFooter's Cancel, custom buttons) close through this so the
// unsaved-changes guard applies everywhere, not just overlay/Escape.
const DrawerCloseContext = createContext<() => void>(() => {});
export function useDrawerClose() {
  return useContext(DrawerCloseContext);
}

/** Ignore Escape when an autocomplete listbox is open: it should close the
 * list, not the whole editor (Radix's capture-phase listener wins otherwise). */
function escapeGuard(e: KeyboardEvent | CustomEvent) {
  const target = (e as KeyboardEvent).target as HTMLElement | null;
  if (target?.getAttribute?.("aria-expanded") === "true") e.preventDefault();
}

export function EditDrawer({
  open,
  onClose,
  title,
  description,
  size = "md",
  dirty = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: DrawerSize;
  /** When true, closing asks for confirmation so edits aren't lost silently. */
  dirty?: boolean;
  children: ReactNode;
}) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  function requestClose() {
    if (dirty) setConfirmingDiscard(true);
    else onClose();
  }

  function handleOpenChange(next: boolean) {
    if (next) return;
    requestClose();
  }

  const body = (
    <DrawerCloseContext.Provider value={requestClose}>{children}</DrawerCloseContext.Provider>
  );

  const discardDialog = (
    <AlertDialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            Your edits in this panel haven't been saved.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setConfirmingDiscard(false)}>
            Keep editing
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              setConfirmingDiscard(false);
              onClose();
            }}
          >
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className={cn(
            "flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0",
            MODAL_SIZE_CLASS[size],
          )}
          onEscapeKeyDown={escapeGuard}
        >
          <DialogHeader className="border-b px-6 py-4 text-left">
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4">{body}</div>
          {discardDialog}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full max-w-full flex-col gap-0 overflow-y-auto p-0"
        onEscapeKeyDown={escapeGuard}
      >
        <SheetHeader className="border-b px-6 py-4 text-left">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="flex-1 px-6 py-4">{body}</div>
        {discardDialog}
      </SheetContent>
    </Sheet>
  );
}

/** Sticky footer row for editor forms: explicit Save / Cancel. Cancel goes
 * through the unsaved-changes guard automatically. */
export function DrawerFooter({
  onCancel,
  children,
}: {
  /** Override only when Cancel must do something beyond closing. */
  onCancel?: () => void;
  children: ReactNode;
}) {
  const requestClose = useDrawerClose();
  return (
    <div className="sticky bottom-0 -mx-6 mt-6 flex items-center justify-end gap-2 border-t bg-background px-6 py-3">
      <button
        type="button"
        onClick={onCancel ?? requestClose}
        className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
      >
        Cancel
      </button>
      {children}
    </div>
  );
}
