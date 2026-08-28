import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

/**
 * Is there more tab bar off the side, and which side?
 *
 * ── WHY THIS IS NEEDED ──────────────────────────────────────────────────
 *
 * The bar below `md` scrolls sideways with `no-scrollbar`, which hides the one
 * affordance a scroller normally has. Measured on a real phone against a real
 * client: ELEVEN tabs, five visible, and nothing on screen suggesting the other
 * six exist. Billing looks like the last tab. It is the fifth of eleven.
 *
 * A fade cannot be unconditional -- over a bar that fits, it dims the last tab
 * for no reason and makes a complete row look truncated. So it is measured, and
 * re-measured on scroll and on resize, and the edges are marked only when there
 * is genuinely something past them.
 */
function useEdgeOverflow(ref: React.RefObject<HTMLElement | null>) {
  const [edges, setEdges] = React.useState({ start: false, end: false });

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // 1px of tolerance: sub-pixel layout leaves scrollWidth a hair over
      // clientWidth on bars that actually fit, and a permanent fade on a
      // complete row is the exact thing this is trying not to do.
      const max = el.scrollWidth - el.clientWidth;
      setEdges({ start: el.scrollLeft > 1, end: max > 1 && el.scrollLeft < max - 1 });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The tabs themselves can change width after fonts load, which changes the
    // answer without either a scroll or a resize of the container.
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [ref]);

  return edges;
}

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => {
  const inner = React.useRef<HTMLDivElement | null>(null);
  const edges = useEdgeOverflow(inner);
  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      inner.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [ref],
  );

  return (
  <TabsPrimitive.List
    ref={setRefs}
    data-overflow-start={edges.start ? "" : undefined}
    data-overflow-end={edges.end ? "" : undefined}
    className={cn(
      // Below `md` a tab bar scrolls sideways instead of wrapping. Seven tabs
      // on /analytics and nine on a client wrapped into two or three rows of
      // pills on a phone — a shape that reads as a paragraph of buttons and
      // moves every tab whenever the active one changes width.
      //
      // /clients/$id already carried its own copy of exactly these classes.
      // Putting them on the primitive means the other tab bars get the same
      // behaviour without anyone having to remember, which is the whole reason
      // this is a shared component.
      "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
      "no-scrollbar max-md:h-auto max-md:w-full max-md:justify-start max-md:overflow-x-auto",
      // The affordance the hidden scrollbar took away. A soft mask on whichever
      // edge has content past it, so a bar that continues LOOKS like it
      // continues. Only below `md`, where the bar scrolls at all.
      "max-md:data-[overflow-end]:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]",
      "max-md:data-[overflow-start]:[mask-image:linear-gradient(to_left,black_calc(100%-2rem),transparent)]",
      "max-md:data-[overflow-start]:data-[overflow-end]:[mask-image:linear-gradient(to_right,transparent,black_2rem,black_calc(100%-2rem),transparent)]",
      className,
    )}
    {...props}
  />
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background cursor-pointer transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow",
      // 44px on touch. `py-1` around a 20px line box is 28px, which is a
      // target you aim at rather than one you hit. `shrink-0` keeps the
      // labels legible inside the scroller above rather than letting seven
      // tabs squeeze themselves into the width of one.
      "touch:min-h-11 max-md:shrink-0",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
