// Pet waste and dog walking can be turned on; nothing else until it is
// approved to go live.
//
// Dog walking (#410) joined BOOKABLE_SERVICE_LINES in #530. Pet sitting
// (#411), mobile grooming (#412) and training (#413) join with their own
// approval. Until then the picker shows them as Coming soon and disabled, and
// setServiceLines refuses to add one. A business that already runs one keeps
// it and can turn it off.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceLinesChoices } from "@/components/ServiceLinesChoices";
import {
  BOOKABLE_SERVICE_LINES,
  OFFERED_SERVICE_LINES,
  serviceLinesAdditionProblem,
  type ServiceLine,
} from "@/lib/service-lines";

const ROOT = join(__dirname, "..");

/** Each picker row's markup, by line. */
function rows(lines: ServiceLine[]): Record<string, string> {
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
  it("BOOKABLE_SERVICE_LINES is pet waste and dog walking, exactly", () => {
    expect([...BOOKABLE_SERVICE_LINES]).toEqual(["pet_waste", "dog_walking"]);
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

  it("the server check accepts adding dog walking", () => {
    expect(serviceLinesAdditionProblem(["pet_waste"], ["pet_waste", "dog_walking"])).toBeNull();
    expect(serviceLinesAdditionProblem(["pet_waste"], ["dog_walking"])).toBeNull();
  });

  it("the server check refuses adding sitting, grooming or training", () => {
    for (const line of ["pet_sitting", "mobile_grooming", "training"] as const) {
      expect(serviceLinesAdditionProblem(["pet_waste"], ["pet_waste", line])).toBe(
        "That service is coming soon.",
      );
      expect(serviceLinesAdditionProblem(["dog_walking"], ["dog_walking", line])).toBe(
        "That service is coming soon.",
      );
    }
  });

  it("the server check keeps a line the org already has", () => {
    expect(serviceLinesAdditionProblem(["pet_sitting"], ["pet_sitting"])).toBeNull();
    expect(serviceLinesAdditionProblem(["pet_sitting"], ["pet_waste", "pet_sitting"])).toBeNull();
    expect(serviceLinesAdditionProblem(["pet_waste", "pet_sitting"], ["pet_waste"])).toBeNull();
  });

  it("setServiceLines runs the check before it writes", () => {
    const src = readFileSync(join(ROOT, "src/lib/org-features.functions.ts"), "utf8");
    const fn = src.slice(src.indexOf("export const setServiceLines"));
    const check = fn.indexOf("serviceLinesAdditionProblem(");
    const write = fn.indexOf("updateOwnOrg(context.supabase, orgId, { service_lines");
    expect(check).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(check);
  });
});
