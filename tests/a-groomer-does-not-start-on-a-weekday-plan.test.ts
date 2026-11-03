// F-04 (round-2 audit, RC3): the new-client wizard's Plan step started every
// business on a weekly plan, and a service priced by itself on Monday to
// Friday. A groomer got "Bath & brush, weekly, 5 days a week", a trainer a
// Mon-Fri Evaluation, a sitter a weekday drop-in plan for two cats. And the
// plan's service defaulted to the seeded "Pet waste removal" that every
// business holds, active or not, whatever it runs.
//
// The starting values are in src/lib/new-client-plan.ts and the picker rule in
// src/lib/visit-service.ts. Nothing is refused and nothing is deleted: a
// starting value is one tap from any other, and a plan that already has the
// pet-waste service keeps it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPlanWeekdays, planStartsSkipped } from "@/lib/new-client-plan";
import { defaultServiceId, hidesPetWasteService, servicePickerOptions } from "@/lib/visit-service";
import { WORK_WEEK } from "@/lib/weekday-set";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

const svc = (id: string, name: string, service_line: string, active = true) => ({
  id,
  name,
  service_line,
  active,
});
const WASTE = svc("w", "Pet waste removal", "pet_waste");
const BATH = svc("b", "Bath & brush", "mobile_grooming");
const FULL = svc("f", "Full groom", "mobile_grooming");
const EVAL = svc("e", "Evaluation (45 min)", "training");
const WALK = svc("k", "30-minute walk", "dog_walking");

describe("the Plan step's starting values follow the line", () => {
  it("starts skipped for a business that only grooms, sits or trains", () => {
    expect(planStartsSkipped(["mobile_grooming"])).toBe(true);
    expect(planStartsSkipped(["training"])).toBe(true);
    expect(planStartsSkipped(["pet_sitting"])).toBe(true);
    expect(planStartsSkipped(["pet_sitting", "mobile_grooming", "training"])).toBe(true);
  });

  it("starts on a plan for a business that scoops or walks, as before", () => {
    expect(planStartsSkipped(["pet_waste"])).toBe(false);
    expect(planStartsSkipped(["dog_walking"])).toBe(false);
    expect(planStartsSkipped(["dog_walking", "pet_sitting"])).toBe(false);
    expect(planStartsSkipped(["mobile_grooming", "pet_waste"])).toBe(false);
  });

  it("starts on a plan while the answer is unknown, which reads as pet waste", () => {
    expect(planStartsSkipped(["training"], false)).toBe(false);
  });

  it("a walk is Monday to Friday; anything else is the first visit's weekday", () => {
    expect(defaultPlanWeekdays("dog_walking", 3)).toEqual([...WORK_WEEK]);
    expect(defaultPlanWeekdays("mobile_grooming", 3)).toEqual([3]);
    expect(defaultPlanWeekdays("training", 6)).toEqual([6]);
    expect(defaultPlanWeekdays("pet_sitting", 1)).toEqual([1]);
    expect(defaultPlanWeekdays(null, 2)).toEqual([2]);
  });
});

describe("the seeded pet-waste service is not a groomer's or a trainer's default", () => {
  const all = [WASTE, BATH, FULL, EVAL];

  it("a business without pet waste starts on its own first service", () => {
    expect(defaultServiceId(all, ["mobile_grooming"])).toBe("b");
    expect(defaultServiceId([WASTE, EVAL], ["training"])).toBe("e");
  });

  it("a business with pet waste starts on it, exactly as before", () => {
    expect(defaultServiceId(all, ["pet_waste", "mobile_grooming"])).toBe("w");
    expect(defaultServiceId(all)).toBe("w");
  });

  it("the picker leaves it out for a business without pet waste, but keeps a plan's own", () => {
    expect(servicePickerOptions(all, null, ["mobile_grooming"]).map((s) => s.id)).toEqual([
      "b",
      "f",
      "e",
    ]);
    expect(servicePickerOptions(all, "w", ["mobile_grooming"]).map((s) => s.id)).toContain("w");
    expect(
      servicePickerOptions(all, null, ["pet_waste", "dog_walking"]).map((s) => s.id),
    ).toContain("w");
  });

  it("an unread answer hides nothing", () => {
    expect(hidesPetWasteService(WASTE, undefined)).toBe(false);
    expect(servicePickerOptions([WASTE, WALK]).map((s) => s.id)).toEqual(["w", "k"]);
  });

  it("an inactive seeded service is never the default either", () => {
    expect(defaultServiceId([svc("w", "Pet waste removal", "pet_waste", false), EVAL])).toBe("e");
  });
});

describe("the wizard reads them", () => {
  const wizard = read("src/routes/_authenticated/clients.new.tsx");

  it("Skip subscription starts from the line until the owner touches it", () => {
    expect(wizard).toMatch(/useState<boolean \| null>\(null\)/);
    expect(wizard).toMatch(/skipPlanChoice \?\? planStartsSkipped\(lines, linesKnown\)/);
    expect(wizard).not.toMatch(/const \[skipPlan, setSkipPlan\] = useState\(false\)/);
  });

  it("the weekly days start from the chosen service's line", () => {
    expect(wizard).toMatch(
      /weekdayChoice \?\?\s*defaultPlanWeekdays\(chosenService\?\.service_line, weekdayOf\(startedOn\)\)/,
    );
    expect(wizard).not.toMatch(/useState<number\[\]>\(\[\.\.\.WORK_WEEK\]\)/);
  });

  it("the service follows the business's lines, and its one service is the plan's", () => {
    expect(wizard).toMatch(/servicePickerOptions\(orgServices, null, pickerLines\)/);
    expect(wizard).toMatch(/effectiveServiceId\(serviceId, orgServices, pickerLines\)/);
    expect(wizard).toMatch(/offersServicePicker \|\| \(linesKnown && !petWaste\)/);
  });

  it("the plan form and its picker use the same lines", () => {
    const tab = read("src/components/client-detail/ServicesTab.tsx");
    expect(tab).toMatch(/effectiveServiceId\(form\.serviceId, orgServices, pickerLines\)/);
    expect(tab).not.toMatch(/effectiveServiceId\(form\.serviceId, orgServices\)/);
    const picker = read("src/components/client-detail/ServicePicker.tsx");
    expect(picker).toMatch(/servicePickerOptions\(services, currentId, lines\)/);
    expect(picker).toMatch(/effectiveServiceId\(value, services, lines\)/);
    // Each caller hands the picker the lines it saves with.
    for (const f of [
      "src/components/client-detail/ServicesTab.tsx",
      "src/routes/_authenticated/clients.new.tsx",
      "src/components/OneOffVisitDialog.tsx",
    ]) {
      expect(read(f), f).toMatch(/<ServicePicker[\s\S]*?lines=\{pickerLines\}/);
    }
  });
});
