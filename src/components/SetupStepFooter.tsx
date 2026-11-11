import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";

// ── /setup's sticky bar, and the step's own Save inside it (#771) ─────────
//
// The bar under every step (Back, and Skip for now or Next) is sticky to the
// bottom of the screen, so a step taller than a phone still has a way
// forward under the thumb. Step 1's "Save and continue" sat at the end of
// its form, just above that bar, so whenever the end of the form was near
// the bottom of the screen the bar was drawn over the button: at 1280 and on
// a phone the owner saw the top half of Save and tapped the bar instead.
// Any sticky bar covers what scrolls under it; the only layout in which the
// bar never covers Save is the one with Save IN the bar.
//
// So a step's primary action is written where it always was, inside its own
// form, wrapped in <SetupStepPrimary>, and drawn in the bar through a portal.
// It stays tied to its form with the `form` attribute, so Enter in a field
// and the button submit the same form. Off /setup (no bar), it draws in
// place, as before.
//
// Below `sm` the bar is two rows: Save the full width on top, Back and Skip
// under it. Three buttons do not fit one row at 360. That is layout keyed on
// width, which is what width is for; the 44px floor is the buttons' own
// `touch:` sizing.
//
// Office-only (owner, office manager), so English.

type Slot = {
  el: HTMLElement | null;
  setEl: (el: HTMLElement | null) => void;
  primaries: number;
  setPrimaries: (fn: (n: number) => number) => void;
};

const SlotContext = createContext<Slot | null>(null);

/** Wraps a step's panel and its bar, so the panel can draw into the bar. */
export function SetupFooterSlot({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [primaries, setPrimaries] = useState(0);
  return (
    <SlotContext.Provider value={{ el, setEl, primaries, setPrimaries }}>
      {children}
    </SlotContext.Provider>
  );
}

/** A step's primary action, drawn in the sticky bar when there is one. */
export function SetupStepPrimary({ children }: { children: ReactNode }) {
  const slot = useContext(SlotContext);
  const setPrimaries = slot?.setPrimaries;
  useEffect(() => {
    if (!setPrimaries) return;
    setPrimaries((n) => n + 1);
    return () => setPrimaries((n) => n - 1);
  }, [setPrimaries]);
  if (!slot) return <>{children}</>;
  // Until the bar has mounted there is nowhere to draw it; one frame.
  return slot.el ? createPortal(children, slot.el) : null;
}

export function SetupStepFooter({
  isFirst,
  isLast,
  done,
  onBack,
  onForward,
}: {
  isFirst: boolean;
  isLast: boolean;
  done: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  const slot = useContext(SlotContext);
  // With the step's own Save beside it, Next is not a second primary button.
  const hasPrimary = (slot?.primaries ?? 0) > 0;
  return (
    // Sticky to the bottom of the viewport while the step is. Below `md` the
    // office roles this page is for have the tab bar there, so it sits on top
    // of the bar rather than behind it. No z-index: it comes after the form in
    // the document, so it paints over it, and an address suggestion list
    // (which does set one) still paints over this.
    <div
      data-setup-footer
      className="sticky bottom-0 -mx-4 mt-5 flex flex-wrap items-center gap-2 rounded-b-lg border-t bg-card px-4 py-3 max-md:bottom-[calc(var(--tab-bar-h)+env(safe-area-inset-bottom))] md:-mx-5 md:px-5"
    >
      {!isFirst && (
        <Button variant="outline" onClick={onBack} data-setup-action="back">
          Back
        </Button>
      )}
      {done ? (
        <Button
          className="ms-auto"
          variant={hasPrimary ? "outline" : "default"}
          onClick={onForward}
          data-setup-action={isLast ? "done" : "next"}
        >
          {isLast ? "Done" : "Next"}
        </Button>
      ) : (
        <Button
          className="ms-auto"
          variant="ghost"
          onClick={onForward}
          data-setup-action={isLast ? "done" : "skip"}
        >
          {isLast ? "Skip and finish" : "Skip for now"}
        </Button>
      )}
      <div
        ref={slot?.setEl}
        data-setup-primary-slot
        className="flex empty:hidden max-sm:order-first max-sm:basis-full max-sm:*:w-full"
      />
    </div>
  );
}
