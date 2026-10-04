"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  gestureAxis,
  shouldDismissSheet,
  touchCanStartVerticalGesture,
} from "@/lib/motion/gestures";

const Sheet = SheetPrimitive.Root;

const SheetTrigger = SheetPrimitive.Trigger;

const SheetClose = SheetPrimitive.Close;

const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      "fixed inset-0 z-50 bg-black/80 duration-(--motion-duration-base) ease-(--motion-ease-standard) data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

// ── THE STATUS BAR AND THE HOME INDICATOR ARE PART OF THE SCREEN ──────────
//
// Inside the iOS app the WebView runs edge to edge (`viewport-fit=cover`, see
// __root.tsx), so a sheet that is `inset-y-0` starts at the PHYSICAL top of
// the phone, under the clock and the battery. The owner's iPhone 17 Pro showed
// it on every full-height sheet: "Edit service" overprinted by "12:05", the X
// drawn through the battery glyph. VisitDetailDrawer and FranchiseLocationDrawer
// had each fixed it for themselves; every other sheet had not.
//
// So each side that touches an edge of the screen pads by that edge's inset,
// on top of the 1.5rem it always had. env() is 0 on the web, where the hosted
// viewport does not opt into `cover`, so nothing hosted moves. A sheet that
// strips its padding (`p-0`) takes the inset over with it, and has to put it
// back on whatever it draws at the top. tests/a-sheet-is-not-under-the-clock
// checks that it does.
const sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-(--motion-ease-standard) data-[state=closed]:duration-(--motion-duration-base) data-[state=open]:duration-(--motion-duration-slow) data-[state=open]:animate-in data-[state=closed]:animate-out",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b pt-[calc(1.5rem+env(safe-area-inset-top))] data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 border-t pb-[calc(1.5rem+env(safe-area-inset-bottom))] data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r pt-[calc(1.5rem+env(safe-area-inset-top))] pb-[calc(1.5rem+env(safe-area-inset-bottom))] data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l pt-[calc(1.5rem+env(safe-area-inset-top))] pb-[calc(1.5rem+env(safe-area-inset-bottom))] data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
      },
    },
    defaultVariants: {
      side: "right",
    },
  },
);

interface SheetContentProps
  extends
    React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

/**
 * SWIPE DOWN TO DISMISS, on a bottom sheet.
 *
 * The gesture every phone user tries first on a sheet that came up from the
 * bottom. The sheet follows the thumb; let go a third of the way down, or
 * flick it, and it closes through its own Close button (so Radix runs the
 * same close path, focus return and exit animation as a tap on the X, which
 * stays where it was: the gesture is never the only way). Short of that it
 * springs back.
 *
 * It only takes a drag that is more down than sideways and that starts where
 * nothing inside the sheet is scrolled: a list scrolled halfway down scrolls
 * up first, as it should, and only a drag from its top moves the sheet.
 */
function useSwipeToDismiss(
  el: HTMLDivElement | null,
  closeRef: React.RefObject<HTMLButtonElement | null>,
) {
  React.useEffect(() => {
    if (!el) return;
    let tracking = false;
    let owned = false;
    let startX = 0;
    let startY = 0;
    let startedAt = 0;
    let dy = 0;

    const onStart = (e: TouchEvent) => {
      tracking = false;
      owned = false;
      if (e.touches.length !== 1) return;
      if (!touchCanStartVerticalGesture(e.target, el)) return;
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startedAt = performance.now();
      dy = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dx = e.touches[0].clientX - startX;
      dy = e.touches[0].clientY - startY;
      if (!owned) {
        const axis = gestureAxis(dx, dy);
        if (axis === "undecided") return;
        if (axis === "horizontal" || dy <= 0) {
          tracking = false;
          return;
        }
        owned = true;
        el.style.transition = "none";
      }
      if (e.cancelable) e.preventDefault();
      el.style.transform = `translateY(${Math.max(0, dy)}px)`;
    };
    const springBack = () => {
      el.style.transition = "transform var(--motion-duration-base) var(--motion-ease-standard)";
      el.style.transform = "";
    };
    const onEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (!owned) return;
      owned = false;
      if (shouldDismissSheet(dy, performance.now() - startedAt, el.offsetHeight)) {
        // The exit animation starts from wherever the thumb left the sheet.
        el.style.transition = "";
        closeRef.current?.click();
      } else {
        springBack();
      }
    };
    const onCancel = () => {
      if (owned) springBack();
      tracking = false;
      owned = false;
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
    };
  }, [el, closeRef]);
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, ...props }, ref) => {
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  // State, not a ref: the content mounts after this component first renders
  // (Radix Presence), and the gesture has to attach on the render where the
  // node exists.
  const [node, setNode] = React.useState<HTMLDivElement | null>(null);
  const setRefs = React.useCallback(
    (el: HTMLDivElement | null) => {
      setNode(el);
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  useSwipeToDismiss(side === "bottom" ? node : null, closeRef);
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={setRefs}
        data-side={side}
        className={cn("group/sheet", sheetVariants({ side }), className)}
        {...props}
      >
        {/* The grab handle a bottom sheet is dragged by. Decoration: the whole
          sheet takes the drag, and the X still closes it. */}
        {side === "bottom" && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-2 mx-auto h-1.5 w-10 rounded-full bg-muted-foreground/30"
          />
        )}
        {/* 44px hit area around a 16px glyph — see the note in dialog.tsx. This
          one matters more: sheets are the phone layout.
          Clear of the status bar on every sheet that reaches the top of the
          screen (see the note on sheetVariants); a bottom sheet's top edge is
          nowhere near it, so it keeps its 0.5rem. */}
        <SheetPrimitive.Close
          ref={closeRef}
          className="absolute end-2 top-[calc(0.5rem+env(safe-area-inset-top))] group-data-[side=bottom]/sheet:top-2 flex h-11 w-11 items-center justify-center rounded-md opacity-70 ring-offset-background cursor-pointer transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary"
        >
          <X className="h-4 w-4 shrink-0" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
        {children}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
});
SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-2 text-center sm:text-start", className)} {...props} />
);
SheetHeader.displayName = "SheetHeader";

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props}
  />
);
SheetFooter.displayName = "SheetFooter";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-foreground", className)}
    {...props}
  />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
