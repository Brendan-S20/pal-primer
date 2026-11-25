// #1014 (onboarding audit, Nov 20 2026): the new-client Plan step started on
// the seeded "Pet waste removal" right after the owner added a service, and
// moving First visit to Today left the picked service day on another weekday.
// (Service day against First visit is tested in
// new-client-service-day-keeps-the-owners-choice.test.tsx, #1059.)
// The dashboard also said "On the Launch plan" under a "free trial" banner.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { latestServiceId } from "@/lib/visit-service";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const svc = (id: string, name: string, line: string, created_at: string) => ({
  id,
  name,
  service_line: line as never,
  active: true,
  created_at,
});

describe("the plan step follows the owner's latest service", () => {
  const waste = svc("a", "Pet waste removal", "pet_waste", "2026-11-01T00:00:00Z");
  const walk = svc("b", "Dog walk", "dog_walking", "2026-11-20T00:00:00Z");
  it("starts on the newest active service", () => {
    expect(latestServiceId([waste, walk])).toBe("b");
  });
  it("keeps the seeded service when it is the only one", () => {
    expect(latestServiceId([waste])).toBe("a");
  });
  it("ignores an inactive newest service", () => {
    expect(latestServiceId([waste, { ...walk, active: false }])).toBe("a");
  });
  it("is what the form's picker and plan use", () => {
    const src = read("../src/routes/_authenticated/clients.new.tsx");
    expect(src).toContain("latestServiceId(orgServices, pickerLines)");
    expect(src).toContain("value={shownServiceId}");
  });
});

describe("the dashboard does not say Launch plan during a trial", () => {
  it("says the free trial while trialing", () => {
    const src = read("../src/routes/_authenticated/dashboard.tsx");
    expect(src).toMatch(/trialPhase === "trialing"\s*\? "On the free trial"/);
  });
});
