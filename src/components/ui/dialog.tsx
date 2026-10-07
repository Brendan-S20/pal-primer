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
      "fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

// ── THE STATUS BAR AND THE HOME INDICATOR ARE PART OF THE SCREEN ──────────
//
// The same fault ui/sheet.tsx fixed for sheets (see the note on its
// sheetVariants), in the shape a centred panel has it. Inside the iOS app the
// WebView runs edge to edge (`viewport-fit=cover`, see __root.tsx), so the
// screen a dialog is centred on includes the ~62pt strip under the clock and
// the Dynamic Island, and the 34pt one over the home indicator. A dialog that
// was capped at `max-h-[90dvh]` and centred on the whole screen put its top
// edge 44px down on an 874pt iPhone: inside the status bar, the title under
// the clock and the close X under the island. Eight callers each wrote their
// own 90 or 92dvh cap; none of them could have known about the insets.
//
// So the cap and the centring are decided here, once:
//   - the panel is never taller than the screen minus both insets minus a
//     1rem margin above and below;
//   - it is centred on the SAFE region, not the screen: its centre sits half
//     the difference between the two insets below the screen's centre, so a
//     panel at the cap starts exactly 1rem below the status bar and ends 1rem
//     above the home indicator;
//   - anything taller than that scrolls inside the panel.
//
// env() is 0 on the web, where the hosted viewport does not opt into `cover`,
// so there the cap is the screen minus 2rem and the centre is the centre.
//
// A caller that manages its own scrolling (a fixed header over a scrolling
// body, as client-detail/EditDrawer does) passes `overflow-hidden` and
// tailwind-merge drops the default. A caller that passes its own `max-h-*`
// REPLACES this cap rather than adding to it, so a caller cap must be one
// that is smaller on every screen (85vh is, on every Apple size), or a
// `min()` with this one. `h-dvh` is the way to ask for the full safe height:
// the cap clamps it. tests/viewports/what-the-iphone-showed.spec.ts reads
// these rules out of the stylesheet, because Chromium's insets are 0 too.
const DIALOG_SAFE_FRAME =
  "top-[calc(50%_+_(env(safe-area-inset-top)_-_env(safe-area-inset-bottom))_/_2)] max-h-[calc(100dvh_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom)_-_2rem)] overflow-y-auto overscroll-contain";

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
        "fixed left-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg",
        DIALOG_SAFE_FRAME,
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
  DIALOG_SAFE_FRAME,
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
