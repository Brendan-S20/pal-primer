"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/80 duration-(--motion-duration-base) ease-(--motion-ease-standard) data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Let Radix focus the first field, the way it does by default.
     *
     *  For a dialog whose whole purpose is typing — the command palette — not
     *  focusing the input is the bug, not the fix. Everything else opts out;
     *  this opts back in, explicitly, at the one call site that needs it. */
    focusFirstField?: boolean;
  }
>(({ className, children, onOpenAutoFocus, focusFirstField, ...props }, ref) => {
  /**
   * ── WHY THIS DIALOG DOES NOT AUTOFOCUS A FIELD ──────────────────────────
   *
   * Radix moves focus to the first focusable child when a dialog opens. On iOS
   * that is not a neutral act: focusing a `<select>` makes WKWebView present
   * the full-height native picker. So "New invoice", whose first field is the
   * client `<select>`, opened with a 520pt system list already covering the
   * dialog — its own description cut off mid-sentence, 110 client names to
   * scroll before you could read what you were doing. QA reproduced it on both
   * an iPhone SE and an iPhone 16 Pro, from two entry points, every attempt.
   *
   * Fixed here rather than in that one dialog, because the trigger is "the
   * first focusable child happens to be a select" and nothing stops the next
   * dialog being built that way.
   *
   * Focus still lands INSIDE the dialog — on the panel itself, which Radix
   * gives `tabIndex={-1}`. That keeps the focus trap and the screen-reader
   * announcement; it just does not put a caret in a control the person has not
   * chosen yet. A dialog that genuinely wants a field focused can pass its own
   * `onOpenAutoFocus` and this defers to it.
   */
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  return (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={(node) => {
        panelRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) (ref as React.MutableRefObject<typeof node>).current = node;
      }}
      onOpenAutoFocus={(event) => {
        onOpenAutoFocus?.(event);
        if (event.defaultPrevented) return;
        // OPT-IN ESCAPE. Without this the change above had no way back, and it
        // broke the command palette: CommandDialog is built on this component,
        // so preventing autofocus meant ⌘K opened a palette you could not type
        // into. Found because the QA harness types into it — the product bug
        // and the test failure were the same bug.
        if (focusFirstField) return;
        event.preventDefault();
        panelRef.current?.focus();
      }}
      className={cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-(--motion-duration-base) ease-(--motion-ease-standard) data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg",
        className,
      )}
      {...props}
    >
      {children}
      {/* The button carried no size of its own, so it shrank to the icon: a
          16x16 target, on every dialog in the app, including the phone-only
          ones. The icon stays 16px — the BUTTON is 44, the minimum a thumb
          can reliably hit. Positioned at end-2/top-2 so the glyph lands
          within a few pixels of where it always has (the top-left corner in
          Arabic, which reads right to left). */}
      <DialogPrimitive.Close className="absolute end-2 top-2 flex h-11 w-11 items-center justify-center rounded-md opacity-70 ring-offset-background cursor-pointer transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4 shrink-0" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-start", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
