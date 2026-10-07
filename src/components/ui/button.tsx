import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// ── PRESSED ───────────────────────────────────────────────────────────────
//
// `active:scale-(--motion-press-scale)` is the press a finger can feel: 0.97
// for the length of the touch, back on release, on the motion tokens in
// styles.css (1, i.e. nothing, under reduced motion). `scale` rather than
// `transform` so it composes with any translate a caller adds, and it is a
// paint-only change, so nothing beside the button moves. iOS only applies
// :active to a page that listens for touchstart; __root.tsx adds that one
// passive listener.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium cursor-pointer transition-[color,background-color,border-color,box-shadow,scale] duration-(--motion-duration-fast) ease-(--motion-ease-standard) active:scale-(--motion-press-scale) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // ── THE 44px TOUCH FLOOR, IN THE ONE PLACE THAT REACHES EVERY BUTTON ──
      //
      // The working agreement says touch targets are at least 44px and means
      // the BUTTON, not the glyph. This component shipped `h-8` for `sm` and
      // `h-9 w-9` for `icon` — 32px and 36px — across roughly 375 call sites,
      // and the answer until now was an ad-hoc `touch:min-h-11` on whichever
      // six buttons somebody happened to look at. Six out of 375 is not a
      // policy, it is a record of which screens got opened on a phone.
      //
      // ── WHY max-md: AND NOT A BIGGER NUMBER ───────────────────────────────
      //
      // This is the thing that kept the fix parked: raising the heights
      // outright would relayout every dense office table on the desktop, which
      // is a design decision and not a bug fix. Scoping to touch means the
      // pointer layout is byte-for-byte what it was and a thumb still gets a
      // 44px target — the same split `ui/tabs.tsx` already makes, and for the
      // same reason. `ui/dialog.tsx` and `ui/sheet.tsx` set `h-11` at every
      // width instead, which is right for THEM: a close button is a 16px glyph
      // in a box, so the box can grow without moving anything.
      //
      // `min-h` rather than `h`: `min-height` beats `height` in the cascade
      // whatever order the utilities land in, so `h-8 touch:min-h-11` is 44px
      // on touch without depending on how Tailwind sorts its variants.
      //
      // The six hand-written escapes elsewhere are now redundant. They are
      // left alone deliberately — they are harmless, and each is pinned by a
      // test that names the screen it was found on.
      size: {
        default: "h-9 px-4 py-2 touch:min-h-11",
        // `touch:min-w-11` as well as the height, and the width is not
        // decoration. A QA sweep on 2026-08-23 measured `size="sm"` controls at
        // 39-41pt WIDE on two devices independently — the Invoices status
        // filter ("All", 39pt) and several icon-only buttons. The height floor
        // was added and the width one was not, so a short label or a bare glyph
        // produced a target that was legal in one axis and not the other.
        //
        // ── AND WHY THE WIDTH FLOOR CARRIES `touch:shrink-0` ─────────────────
        //
        // A flex item's `min-width` is `auto`, which means "no narrower than my
        // content". `min-w-11` REPLACES that with 44px. So on touch every sm
        // button beside a long description became free to shrink to 44px, and
        // its nowrap label ran out through its own border: "Add card" on the
        // client billing tab, "Add item" on Inventory clipped by the screen
        // edge, both on the owner's iPhone (2026-10-04). On a mouse the same
        // rows were fine, because there the automatic minimum still applied.
        // `shrink-0` puts the floor back: a button's label never wraps, so
        // there is nothing a button gains by shrinking, and the description
        // beside it wraps instead. tests/a-width-floor-is-not-a-shrink-floor
        // holds every other touch width floor in src/ to the same rule.
        sm: "h-8 rounded-md px-3 text-xs touch:min-h-11 touch:min-w-11 touch:shrink-0",
        lg: "h-10 rounded-md px-8 touch:min-h-11",
        icon: "h-9 w-9 touch:min-h-11 touch:min-w-11 touch:shrink-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
