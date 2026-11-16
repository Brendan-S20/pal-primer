// #942: setup step 1 refused a save for a missing answer in a toast and
// nothing else, so a new business (signup never asks for an address) pressed
// Save after ticking Pet waste removal and saw the page stay where it was,
// with no reason on it. The rule is now one function, the form shows its
// sentence beside Save (role=alert, aria-describedby), and Save is never
// disabled for a missing answer. The browser half is
// tests/viewports/setup-step-1-says-what-it-still-needs.spec.ts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { BusinessSaveButton } from "@/components/SetupBusinessSave";
import { businessStepProblem, BUSINESS_STEP_MESSAGES } from "@/lib/setup-business-problem";
import { OFFERED_SERVICE_LINES } from "@/lib/service-lines";

const ROOT = join(import.meta.dirname, "..");
const ok = { lines: ["pet_waste"] as const, address: "1 Main St", workday: null, officeEmail: "" };

describe("what step 1 still needs (#942)", () => {
  it("each business type on its own, with an address, is enough", () => {
    for (const line of OFFERED_SERVICE_LINES) {
      expect(businessStepProblem({ ...ok, lines: [line] })).toBeNull();
    }
  });

  it("names the services question, then the address, in the order of the form", () => {
    expect(businessStepProblem({ ...ok, lines: [], address: "" })).toEqual({
      field: "services",
      message: BUSINESS_STEP_MESSAGES.services,
    });
    expect(businessStepProblem({ ...ok, address: "   " })).toEqual({
      field: "address",
      message: "Add your business address. Routes start from it.",
    });
  });

  it("passes the hours' own sentence through, and checks the office email's shape", () => {
    expect(
      businessStepProblem({ ...ok, workday: "Your workday has to end after it starts." }),
    ).toEqual({ field: "workday", message: "Your workday has to end after it starts." });
    expect(businessStepProblem({ ...ok, officeEmail: "not-an-email" })?.field).toBe("officeEmail");
    expect(businessStepProblem({ ...ok, officeEmail: "you@example.com" })).toBeNull();
  });

  it("Save is described by the message, and not disabled by it", () => {
    const html = renderToStaticMarkup(
      <BusinessSaveButton
        saving={false}
        dispatch={{ isSuccess: true, isError: false }}
        describedBy="setup-business-error"
      />,
    );
    expect(html).toMatch(/aria-describedby="setup-business-error"/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).toContain("Save and continue");
  });

  it("the form keeps the sentence on screen, role=alert, and never refuses by toast alone", () => {
    const src = readFileSync(join(ROOT, "src/routes/_authenticated/setup.tsx"), "utf8");
    const panel = src.slice(src.indexOf("function BusinessPanel("), src.indexOf("const MILES ="));
    expect(panel).toMatch(/id=\{BUSINESS_ERROR_ID\}\s+role="alert"/);
    expect(panel).toMatch(/describedBy=\{message \? BUSINESS_ERROR_ID : undefined\}/);
    expect(panel).toMatch(/if \(problem\) \{\s*setPressed\(/);
    // Every toast.error in step 1 is either the problem's sentence (also shown
    // inline) or nothing: the old toast-only refusals are gone.
    const toasts = panel.match(/toast\.error\(([^)]*)\)/g) ?? [];
    expect(toasts).toEqual(["toast.error(problem.message)"]);
  });
});
