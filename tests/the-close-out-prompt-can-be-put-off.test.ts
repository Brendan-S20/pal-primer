// The "Did you finish this visit?" prompt can be put off with its X or Escape.
//
// #638, Oct 31 production smoke as tech@demo.test: the dialog's X and Escape
// did nothing, because onOpenChange was `() => undefined`. The overlay sat over
// My Day, and the tech could not read the day or reach the account menu to
// sign out without answering.
//
// Closing now means the same as "Still working": the visit is deferred for
// this session and nothing is recorded on it. The three answers stay.
//
// There is no DOM test renderer in this repo, so the rule is pinned as a pure
// function plus a read of the component's source for the wiring.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deferredAfterOpenChange } from "@/lib/close-out-defer";

const SOURCE = readFileSync(resolve(__dirname, "../src/components/CloseOutOpenVisits.tsx"), "utf8");

describe("closing the prompt", () => {
  it("defers the visit for this load, like Still working", () => {
    expect(deferredAfterOpenChange(false, false, ["v1"], [])).toEqual(["v1"]);
    expect(deferredAfterOpenChange(false, false, ["v2"], ["v1"])).toEqual(["v1", "v2"]);
  });

  // #721: with several open visits, deferring only the one on screen swapped
  // the next one into the same open dialog, so X and Escape looked dead.
  it("defers every visit the prompt is holding, not only the one on screen", () => {
    expect(deferredAfterOpenChange(false, false, ["v1", "v2", "v3"], [])).toEqual([
      "v1",
      "v2",
      "v3",
    ]);
    expect(deferredAfterOpenChange(false, false, ["v2", "v3"], ["v1"])).toEqual(["v1", "v2", "v3"]);
  });

  it("does not defer twice", () => {
    const d = ["v1"];
    expect(deferredAfterOpenChange(false, false, ["v1"], d)).toBe(d);
  });

  it("does nothing on an open request", () => {
    const d: string[] = [];
    expect(deferredAfterOpenChange(true, false, ["v1"], d)).toBe(d);
  });

  it("does nothing while an answer is saving", () => {
    const d: string[] = [];
    expect(deferredAfterOpenChange(false, true, ["v1"], d)).toBe(d);
  });
});

describe("for this load, across remounts (#721)", () => {
  it("hands a remounted prompt the list it had, and starts a load empty", async () => {
    vi.resetModules();
    const fresh = await import("@/lib/close-out-defer");
    expect(fresh.deferredSoFar()).toEqual([]);
    fresh.rememberDeferred(["v1"]);
    expect(fresh.deferredSoFar()).toEqual(["v1"]);
  });

  it("is read when the prompt mounts and written when it changes", () => {
    expect(SOURCE).toMatch(/useState<string\[\]>\(deferredSoFar\)/);
    expect(SOURCE).toMatch(/rememberDeferred\(deferred\)/);
  });
});

describe("the wiring", () => {
  it("does not throw away the dialog's close request", () => {
    expect(SOURCE).not.toMatch(/onOpenChange=\{\s*\(\)\s*=>\s*undefined\s*\}/);
    expect(SOURCE).toMatch(
      /onOpenChange=\{\s*\(open\)\s*=>[\s\S]*?deferredAfterOpenChange\(\s*open,/,
    );
  });

  it("lets a tap outside put it off too (#721)", () => {
    expect(SOURCE).not.toMatch(/onInteractOutside=\{\s*\(e\)\s*=>\s*e\.preventDefault\(\)\s*\}/);
  });

  it("still offers all three answers", () => {
    for (const key of ["closeOut.yesCompleted", "closeOut.notCompleted", "closeOut.stillWorking"]) {
      expect(SOURCE).toContain(`t("${key}")`);
    }
  });
});
