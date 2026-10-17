// Only pet waste can be turned on until another line is approved to go live.
//
// Dog walking (#410), pet sitting (#411), mobile grooming (#412) and training
// (#413) join BOOKABLE_SERVICE_LINES with their approval. Until then the
// picker shows them as Coming soon and disabled, and setServiceLines refuses
// to add one. A business that already runs one keeps it and can turn it off.

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

describe("only pet waste can be turned on", () => {
  it("BOOKABLE_SERVICE_LINES is pet waste only", () => {
    expect([...BOOKABLE_SERVICE_LINES]).toEqual(["pet_waste"]);
  });

  it("the picker marks walking and sitting Coming soon and disabled", () => {
    const r = rows(["pet_waste"]);
    for (const line of ["dog_walking", "pet_sitting"]) {
      expect(r[line]).toContain("Coming soon");
      expect(isDisabled(r[line])).toBe(true);
    }
    expect(r.pet_waste).not.toContain("Coming soon");
  });

  it("a line the business already runs stays shown and can be turned off", () => {
    const r = rows(["pet_waste", "dog_walking"]);
    expect(r.dog_walking).toContain("Coming soon");
    expect(r.dog_walking).toContain('aria-checked="true"');
    expect(isDisabled(r.dog_walking)).toBe(false);
    expect(isDisabled(r.pet_sitting)).toBe(true);
  });

  it("the server check refuses adding dog walking", () => {
    expect(serviceLinesAdditionProblem(["pet_waste"], ["pet_waste", "dog_walking"])).toBe(
      "That service is coming soon.",
    );
    expect(serviceLinesAdditionProblem(["dog_walking"], ["dog_walking", "pet_sitting"])).toBe(
      "That service is coming soon.",
    );
  });

  it("the server check keeps a line the org already has", () => {
    expect(serviceLinesAdditionProblem(["dog_walking"], ["dog_walking"])).toBeNull();
    expect(serviceLinesAdditionProblem(["dog_walking"], ["pet_waste", "dog_walking"])).toBeNull();
    expect(serviceLinesAdditionProblem(["pet_waste", "dog_walking"], ["pet_waste"])).toBeNull();
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
