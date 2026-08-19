import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Circle } from "lucide-react";

import { cn } from "@/lib/utils";

const RadioGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => {
  return <RadioGroupPrimitive.Root className={cn("grid gap-2", className)} {...props} ref={ref} />;
});
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

const RadioGroupItem = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => {
  return (
    <RadioGroupPrimitive.Item
      ref={ref}
      className={cn(
        "aspect-square h-4 w-4 rounded-full border border-primary text-primary shadow cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
        <Circle className="h-3.5 w-3.5 fill-primary" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
});
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

/**
 * A segmented single-choice control.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * `RadioGroupItem` renders a 16px dot, which is what a radio button looks
 * like and is 28px short of the touch floor. It cannot be fixed by growing
 * it: the border and the rounded shape are on the element being measured, so
 * padding and height both grow the visible circle rather than the hit area.
 * A radio's real target is its `<label>` — true, and invisible to anything
 * that measures the control.
 *
 * So for a short, mutually exclusive choice the answer is not a bigger dot,
 * it is a different control. This is that control, and it is built on the
 * SAME Radix primitive rather than on plain buttons, which matters more than
 * it looks. Hand-rolled segmented buttons out of `<button>` elements are a
 * group of independent controls that merely look related; a screen reader is
 * told nothing about the choice, and every option is its own tab stop.
 *
 * Measured in Chromium after the swap, rather than assumed: the group still
 * renders `role="radiogroup"`, each segment still renders `role="radio"` with
 * `aria-checked` tracking the value, and the roving tabindex still puts the
 * whole group behind ONE tab stop (`tabindex` 0 on the active option, -1 on
 * the rest). Arrow-key movement is Radix's own and is not re-verified here —
 * driving it from a test by forcing focus gave inconsistent answers, because
 * the primitive tracks its own idea of the last-focused option, and a shaky
 * measurement is worse than none.
 *
 * Use it when the options are few and their labels are short. Keep
 * `RadioGroupItem` for a vertical list of longer options, where a dot beside
 * wrapping text is still the right shape — there the label is a large target
 * in its own right.
 */
const RadioGroupSegment = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      // `min-h-11` and not `h-11`: a long label that wraps must make the
      // segment taller rather than overflow it.
      "inline-flex min-h-11 flex-1 items-center justify-center rounded-md border px-3 py-2 text-center text-sm font-medium transition-colors",
      "cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      "data-[state=unchecked]:bg-background data-[state=unchecked]:text-muted-foreground",
      "hover:data-[state=unchecked]:text-foreground",
      "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    {children}
  </RadioGroupPrimitive.Item>
));
RadioGroupSegment.displayName = "RadioGroupSegment";

export { RadioGroup, RadioGroupItem, RadioGroupSegment };
