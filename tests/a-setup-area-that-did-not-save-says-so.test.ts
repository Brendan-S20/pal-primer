// Setup step 2 ("Your service area and price") never fails in silence, and
// never throws away what was typed (#881).
//
// The report: a new owner typed $20, pressed Save and continue, waited, and
// pressed it again. No error, the step did not move, the price field was
// empty, and no zone existed. The server half -- that one Save on a business
// made a minute ago creates exactly one zone at that price -- is
// tests/e2e/the-setup-area-step-saves-the-zone.spec.ts, against real
// Postgres. This is the screen half, without a DOM:
//
//   - readableSaveError: a failure is a sentence. A request the platform cut
//     off answers with an HTML error page, and that markup WAS the toast;
//   - stepSave hands the same sentence to the form (onFailed), so it can stay
//     beside Save instead of living four seconds at the top of the screen;
//   - the wiring, read from source: step 2 keeps a draft of what was typed,
//     draws its Save in the sticky bar it used to sit under (#771), and says
//     why Save is disabled when the prices it needs did not load.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MutationObserver, QueryClient } from "@tanstack/react-query";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  SAVE_FAILED_FALLBACK,
  SAVE_NO_ANSWER,
  readableSaveError,
  stepSave,
} from "@/lib/setup-step-save";

const root = join(import.meta.dirname, "..");
const setup = readFileSync(join(root, "src/routes/_authenticated/setup.tsx"), "utf8");
const panel = setup.slice(
  setup.indexOf("function ServiceAreaPanel("),
  setup.indexOf("// ── 3. The first client"),
);

describe("readableSaveError", () => {
  it("passes the server's own sentence through", () => {
    expect(readableSaveError(new Error("Zone name needs at least 2 characters"))).toBe(
      "Zone name needs at least 2 characters",
    );
  });

  it("an error page is not a sentence: it says the server did not answer, and that nothing typed is lost", () => {
    for (const page of [
      "<html><body><h1>504 Gateway Timeout</h1></body></html>",
      "<!DOCTYPE html><html><head><title>Error</title></head></html>",
      "504 Gateway Time-out",
      "Worker exceeded resource limits",
    ]) {
      expect(readableSaveError(new Error(page)), page).toBe(SAVE_NO_ANSWER);
    }
    expect(SAVE_NO_ANSWER).toMatch(/still here/);
  });

  it("nothing at all still says something", () => {
    expect(readableSaveError(new Error(""))).toBe(SAVE_FAILED_FALLBACK);
    expect(readableSaveError(undefined)).toBe(SAVE_FAILED_FALLBACK);
    expect(readableSaveError({})).toBe(SAVE_FAILED_FALLBACK);
  });

  it("a very long message is cut to something a toast can hold", () => {
    expect(readableSaveError(new Error("x".repeat(1000))).length).toBeLessThanOrEqual(300);
  });
});

describe("stepSave hands a failure to the form", () => {
  async function run(save: () => Promise<unknown>) {
    const qc = new QueryClient();
    vi.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
    const notify = { success: vi.fn(), error: vi.fn() };
    const onFailed = vi.fn();
    const onSaved = vi.fn();
    const obs = new MutationObserver(
      qc,
      stepSave({ qc, save, refresh: [["zones"]], onSaved, notify, onFailed }),
    );
    await obs.mutate().catch(() => undefined);
    return { notify, onFailed, onSaved };
  }

  it("the same sentence goes to the toast and to the form, and the step stays", async () => {
    const r = await run(async () => {
      throw new Error("<html><body>504</body></html>");
    });
    expect(r.notify.error).toHaveBeenCalledWith(SAVE_NO_ANSWER);
    expect(r.onFailed).toHaveBeenCalledWith(SAVE_NO_ANSWER);
    expect(r.onSaved).not.toHaveBeenCalled();
  });

  it("a save that worked tells the form nothing went wrong", async () => {
    const r = await run(async () => ({ ok: true }));
    expect(r.onFailed).not.toHaveBeenCalled();
    expect(r.onSaved).toHaveBeenCalled();
  });
});

describe("setup step 2, from source", () => {
  it("found the panel", () => {
    expect(panel.length).toBeGreaterThan(1000);
  });

  it("keeps what was typed on the device, and clears it once the area is saved", () => {
    expect(panel).toMatch(/useFormDraft<SetupAreaDraft>\(\{\s*form: "setup-area"/);
    expect(panel).toMatch(/value: \{[^}]*\bprice\b[^}]*\}/);
    const saved = panel.slice(panel.indexOf("saved: () =>"));
    expect(saved.slice(0, saved.indexOf("toast.success"))).toMatch(/draft\.clear\(\)/);
    expect(panel).toMatch(
      /draft\.restored && <DraftRestoredNotice onDiscard=\{draft\.discard\} \/>/,
    );
  });

  it("keeps a failure on screen beside Save, from the save and from every refusal", () => {
    expect(panel).toMatch(/onFailed: setFailure/);
    expect(panel).toMatch(/role="alert"[\s\S]{0,200}data-setup-error/);
    // At the end of the form, which on a phone is under the sticky bar: the
    // step brings it to the middle of the screen rather than leave it covered.
    expect(panel).toMatch(/ref=\{failureRef\}/);
    expect(panel).toMatch(/failureRef\.current\?\.scrollIntoView\(\{ block: "center" \}\)/);
    // Every client-side refusal goes through refuse(), which sets it too.
    const submit = panel.slice(panel.indexOf("onSubmit={"), panel.indexOf("m.mutate();"));
    expect(submit).not.toMatch(/toast\.error\(/);
    expect(submit.match(/refuse\(/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("draws Save in the sticky bar, tied to its form, where the bar cannot cover it (#771)", () => {
    expect(panel).toMatch(/<form\s+id=\{SETUP_AREA_FORM_ID\}/);
    expect(panel).toMatch(/form=\{SETUP_AREA_FORM_ID\}/);
    expect(panel).toMatch(/<SetupStepPrimary>\{saveButton\}<\/SetupStepPrimary>/);
    // The step that holds two forms keeps it in place: one bar, one primary.
    expect(setup).toMatch(/<ServiceAreaPanel[\s\S]{0,200}inBar=\{false\}/);
  });

  it("says why Save is disabled while the prices load, and when they failed to", () => {
    expect(panel).toMatch(/"Loading your prices…"/);
    expect(panel).toMatch(/pricesFailed && \(/);
    expect(panel).toMatch(/fcQ\.refetch\(\)/);
    expect(panel).toMatch(/stdQ\.refetch\(\)/);
  });
});
