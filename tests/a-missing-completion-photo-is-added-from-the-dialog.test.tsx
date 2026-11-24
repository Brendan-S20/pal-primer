// @vitest-environment happy-dom
//
// #1012. The office's Complete asks "Complete without the required proof?"
// when the business requires a completion photo and the visit has none. The
// dialog used to offer only a reason: no way to add the photo, and the photo
// the drawer uploaded defaulted to Before, which does not count.
//
//   1. The dialog offers "Add completion photo" for a missing photo.
//   2. The photo is uploaded as kind "completion", then Complete is tried
//      again without a reason.
//   3. Cancel closes the dialog and ends Complete with nothing written.
//   4. A missing checklist item (no photo in the text) offers no photo button.
//   5. A photo queued offline does not complete the visit and says why.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  uploadPhoto: vi.fn(async (_f: File, _k: string) => ({ queued: false })),
}));
vi.mock("@/lib/offline/useOfflineVisitActions", () => ({
  useOfflineVisitActions: () => ({ uploadPhoto: h.uploadPhoto }),
}));

import { completeFromOffice, useOfficeCompleteOverride } from "@/components/OfficeCompleteOverride";

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  h.uploadPhoto.mockClear();
});

const NO_PHOTO = "This visit has no completion photo.";

function mount() {
  const api: { run?: (call: any) => Promise<boolean> } = {};
  function Harness() {
    const { askWhy, dialog } = useOfficeCompleteOverride();
    api.run = (call) => completeFromOffice(call, askWhy, undefined, "visit-1");
    return createElement("div", null, dialog);
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(Harness)));
  return api;
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

describe("the proof dialog", () => {
  it("adds a completion photo, then completes without asking why", async () => {
    const api = mount();
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, needsOverride: NO_PHOTO })
      .mockResolvedValueOnce({ ok: true });
    let result: boolean | undefined;
    act(() => {
      void api.run!(call).then((r) => (result = r));
    });
    await flush();
    expect(button("Add completion photo")).toBeTruthy();

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="completion-photo-input"]',
    )!;
    const file = new File(["x"], "p.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(h.uploadPhoto).toHaveBeenCalledWith(file, "completion");
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][0]).toBeUndefined();
    expect(result).toBe(true);
    expect(document.body.textContent).not.toContain("Complete without the required proof?");
  });

  it("closes on Cancel and writes nothing", async () => {
    const api = mount();
    const call = vi.fn().mockResolvedValue({ ok: false, needsOverride: NO_PHOTO });
    let result: boolean | undefined;
    act(() => {
      void api.run!(call).then((r) => (result = r));
    });
    await flush();
    expect(document.body.textContent).toContain("Complete without the required proof?");
    await act(async () => {
      button("Cancel")!.click();
    });
    await flush();
    expect(result).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Complete without the required proof?");
  });

  it("offers no photo button when a checklist item is what is missing", async () => {
    const api = mount();
    const call = vi
      .fn()
      .mockResolvedValue({ ok: false, needsOverride: "Required checklist item: Gate latched." });
    act(() => {
      void api.run!(call);
    });
    await flush();
    expect(button("Add completion photo")).toBeUndefined();
  });

  it("says a photo queued offline does not count yet and keeps the dialog", async () => {
    h.uploadPhoto.mockResolvedValueOnce({ queued: true });
    const api = mount();
    const call = vi.fn().mockResolvedValue({ ok: false, needsOverride: NO_PHOTO });
    act(() => {
      void api.run!(call);
    });
    await flush();
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="completion-photo-input"]',
    )!;
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "p.jpg")],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).toContain("will not count until then");
    expect(call).toHaveBeenCalledTimes(1);
  });
});
