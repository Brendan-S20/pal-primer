// #797 review: /setup step 1 shows the workday prefilled with what is stored.
// Until the stored hours are read the fields show the 08:00-17:00 fallback,
// and Save pressed then wrote that over hours set in Settings, Scheduling.
// Save is now held until the read answers.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { BusinessSaveButton } from "@/components/SetupBusinessSave";
import { businessSaveBlocked } from "@/lib/setup-workday";

const ROOT = join(import.meta.dirname, "..");

const LOADING = { isSuccess: false, isError: false };
const LOADED = { isSuccess: true, isError: false };
const FAILED = { isSuccess: false, isError: true };

const button = (saving: boolean, dispatch: typeof LOADING) =>
  renderToStaticMarkup(<BusinessSaveButton saving={saving} dispatch={dispatch} />);
const isDisabled = (html: string) => /<button[^>]*\sdisabled=""/.test(html);

describe("step 1's Save waits for the stored hours", () => {
  it("is disabled, and says why, while dispatch settings are loading", () => {
    const html = button(false, LOADING);
    expect(isDisabled(html)).toBe(true);
    expect(html).toContain("Loading your hours…");
    expect(businessSaveBlocked(false, LOADING)).toBe(true);
  });

  it("is enabled once they have loaded", () => {
    const html = button(false, LOADED);
    expect(isDisabled(html)).toBe(false);
    expect(html).toContain("Save and continue");
    expect(businessSaveBlocked(false, LOADED)).toBe(false);
  });

  it("comes back after a failed read; the save then writes only typed hours", () => {
    expect(isDisabled(button(false, FAILED))).toBe(false);
    expect(businessSaveBlocked(false, FAILED)).toBe(false);
  });

  it("is disabled while saving, whatever the read", () => {
    for (const d of [LOADING, LOADED, FAILED]) {
      const html = button(true, d);
      expect(isDisabled(html)).toBe(true);
      expect(html).toContain("Saving…");
    }
  });

  it("is the button BusinessPanel draws, fed its dispatch query, and Enter is held too", () => {
    const src = readFileSync(join(ROOT, "src/routes/_authenticated/setup.tsx"), "utf8");
    const panel = src.slice(src.indexOf("function BusinessPanel("), src.indexOf("const MILES ="));
    expect(panel).toMatch(/<BusinessSaveButton saving=\{m\.isPending\} dispatch=\{dispatchQ\} \/>/);
    expect(panel).toMatch(/if \(businessSaveBlocked\(m\.isPending, dispatchQ\)\) return;/);
    // And the save itself still sends an untyped hour only once it was read.
    expect(panel).toMatch(/const workdayLoaded = dispatchQ\.isSuccess;/);
  });
});
