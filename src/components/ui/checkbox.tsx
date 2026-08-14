import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      // ── 16px box, 44px target ───────────────────────────────────────────
      //
      // The other controls take `max-md:min-h-11` and simply get taller. A
      // checkbox cannot: the 16px square IS the control, and a 44px one would
      // be a different component, not a bigger version of this one. The
      // working agreement anticipates exactly this — "a 16px glyph centred in
      // a 44px box, so nothing looks different and everything is hittable" —
      // and for a checkbox the 44px box has to be invisible.
      //
      // So an absolutely positioned `::before` extends the tappable area to
      // 44x44 centred on the square, on touch widths only. It is out of flow,
      // so nothing moves: the row is the same height, the tick is the same
      // size, and the only change is where a thumb has to land.
      //
      // The cost, stated rather than discovered later: the hit area reaches
      // about 14px past the square on every side, which is roughly 2px beyond
      // its own table cell and 1.5px into the rows above and below. In the
      // selection columns this actually lives in (`w-10` cells with `px-4`,
      // rows near 41px) that overlap is a sliver, and it is a far better
      // trade than a 16px target on a phone. Somewhere denser than that, it
      // would want checking by eye.
      "grid place-content-center peer relative h-4 w-4 shrink-0 rounded-sm border border-primary shadow cursor-pointer max-md:before:absolute max-md:before:left-1/2 max-md:before:top-1/2 max-md:before:h-11 max-md:before:w-11 max-md:before:-translate-x-1/2 max-md:before:-translate-y-1/2 max-md:before:content-[''] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn("grid place-content-center text-current")}>
      <Check className="h-4 w-4" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
