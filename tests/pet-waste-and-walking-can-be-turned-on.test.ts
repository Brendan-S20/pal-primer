// Pet waste and dog walking can be turned on; nothing else until it is
// approved to go live.
//
// Dog walking (#410) was turned on in #530, and is on in the platform
// switch's seed (platform_service_lines, read at runtime, #531). Pet sitting
// (#411), mobile grooming (#412) and training (#413) are turned on there with
// their own approval, with no new build. Until then the picker shows them as Coming soon and disabled, and
// setServiceLines refuses to add one. A business that already runs one keeps
// it and can turn it off.

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
import { LAUNCH_DEFAULT, withBookable, withoutBookable } from "./support/service-line-availability";

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

describe("pet waste and dog walking can be turned on", () => {
  it("the switch's default is pet waste and dog walking, exactly", () => {
    expect([...LAUNCH_DEFAULT.bookable]).toEqual(["pet_waste", "dog_walking"]);
  });

  it("the picker offers walking with no Coming soon badge, and can tick it", () => {
    const r = rows(["pet_waste"]);
    for (const line of ["pet_waste", "dog_walking"]) expect(r[line]).not.toContain("Coming soon");
    // Pet waste is the only line ticked, so it is the one that cannot be
    // unticked; walking is the one being added.
    expect(r.dog_walking).toContain('aria-checked="false"');
    expect(isDisabled(r.dog_walking)).toBe(false);
  });

  it("the picker still marks sitting, grooming and training Coming soon and disabled", () => {
    const r = rows(["pet_waste"]);
    for (const line of ["pet_sitting", "mobile_grooming", "training"]) {
      expect(r[line]).toContain("Coming soon");
      expect(isDisabled(r[line])).toBe(true);
    }
  });

  it("a Coming soon line the business already runs stays shown and can be turned off", () => {
    const r = rows(["pet_waste", "pet_sitting"]);
    expect(r.pet_sitting).toContain("Coming soon");
    expect(r.pet_sitting).toContain('aria-checked="true"');
    expect(isDisabled(r.pet_sitting)).toBe(false);
    expect(isDisabled(r.mobile_grooming)).toBe(true);
  });

  it("turning a line on or off at the switch changes the picker, with no new build", () => {
    const on = rows(["pet_waste"], withBookable("pet_sitting"));
    expect(on.pet_sitting).not.toContain("Coming soon");
    expect(isDisabled(on.pet_sitting)).toBe(false);
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

  it("the server check accepts adding dog walking", () => {
    expect(
      serviceLinesAdditionProblem(["pet_waste"], ["pet_waste", "dog_walking"], LAUNCH_DEFAULT),
    ).toBeNull();
    expect(serviceLinesAdditionProblem(["pet_waste"], ["dog_walking"], LAUNCH_DEFAULT)).toBeNull();
  });

  it("the server check refuses adding sitting, grooming or training", () => {
    for (const line of ["pet_sitting", "mobile_grooming", "training"] as const) {
      expect(serviceLinesAdditionProblem(["pet_waste"], ["pet_waste", line], LAUNCH_DEFAULT)).toBe(
        "That service is coming soon.",
      );
      expect(
        serviceLinesAdditionProblem(["dog_walking"], ["dog_walking", line], LAUNCH_DEFAULT),
      ).toBe("That service is coming soon.");
    }
  });

  it("the server check keeps a line the org already has", () => {
    expect(
      serviceLinesAdditionProblem(["pet_sitting"], ["pet_sitting"], LAUNCH_DEFAULT),
    ).toBeNull();
    expect(
      serviceLinesAdditionProblem(["pet_sitting"], ["pet_waste", "pet_sitting"], LAUNCH_DEFAULT),
    ).toBeNull();
    expect(
      serviceLinesAdditionProblem(["pet_waste", "pet_sitting"], ["pet_waste"], LAUNCH_DEFAULT),
    ).toBeNull();
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
