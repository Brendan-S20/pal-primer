// Right-side editing drawer for the client detail page (spec: viewing and
// editing are separate; nothing edits inline). Three widths; on mobile every
// size becomes a full-screen sheet. Closing with unsaved changes asks first.
import { type ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const SIZE_CLASS: Record<DrawerSize, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-xl",
  lg: "sm:max-w-3xl",
};

export type DrawerSize = "sm" | "md" | "lg";

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
  function handleOpenChange(next: boolean) {
    if (next) return;
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className={cn(
          "flex w-full max-w-full flex-col gap-0 overflow-y-auto p-0",
          SIZE_CLASS[size],
        )}
      >
        <SheetHeader className="border-b px-6 py-4 text-left">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="flex-1 px-6 py-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/** Sticky footer row for drawer forms: explicit Save / Cancel. */
export function DrawerFooter({
  onCancel,
  children,
}: {
  onCancel?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="sticky bottom-0 -mx-6 mt-6 flex items-center justify-end gap-2 border-t bg-background px-6 py-3">
      {onCancel ? (
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border px-4 py-2 text-sm hover:bg-muted"
        >
          Cancel
        </button>
      ) : null}
      {children}
    </div>
  );
}
