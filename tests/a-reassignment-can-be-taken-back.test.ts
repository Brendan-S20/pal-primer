// Picking a tech in the visit drawer used to apply on change, with no undo,
// and told both technicians at once (QA row 16). The change is now held for
// a few seconds (src/lib/undo-window.ts) and only then sent, so Undo cancels
// it before any notification exists.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdForUndo, UNDO_WINDOW_MS } from "@/lib/undo-window";

describe("holdForUndo", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends nothing inside the window, then sends once", async () => {
    const send = vi.fn(async () => {});
    const held = holdForUndo(send);
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(held.done).resolves.toBe(true);
    held.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("undo inside the window means the call is never made", async () => {
    const send = vi.fn(async () => {});
    const held = holdForUndo(send);
    expect(held.undo()).toBe(true);
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    expect(send).not.toHaveBeenCalled();
    await expect(held.done).resolves.toBe(false);
  });

  it("undo after the change was sent says so", () => {
    const send = vi.fn(async () => {});
    const held = holdForUndo(send);
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(held.undo()).toBe(false);
  });

  it("a failed send is reported and settles false", async () => {
    const onError = vi.fn();
    const held = holdForUndo(async () => Promise.reject(new Error("refused")), { onError });
    held.flush();
    await expect(held.done).resolves.toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("the visit drawer's reassign select", () => {
  const src = readFileSync(join(process.cwd(), "src/components/VisitDetailDrawer.tsx"), "utf8");
  const at = src.indexOf('id="reassign"');
  const select = src.slice(at, src.indexOf("</select>", at));

  it("meets the touch floor", () => {
    expect(select).toMatch(/touch:min-h-11/);
  });

  it("holds the reassignment for Undo instead of calling the server on change", () => {
    expect(select).not.toMatch(/reassignMut\.mutate/);
    expect(src).toMatch(/holdForUndo\(/);
    expect(src).toMatch(/label:\s*"Undo"/);
  });
});
