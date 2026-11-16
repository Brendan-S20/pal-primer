// @vitest-environment happy-dom
//
// #946 follow-ups, from HoundStack Product's review of #950. The geometry, at
// 390 and 1440 in a browser, is
// tests/viewports/setup-step-2-is-never-under-the-bar.spec.ts. This is the
// logic under it:
//
//   1. After a refused save, picking Off left "Choose whether new clients pay
//      for a first cleanup." on screen. Step 2's refusal is now
//      serviceAreaStepProblem, read live from the form once a press has been
//      refused, as step 1's has been since #942: fixing the choice is what
//      takes it away.
//   2. The sticky bar covered fields at 390 without the browser knowing, so a
//      focused field could sit behind it. The bar now sets what it covers as
//      the page's scroll-padding-bottom while it is mounted.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SERVICE_AREA_STEP_MESSAGES, serviceAreaStepProblem } from "@/lib/setup-area-problem";
import { SetupFooterSlot, SetupStepFooter } from "@/components/SetupStepFooter";
import { SETUP_BAR_CLEARANCE_PX, setupBarScrollPadding } from "@/lib/setup-bar-scroll-padding";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETUP = readFileSync(
  join(import.meta.dirname, "..", "src/routes/_authenticated/setup.tsx"),
  "utf8",
);
const panel = SETUP.slice(
  SETUP.indexOf("function ServiceAreaPanel("),
  SETUP.indexOf("function ClientsPanel("),
);

const ready = {
  price: "20",
  zip: "60611",
  pin: { lat: 41.96, lng: -87.7 },
  tiered: false,
  firstCleanup: null,
  firstCleanupPrice: "",
  schedulesOk: true,
} as const;

describe("step 2's refusal is read live from the form", () => {
  it("names the unchosen first cleanup, and nothing once Off is picked", () => {
    expect(serviceAreaStepProblem(ready)).toEqual({
      field: "firstCleanup",
      message: SERVICE_AREA_STEP_MESSAGES.firstCleanup,
    });
    expect(serviceAreaStepProblem({ ...ready, firstCleanup: "off" })).toBeNull();
  });

  it("moves on to the flat price when Flat is picked with none, and clears once typed", () => {
    expect(serviceAreaStepProblem({ ...ready, firstCleanup: "flat" })?.message).toBe(
      SERVICE_AREA_STEP_MESSAGES.firstCleanupPrice,
    );
    expect(
      serviceAreaStepProblem({ ...ready, firstCleanup: "flat", firstCleanupPrice: "60" }),
    ).toBeNull();
  });

  it("keeps the order the checks always ran in: price, centre, first cleanup, schedules", () => {
    const all = { ...ready, price: "", zip: "12", pin: null, schedulesOk: false };
    expect(serviceAreaStepProblem(all)?.field).toBe("price");
    expect(serviceAreaStepProblem({ ...all, price: "20" })?.field).toBe("zip");
    expect(serviceAreaStepProblem({ ...all, price: "20", zip: "60611" })?.field).toBe(
      "firstCleanup",
    );
    expect(
      serviceAreaStepProblem({ ...all, price: "20", zip: "60611", firstCleanup: "off" })?.field,
    ).toBe("schedule");
  });

  it("does not ask about a first cleanup that is tiered on Zones", () => {
    expect(serviceAreaStepProblem({ ...ready, tiered: true })).toBeNull();
  });

  it("is what the panel shows once refused, with a server failure kept as before", () => {
    expect(panel).toMatch(/const problem = serviceAreaStepProblem\(/);
    expect(panel).toMatch(/const shownProblem = pressed > 0 \? problem : null;/);
    expect(panel).toMatch(/const message = shownProblem\?\.message \?\? failure;/);
    expect(panel).toMatch(/onFailed: setFailure/);
    // Not written once into state on the press: that is what left it stale.
    expect(panel).not.toMatch(/setFailure\(message\)/);
    expect(panel).not.toMatch(/\brefuse\(/);
  });

  it("takes the refusal's toast away with it, and leaves a server failure's toast alone", () => {
    // One stable id, raised only by a refusal...
    expect(panel).toMatch(/toast\.error\(problem\.message, \{ id: SETUP_AREA_REFUSAL_TOAST \}\)/);
    expect(panel.match(/toast\.error\(/g)).toHaveLength(1);
    // ...and dismissed once the problem it named is no longer the problem.
    expect(panel).toMatch(
      /toastedProblem\.current !== problemMessage\)[\s\S]{0,80}toast\.dismiss\(SETUP_AREA_REFUSAL_TOAST\)/,
    );
    expect(panel).toMatch(/\}, \[problemMessage\]\);/);
    // Server failures go through stepSave's own toast, which has no such id.
    expect(panel).toMatch(/onFailed: setFailure/);
  });
});

describe("the sticky bar tells the browser what it covers", () => {
  it("is the bar's height, plus the tab bar it sits on, plus clearance", () => {
    // 390: two rows (121px) over the 56px tab bar.
    expect(setupBarScrollPadding(121, "56px")).toBe(121 + 56 + SETUP_BAR_CLEARANCE_PX);
    // md and up: no tab bar, so the bar's own height.
    expect(setupBarScrollPadding(69, "0px")).toBe(69 + SETUP_BAR_CLEARANCE_PX);
    // An offset the browser could not resolve is not a reason to cover a field.
    expect(setupBarScrollPadding(69, "auto")).toBe(69 + SETUP_BAR_CLEARANCE_PX);
  });

  let host: HTMLElement;
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
  });

  it("is set on the page while the bar is mounted, and taken away with it", async () => {
    const html = document.documentElement;
    expect(html.style.scrollPaddingBottom).toBe("");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <SetupFooterSlot>
          <SetupStepFooter
            isFirst={false}
            isLast={false}
            done={false}
            onBack={() => {}}
            onForward={() => {}}
          />
        </SetupFooterSlot>,
      ),
    );
    expect(html.style.scrollPaddingBottom).toMatch(/^\d+px$/);
    act(() => root!.unmount());
    root = null;
    expect(html.style.scrollPaddingBottom).toBe("");
  });
});
