// The privacy policy did not mention location.
//
// Live tracking (#279) shares a technician's approximate position with the
// customer they are driving to, when the business turns it on. The policy
// said nothing about location at all, and the iOS permission text said
// location was "never shared with your clients". A policy that is silent on
// a data flow the product performs is the policy App Store review and a
// customer both read. These pin the claims the page makes to the ones the
// feature keeps: approximate, only en route, off unless the business turns
// it on, and stoppable by the technician.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(
  join(import.meta.dirname, "../src/routes/legal.privacy.tsx"),
  "utf8",
).replace(/\s+/g, " ");

describe("the privacy policy on location", () => {
  it("says what is collected, how coarsely, and for how long", () => {
    expect(page).toMatch(/approximate location \(rounded to about 100 meters\)/);
    expect(page).toMatch(/until they start that visit, for at most two hours/);
    expect(page).toMatch(/Only the latest position is kept/);
  });

  it("says it is off unless the business turns it on, and the technician can stop it", () => {
    expect(page).toMatch(/Live tracking is off unless the business turns it on/);
    expect(page).toMatch(/technician can stop it at any time/);
  });

  it("says who sees it", () => {
    expect(page).toMatch(/customer who received the &ldquo;on my way&rdquo; message can see/);
  });

  it("names integrations a business connects as a place data goes", () => {
    expect(page).toMatch(/through a webhook/);
  });
});
