// #1011 items 1 and 4: the install banner stays off the wizard pages, and the
// one-off dialog says why Book the visit is greyed.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installBannerHiddenOn } from "@/components/InstallBanner";
import { oneOffNotReadyReason } from "@/components/OneOffVisitDialog";

describe("the install banner", () => {
  it.each(["/clients/new", "/setup", "/onboarding", "/onboarding/plan"])("is hidden on %s", (p) => {
    expect(installBannerHiddenOn(p)).toBe(true);
  });
  it.each(["/dashboard", "/my-day", "/clients", "/clients/abc", "/clients/newton"])(
    "still shows on %s",
    (p) => {
      expect(installBannerHiddenOn(p)).toBe(false);
    },
  );
});

describe("the one-off dialog", () => {
  const ok = {
    clientId: "c", propertyId: "p", scheduledOn: "2026-11-25",
    needsService: false, priceValid: true, hasWindowProblem: false,
  };
  it("names the first missing thing, in the order of the form", () => {
    expect(oneOffNotReadyReason({ ...ok, clientId: "" })).toMatch(/client/);
    expect(oneOffNotReadyReason({ ...ok, propertyId: "" })).toMatch(/property/);
    expect(oneOffNotReadyReason({ ...ok, needsService: true })).toMatch(/service/);
    expect(oneOffNotReadyReason({ ...ok, priceValid: false })).toMatch(/price/);
    expect(oneOffNotReadyReason({ ...ok, hasWindowProblem: true })).toMatch(/arrival window/);
  });
  it("fills the price from the set price until the person types", () => {
    const src = readFileSync(join(__dirname, "..", "src/components/OneOffVisitDialog.tsx"), "utf8");
    expect(src).toContain("if (!open || !freshlyReset || !setsPrices || priceTouched) return;");
    expect(src).toContain("setPriceTouched(true)");
  });
});

describe("#1011 item 5: the Clients list", () => {
  const src = readFileSync(join(__dirname, "..", "src/routes/_authenticated/clients.index.tsx"), "utf8");
  it("formats phone numbers the way the client page does, in both layouts", () => {
    expect(src).not.toContain('{c.primary_phone ?? ""}');
    expect(src.match(/formatPhone\(c\.primary_phone\)/g)?.length).toBe(2);
  });
  it("labels the count under Outstanding", () => {
    expect(src).not.toContain("`${stats.outstanding} clients`");
    expect(src).toContain("`${stats.outstanding} owing`");
  });
});
