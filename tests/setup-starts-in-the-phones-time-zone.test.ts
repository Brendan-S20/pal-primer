// #654, F-24 / native-r2-07: setup came up on Central six times out of six,
// including on a phone set to America/Detroit. The signup form never sent a
// zone, the setup step showed `saved ?? Chicago`, and Detroit was not in the
// list. Acceptance: MI, OR, CO and TX preselect from the device or the address.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { suggestSetupTimezone, timezoneFromUsAddress, timezoneOptions } from "@/lib/org-timezone";
import { US_TIMEZONES } from "@/lib/route-window";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const CASES: Array<[state: string, device: string, address: string]> = [
  ["MI", "America/Detroit", "1 Woodward Ave, Detroit, MI 48226"],
  ["OR", "America/Los_Angeles", "200 SW Market St, Portland, OR 97201"],
  ["CO", "America/Denver", "1437 Bannock St, Denver, CO 80202"],
  ["TX", "America/Chicago", "123 Main St, Austin, TX 78701"],
];

describe("suggestSetupTimezone", () => {
  for (const [state, zone, address] of CASES) {
    it(`${state}: the device's zone over the Central column default`, () => {
      expect(suggestSetupTimezone({ saved: "America/Chicago", device: zone })).toBe(zone);
    });
    it(`${state}: the address when the device says nothing useful`, () => {
      expect(timezoneFromUsAddress(address)).toBe(zone);
      expect(suggestSetupTimezone({ saved: "America/Chicago", device: "UTC", address })).toBe(zone);
      expect(suggestSetupTimezone({ saved: null, device: undefined, address })).toBe(zone);
    });
  }

  it("keeps a zone somebody already chose", () => {
    expect(
      suggestSetupTimezone({
        saved: "America/Denver",
        device: "America/Detroit",
        address: CASES[0][2],
      }),
    ).toBe("America/Denver");
  });

  it("falls back to the default only when nothing else is known", () => {
    expect(suggestSetupTimezone({ saved: null, device: "Not/AZone" })).toBe("America/Chicago");
  });

  it("does not read a street abbreviation as a state", () => {
    expect(timezoneFromUsAddress("12 Oak St")).toBeNull();
    expect(timezoneFromUsAddress("")).toBeNull();
  });
});

describe("the list", () => {
  it("offers Detroit, so a Michigan business is not shown New York", () => {
    expect(US_TIMEZONES.map((t) => t.value)).toEqual(
      expect.arrayContaining([
        "America/Detroit",
        "America/Denver",
        "America/Los_Angeles",
        "America/Chicago",
      ]),
    );
  });
  it("keeps any stored zone selectable", () => {
    expect(timezoneOptions("America/Kentucky/Louisville").at(-1)?.value).toBe(
      "America/Kentucky/Louisville",
    );
    expect(timezoneOptions("America/Detroit")).toBe(US_TIMEZONES);
  });
});

describe("the call sites", () => {
  it("signup sends the device's zone", () => {
    expect(read("src/routes/get-started.tsx")).toMatch(
      /bootstrapOrganization\(\{[\s\S]{0,600}timezone: deviceTimezone\(\)/,
    );
  });
  it("the setup step preselects from the device and the address", () => {
    const src = read("src/routes/_authenticated/setup.tsx");
    expect(src).toMatch(
      /suggestSetupTimezone\(\{\s*saved: savedTz,\s*device: deviceTimezone\(\),\s*address: addressVal/,
    );
    expect(src).not.toMatch(/savedTz \?\? DEFAULT_TIMEZONE/);
    expect(src).toContain("timezoneOptions(tzVal)");
  });
});
