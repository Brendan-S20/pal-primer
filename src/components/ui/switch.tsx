import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      // ── 20px switch, 44px target ────────────────────────────────────────
      //
      // MEASURED 2026-08-19 at 360px: 20.0px. Same shape as the checkbox and
      // the radio — the track IS the control, and a 44px-tall switch would be
      // a different component rather than a bigger version of this one.
      //
      // So this borrows verbatim what ui/checkbox.tsx already does and
      // documents: an absolutely positioned `::before` extending the tappable
      // area to 44x44 centred on the track, on touch widths only, out of flow
      // so nothing moves. `relative` is what makes the switch the containing
      // block for it — without that the pseudo-element positions against some
      // ancestor and the hit area lands somewhere else entirely.
      //
      // tests/viewports/rules.ts credits this, but only because it checks
      // `pointer-events` too; a hit area that does not take the tap is not one.
      "peer relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors touch:before:absolute touch:before:left-1/2 touch:before:top-1/2 touch:before:h-11 touch:before:w-11 touch:before:-translate-x-1/2 touch:before:-translate-y-1/2 touch:before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
