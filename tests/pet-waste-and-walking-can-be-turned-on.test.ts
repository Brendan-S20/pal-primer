// Pet waste, dog walking, pet sitting and training can be turned on; nothing
// else until it is approved to go live.
//
// Dog walking (#410) was turned on in #530, and is on in the platform
// switch's seed (platform_service_lines, read at runtime, #531). Pet sitting
// (#411) was turned on there by 20261026200000 (#547), and training (#413) by
// 20261027120000 (#548). Mobile grooming (#412) is turned on there with its
// own approval, with no new build. Until then the picker shows it as Coming
// soon and disabled, and setServiceLines refuses to add it. A business that already runs one
// keeps it and can turn it off.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ServiceLinesChoices } from "@/components/ServiceLinesChoices";
import {
  OFFERED_SERVICE_LINES,
  serviceLinesAdditionProblem,
  type ServiceLine,
  type ServiceLineAvailability,
} from "@/lib/service-lines";
import {
  LAUNCH_DEFAULT,
  TRAINING_COMING_SOON,
  withBookable,
  withoutBookable,
} from "./support/service-line-availability";

// The switch as the picker reads it. Null is "not arrived yet".
const h = vi.hoisted(() => ({ availability: null as ServiceLineAvailability | null }));
vi.mock("@/hooks/useServiceLineAvailability", () => ({
  useServiceLineAvailability: () => h.availability,
}));

const ROOT = join(__dirname, "..");

/** Each picker row's markup, by line. */
function rows(
  lines: ServiceLine[],
  availability: ServiceLineAvailability | null = LAUNCH_DEFAULT,
): Record<string, string> {
  h.availability = availability;
  const html = renderToStaticMarkup(
    createElement(ServiceLinesChoices, { lines, onChange: () => {}, idPrefix: "t" }),
  );
  const items = html.match(/<li>[\s\S]*?<\/li>/g) ?? [];
  expect(items).toHaveLength(OFFERED_SERVICE_LINES.length);
  return Object.fromEntries(OFFERED_SERVICE_LINES.map((line, i) => [line, items[i]]));
}

/** The checkbox in a row is a Radix button. */
function isDisabled(row: string): boolean {
  const button = row.match(/<button[^>]*role="checkbox"[^>]*>/)?.[0] ?? "";
  return /\sdisabled=""/.test(button);
}

describe("pet waste, dog walking, pet sitting and training can be turned on", () => {
  it("the switch's default is pet waste, dog walking, pet sitting and training, exactly", () => {
    expect([...LAUNCH_DEFAULT.bookable]).toEqual([
      "pet_waste",
      "dog_walking",
      "pet_sitting",
      "training",
    ]);
  });

  it("the picker offers walking, sitting and training with no Coming soon badge, and can tick them", () => {
    const r = rows(["pet_waste"]);
    for (const line of ["pet_waste", "dog_walking", "pet_sitting", "training"])
      expect(r[line]).not.toContain("Coming soon");
    // Pet waste is the only line ticked, so it is the one that cannot be
    // unticked; walking, sitting and training are the ones being added.
    for (const line of ["dog_walking", "pet_sitting", "training"]) {
      expect(r[line]).toContain('aria-checked="false"');
      expect(isDisabled(r[line])).toBe(false);
    }
  });

  it("the picker still marks grooming Coming soon and disabled", () => {
    const r = rows(["pet_waste"]);
    expect(r.mobile_grooming).toContain("Coming soon");
    expect(isDisabled(r.mobile_grooming)).toBe(true);
    // And training, with the switch as it was before #548.
    const before = rows(["pet_waste"], TRAINING_COMING_SOON);
    expect(before.training).toContain("Coming soon");
    expect(isDisabled(before.training)).toBe(true);
  });

  it("a Coming soon line the business already runs stays shown and can be turned off", () => {
    const r = rows(["pet_waste", "training"], TRAINING_COMING_SOON);
    expect(r.training).toContain("Coming soon");
    expect(r.training).toContain('aria-checked="true"');
    expect(isDisabled(r.training)).toBe(false);
    expect(isDisabled(r.mobile_grooming)).toBe(true);
  });

  it("turning a line on or off at the switch changes the picker, with no new build", () => {
    const on = rows(["pet_waste"], withBookable("mobile_grooming"));
    expect(on.mobile_grooming).not.toContain("Coming soon");
    expect(isDisabled(on.mobile_grooming)).toBe(false);
    const off = rows(["pet_waste"], withoutBookable("dog_walking"));
    expect(off.dog_walking).toContain("Coming soon");
    expect(isDisabled(off.dog_walking)).toBe(true);
  });

  it("until the switch has arrived, nothing can be added and nothing is marked Coming soon", () => {
    const r = rows(["pet_waste", "pet_sitting"], null);
    for (const line of OFFERED_SERVICE_LINES) expect(r[line]).not.toContain("Coming soon");
    expect(isDisabled(r.dog_walking)).toBe(true);
    expect(isDisabled(r.pet_sitting)).toBe(false);
  });

  it("the server check accepts adding dog walking, pet sitting or training", () => {
    for (const line of ["dog_walking", "pet_sitting", "training"] as const) {
      expect(
        serviceLinesAdditionProblem(["pet_waste"], ["pet_waste", line], LAUNCH_DEFAULT),
      ).toBeNull();
      expect(serviceLinesAdditionProblem(["pet_waste"], [line], LAUNCH_DEFAULT)).toBeNull();
    }
  });

  it("the server check refuses adding grooming, and training with its switch off", () => {
    for (const [line, availability] of [
      ["mobile_grooming", LAUNCH_DEFAULT],
      ["training", TRAINING_COMING_SOON],
    ] as const) {
      expect(serviceLinesAdditionProblem(["pet_waste"], ["pet_waste", line], availability)).toBe(
        "That service is coming soon.",
      );
      expect(
        serviceLinesAdditionProblem(["dog_walking"], ["dog_walking", line], availability),
      ).toBe("That service is coming soon.");
    }
  });

  it("the server check keeps a line the org already has", () => {
    const g = "mobile_grooming" as const;
    expect(serviceLinesAdditionProblem([g], [g], LAUNCH_DEFAULT)).toBeNull();
    expect(serviceLinesAdditionProblem([g], ["pet_waste", g], LAUNCH_DEFAULT)).toBeNull();
    expect(serviceLinesAdditionProblem(["pet_waste", g], ["pet_waste"], LAUNCH_DEFAULT)).toBeNull();
  });

  it("setServiceLines runs the check before it writes", () => {
    const src = readFileSync(join(ROOT, "src/lib/org-features.functions.ts"), "utf8");
    const fn = src.slice(src.indexOf("export const setServiceLines"));
    const check = fn.indexOf("serviceLinesAdditionProblem(");
    expect(fn.slice(check, fn.indexOf(");", check))).toMatch(
      /await loadServiceLineAvailability\(\)/,
    );
    const write = fn.indexOf("updateOwnOrg(context.supabase, orgId, { service_lines");
    expect(check).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(check);
  });
});
