// Right-side editing drawer for the client detail page (spec: viewing and
// editing are separate; nothing edits inline). Three widths; on mobile every
// size becomes a full-screen sheet. Closing with unsaved changes asks first
// via a styled modal (QA follow-up 1.4: no native confirm dialogs anywhere).
import { createContext, useContext, useState, type ReactNode } from "react";
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
import { cn } from "@/lib/utils";

const SIZE_CLASS: Record<DrawerSize, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-xl",
  lg: "sm:max-w-3xl",
};

export type DrawerSize = "sm" | "md" | "lg";

// Children (DrawerFooter's Cancel, custom buttons) close through this so the
// unsaved-changes guard applies everywhere, not just overlay/Escape.
const DrawerCloseContext = createContext<() => void>(() => {});
export function useDrawerClose() {
  return useContext(DrawerCloseContext);
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
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  function requestClose() {
    if (dirty) setConfirmingDiscard(true);
    else onClose();
  }

  function handleOpenChange(next: boolean) {
    if (next) return;
    requestClose();
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          "flex w-full max-w-full flex-col gap-0 overflow-y-auto p-0",
          SIZE_CLASS[size],
        )}
        onEscapeKeyDown={(e) => {
          // Escape while an autocomplete listbox is open should close the
          // list, not the drawer (Radix's document-level capture listener
          // would otherwise win and trigger the discard-changes prompt).
          const target = e.target as HTMLElement | null;
          if (target?.getAttribute?.("aria-expanded") === "true") e.preventDefault();
        }}
      >
        <SheetHeader className="border-b px-6 py-4 text-left">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="flex-1 px-6 py-4">
          <DrawerCloseContext.Provider value={requestClose}>{children}</DrawerCloseContext.Provider>
        </div>

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
      </SheetContent>
    </Sheet>
  );
}

/** Sticky footer row for drawer forms: explicit Save / Cancel. Cancel goes
 * through the drawer's unsaved-changes guard automatically. */
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
