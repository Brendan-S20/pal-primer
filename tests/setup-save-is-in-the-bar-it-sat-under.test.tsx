// @vitest-environment happy-dom
//
// #771: /setup's sticky bar (Back, Skip for now or Next) was drawn over step
// 1's "Save and continue" whenever the end of the form was near the bottom of
// the screen, at 1280 and on a phone. Any sticky bar covers what scrolls
// under it, so Save is now drawn IN the bar (SetupStepPrimary), still the
// submit of its own form through the `form` attribute.
//
// The geometry, at 360 / 402 / 768 / 1280 with touch on, is
// tests/viewports/setup-save-is-never-under-the-bar.spec.ts. This is the
// wiring: where the button lands, that it still submits step 1's form, and
// that it draws in place anywhere there is no bar.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SetupFooterSlot, SetupStepFooter, SetupStepPrimary } from "@/components/SetupStepFooter";
import { BusinessSaveButton, SETUP_BUSINESS_FORM_ID } from "@/components/SetupBusinessSave";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const loaded = { isPending: false, isSuccess: true, isError: false };

let host: HTMLElement;
let root: Root | null = null;

async function render(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

function Step({ done, onSubmit }: { done: boolean; onSubmit: () => void }) {
  return (
    <SetupFooterSlot>
      <form
        id={SETUP_BUSINESS_FORM_ID}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <input name="x" />
        <BusinessSaveButton saving={false} dispatch={loaded} />
      </form>
      <SetupStepFooter
        isFirst={false}
        isLast={false}
        done={done}
        onBack={() => {}}
        onForward={() => {}}
      />
    </SetupFooterSlot>
  );
}

describe("step 1's Save sits in the sticky bar, not under it", () => {
  it("is drawn inside the bar, beside Back and Skip, and nowhere in the form", async () => {
    await render(<Step done={false} onSubmit={() => {}} />);
    const bar = host.querySelector("[data-setup-footer]")!;
    const save = host.querySelectorAll('[data-setup-action="save"]');
    expect(save).toHaveLength(1);
    expect(bar.contains(save[0])).toBe(true);
    expect(host.querySelector("form")!.contains(save[0])).toBe(false);
    expect(bar.querySelector('[data-setup-action="back"]')).not.toBeNull();
    expect(bar.querySelector('[data-setup-action="skip"]')).not.toBeNull();
    expect(save[0].textContent).toBe("Save and continue");
  });

  it("still submits step 1's form, from outside it", async () => {
    const submitted = vi.fn();
    await render(<Step done={false} onSubmit={submitted} />);
    const save = host.querySelector<HTMLButtonElement>('[data-setup-action="save"]')!;
    expect(save.getAttribute("form")).toBe(SETUP_BUSINESS_FORM_ID);
    expect(save.type).toBe("submit");
    await act(async () => save.click());
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it("leaves one primary button: Next steps back to outline beside Save", async () => {
    await render(<Step done onSubmit={() => {}} />);
    const next = host.querySelector('[data-setup-action="next"]')!;
    expect(next.className).toMatch(/border/);
  });

  it("is the full width on its own row below sm, so three buttons never squeeze one row at 360", async () => {
    await render(<Step done={false} onSubmit={() => {}} />);
    const slot = host.querySelector("[data-setup-primary-slot]")!;
    expect(slot.className).toMatch(/max-sm:order-first/);
    expect(slot.className).toMatch(/max-sm:basis-full/);
    expect(slot.className).toMatch(/max-sm:\*:w-full/);
  });

  it("draws in place where there is no bar", async () => {
    await render(
      <form>
        <SetupStepPrimary>
          <button type="submit" data-alone>
            Save
          </button>
        </SetupStepPrimary>
      </form>,
    );
    expect(host.querySelector("form")!.querySelector("[data-alone]")).not.toBeNull();
  });
});

describe("the route draws the bar once, around every step", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "src/routes/_authenticated/setup.tsx"),
    "utf8",
  );

  it("wraps the step panel and the bar in one slot", () => {
    expect(src).toMatch(
      /<SetupFooterSlot>\s*<div className="mt-4">\s*<StepPanel[^>]*\/>\s*<\/div>\s*<SetupStepFooter/,
    );
  });

  it("gives step 1's form the id its Save submits", () => {
    expect(src).toMatch(/<form\s+id=\{SETUP_BUSINESS_FORM_ID\}/);
  });
});
