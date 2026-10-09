// Start leads straight into the completion photo, and the photo finishes the
// visit.
//
// The owner, after the 2026-10-08 TestFlight build. Where the business
// requires a completion photo: Start, the camera opens by itself, the photo
// is saved, the checklist comes up if there is one, and the visit completes.
// Cancel the camera and the visit stays started, with "Take photo to
// complete" on the card. Where no photo is required, Start does not open the
// camera and Complete stays a button. Offline, each step is queued in order.
//
// src/lib/start-photo-complete.ts is the sequence, with the steps passed in;
// this drives every branch of it, then checks My Day wires the real steps.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterPhoto,
  checklistReady,
  photoThenComplete,
  startOpensCamera,
  startThenPhotoThenComplete,
  type PhotoToCompleteSteps,
} from "@/lib/start-photo-complete";
import type { ChecklistItem } from "@/lib/visit-checklist";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const photo = new File([new Uint8Array([1, 2, 3])], "p.jpg", { type: "image/jpeg" });
const LIST: ChecklistItem[] = [
  { id: "gate", label: "Gate latched", required: true },
  { id: "bowl", label: "Water bowl filled", required: false },
];

function steps(over: Partial<PhotoToCompleteSteps> = {}, queued = false) {
  const log: string[] = [];
  const s: PhotoToCompleteSteps = {
    capture: vi.fn(async () => {
      log.push("capture");
      return photo;
    }),
    upload: vi.fn(async () => {
      log.push("upload");
      return { queued };
    }),
    checklist: [],
    askChecklist: vi.fn(async () => {
      log.push("checklist");
      return ["gate"];
    }),
    complete: vi.fn(async (ids?: string[]) => {
      log.push(`complete${ids ? `:${ids.join(",")}` : ""}`);
      return { queued };
    }),
    ...over,
  };
  return { s, log };
}

describe("does Start open the camera", () => {
  it.each([
    [
      "photo required, none yet",
      { requireCompletionPhoto: true, photoOnFile: false, canPerform: true },
      true,
    ],
    [
      "photo not required",
      { requireCompletionPhoto: false, photoOnFile: false, canPerform: true },
      false,
    ],
    [
      "a photo already on file (or queued)",
      { requireCompletionPhoto: true, photoOnFile: true, canPerform: true },
      false,
    ],
    [
      "an office preview, or a dispatcher",
      { requireCompletionPhoto: true, photoOnFile: false, canPerform: false },
      false,
    ],
  ])("%s", (_why, opts, want) => {
    expect(startOpensCamera(opts)).toBe(want);
  });
});

describe("Start, photo, Complete", () => {
  it("photo required, no checklist: start, camera, upload, complete, in that order", async () => {
    const { s, log } = steps();
    const start = vi.fn(async () => {
      log.push("start");
      return { queued: false };
    });
    expect(await startThenPhotoThenComplete(start, true, s)).toBe("completed");
    expect(log).toEqual(["start", "capture", "upload", "complete"]);
  });

  it("photo not required: Start starts and nothing else happens", async () => {
    const { s, log } = steps();
    const start = vi.fn(async () => {
      log.push("start");
      return { queued: false };
    });
    expect(await startThenPhotoThenComplete(start, false, s)).toBe("started");
    expect(log).toEqual(["start"]);
    expect(s.complete).not.toHaveBeenCalled();
  });

  it("a checklist comes after the photo and before Complete, with the ticks it got", async () => {
    const { s, log } = steps({ checklist: LIST });
    expect(await photoThenComplete(s)).toBe("completed");
    expect(log).toEqual(["capture", "upload", "checklist", "complete:gate"]);
  });

  it("a checklist put away leaves the visit started with its photo, and Complete a button", async () => {
    const { s, log } = steps({ checklist: LIST, askChecklist: vi.fn(async () => null) });
    expect(await photoThenComplete(s)).toBe("awaiting_checklist");
    expect(log).toEqual(["capture", "upload"]);
    expect(s.complete).not.toHaveBeenCalled();
  });

  it("a checklist answered without a required item does not complete", async () => {
    const { s } = steps({ checklist: LIST, askChecklist: vi.fn(async () => ["bowl"]) });
    expect(await photoThenComplete(s)).toBe("awaiting_checklist");
    expect(s.complete).not.toHaveBeenCalled();
  });

  it("cancel the camera: the visit stays started, nothing is uploaded or completed", async () => {
    const { s, log } = steps({ capture: vi.fn(async () => null) });
    const start = vi.fn(async () => ({ queued: false }));
    expect(await startThenPhotoThenComplete(start, true, s)).toBe("awaiting_photo");
    expect(start).toHaveBeenCalledOnce();
    expect(log).toEqual([]);
  });

  it("a photo that could not be saved: still started, the error reported, no Complete", async () => {
    const onErr = vi.fn();
    const { s } = steps({
      upload: vi.fn(async () => {
        throw new Error("quota");
      }),
    });
    expect(await photoThenComplete(s, onErr)).toBe("awaiting_photo");
    expect(onErr).toHaveBeenCalledOnce();
    expect(s.complete).not.toHaveBeenCalled();
  });

  it("offline: start, photo and completion are each queued, and still in that order", async () => {
    const { s, log } = steps({}, true);
    const start = vi.fn(async () => {
      log.push("start");
      return { queued: true };
    });
    expect(await startThenPhotoThenComplete(start, true, s)).toBe("completed");
    expect(log).toEqual(["start", "capture", "upload", "complete"]);
  });

  it("a Start that fails goes no further", async () => {
    const { s } = steps();
    const start = vi.fn(async () => {
      throw new Error("Not authorized for this visit");
    });
    await expect(startThenPhotoThenComplete(start, true, s)).rejects.toThrow(/Not authorized/);
    expect(s.capture).not.toHaveBeenCalled();
  });

  it("a Complete the server refuses is the caller's to report", async () => {
    const { s } = steps({
      complete: vi.fn(async () => {
        throw new Error("A completion photo is required");
      }),
    });
    await expect(photoThenComplete(s)).rejects.toThrow(/completion photo/);
  });

  it("the helpers agree with the rule complete_visit enforces", () => {
    expect(afterPhoto([])).toBe("complete");
    expect(afterPhoto(LIST)).toBe("checklist");
    expect(checklistReady(LIST, [])).toBe(false);
    expect(checklistReady(LIST, ["gate"])).toBe(true);
  });
});

describe("My Day runs it with the card's own steps", () => {
  const myDay = read("src/routes/_authenticated/my-day.tsx");

  it("Start goes on to the photo only where the business requires one", () => {
    const start = myDay.slice(myDay.indexOf("const start = useMutation({"));
    const onSuccess = start.slice(0, start.indexOf("onError"));
    expect(onSuccess).toMatch(
      /startOpensCamera\(\{\s*requireCompletionPhoto,\s*photoOnFile,\s*canPerform: canPerformVisit,?\s*\}\)/,
    );
    expect(onSuccess).toMatch(/void runPhotoToComplete\("after_start"\)/);
  });

  it("uses the same upload, the same Complete and the same offline queue as the buttons", () => {
    const run = myDay.slice(myDay.indexOf("const runPhotoToComplete"));
    const body = run.slice(0, run.indexOf("// The lock screen's Complete"));
    expect(body).toMatch(/uploadPhoto\(file, "completion"\)/);
    expect(body).toMatch(/complete: \(ticked\) => complete\.mutateAsync\(ticked\)/);
    // uploadPhoto and complete are useOfflineVisitActions' (runOrQueue).
    expect(myDay).toMatch(/const r = await actions\.uploadPhoto\(file, photoKind_\);/);
    expect(myDay).toMatch(/mutationFn: \(ticked\?: string\[\] \| void\) =>\s*actions\.complete\(/);
  });

  it("a cancelled native camera is a cancel, not a second picker", () => {
    expect(myDay).toMatch(/if \(\/cancel\/i\.test\(/);
  });

  it("on the web the camera is the file input, with capture, and a cancel resolves the wait", () => {
    expect(myDay).toMatch(/capture="environment"/);
    expect(myDay).toMatch(/el\.addEventListener\("cancel"/);
  });

  it("the card says 'Take photo to complete' while the photo is what it needs", () => {
    expect(myDay).toMatch(/t\("visit\.takePhotoToComplete"\)/);
    expect(myDay).toMatch(
      /needsCompletionPhoto =\s*\(inProg \|\| missed\) && canPerformVisit && requireCompletionPhoto && !photoOnFile/,
    );
  });

  it("the checklist sheet completes only once the required items are ticked", () => {
    expect(myDay).toMatch(/disabled=\{!checklistReady\(checklist, checkedItems\)\}/);
  });

  it("the lock screen's Complete opens the card's photo capture", () => {
    expect(myDay).toMatch(/openCapture: \(id\) =>/);
    expect(myDay).toMatch(
      /captureRequest=\{captureAsk && captureAsk\.id === v\.id \? captureAsk\.n : 0\}/,
    );
    expect(myDay).toMatch(/void runPhotoToComplete\("lock_screen"\)/);
  });
});
