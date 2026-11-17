// #943: "clearing a walker's route start shows saved but the old address
// returns". It did not return. The box was empty after the reload, and its
// grey hint was "123 Main St, Austin, TX 78701", which an owner reasonably
// read as the stored value. #951 replaced the made-up address with "Street,
// city, state and ZIP"; this pins the next step HS Product asked for: an
// empty route start or end says what EMPTY does, and the toast after a save
// describes what was stored, not a generic success over an emptied field.
//
// The round trip itself (cleared -> stored null -> read back null) is proved
// in tests/what-onboarding-saves-settings-shows.test.ts against the server
// function, and in a browser on the fixture backend in
// tests/viewports/a-cleared-route-start-stays-cleared.spec.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROUTE_START_BLANK_HINT,
  routeEndBlankHint,
  routeEndpointsSavedMessage,
} from "@/lib/route-endpoints";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Both places a person edits a route start and end. */
const EDITORS = [
  "src/routes/_authenticated/settings.users.tsx",
  "src/components/routes/StaffRoutingDialog.tsx",
];

describe("an empty route start or end says what empty means", () => {
  it("the hints describe the fallback and cannot be read as an address", () => {
    for (const hint of [
      ROUTE_START_BLANK_HINT,
      routeEndBlankHint(true),
      routeEndBlankHint(false),
    ]) {
      expect(hint).toMatch(/^Leave blank to /);
      // No house number, no ZIP, no "City, ST": nothing that looks stored.
      expect(hint).not.toMatch(/\d/);
      expect(hint).not.toMatch(/,\s*[A-Z]{2}\b/);
    }
    expect(ROUTE_START_BLANK_HINT).toBe("Leave blank to start from the business address");
  });

  it("a business that does not scoop is not told about a dump site", () => {
    expect(routeEndBlankHint(true)).toMatch(/dump site/);
    expect(routeEndBlankHint(false)).not.toMatch(/dump/i);
  });

  it.each(EDITORS)("%s uses the shared hints for both boxes", (file) => {
    const src = read(file);
    expect(src).toContain("placeholder={ROUTE_START_BLANK_HINT}");
    expect(src).toContain("placeholder={routeEndBlankHint(petWaste)}");
    // The pre-#951 hint, and the hints this replaced, are gone.
    for (const old of [
      "123 Main St",
      "Street, city, state and ZIP",
      "Landfill or home address",
      "Home, shop, or depot",
      "Dump, home, or shop",
    ]) {
      expect(src, `${file} still hints "${old}"`).not.toContain(old);
    }
  });

  it.each(EDITORS)("%s builds its toast from what the server stored", (file) => {
    const src = read(file);
    expect(src).toMatch(/routeEndpointsSavedMessage\(stored, petWaste\)/);
    expect(src).not.toMatch(/toast\.success\("Route endpoints saved/);
  });
});

describe("the saved toast says what was stored", () => {
  it("both ends set", () => {
    expect(routeEndpointsSavedMessage({ startAddress: "A", endAddress: "B" }, true)).toBe(
      "Route start and end saved.",
    );
  });

  it("a cleared start names the business address, never a generic success", () => {
    const m = routeEndpointsSavedMessage({ startAddress: null, endAddress: "B" }, true);
    expect(m).toBe("Saved. No route start: routes start from the business address.");
  });

  it("whitespace is no start", () => {
    expect(routeEndpointsSavedMessage({ startAddress: "  ", endAddress: "B" }, false)).toMatch(
      /No route start/,
    );
  });

  it("a cleared end, with and without pet waste", () => {
    expect(routeEndpointsSavedMessage({ startAddress: "A", endAddress: null }, true)).toBe(
      "Saved. No route end: routes end at the dump site, or the last stop if there is none.",
    );
    expect(routeEndpointsSavedMessage({ startAddress: "A", endAddress: null }, false)).toBe(
      "Saved. No route end: routes end at the last stop.",
    );
  });

  it("both cleared", () => {
    expect(routeEndpointsSavedMessage({ startAddress: null, endAddress: null }, false)).toBe(
      "Saved. No route start: routes start from the business address. No route end: routes end at the last stop.",
    );
  });
});
