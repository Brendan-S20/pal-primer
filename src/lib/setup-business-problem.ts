// ── What /setup step 1 still needs before it can save (#942) ──────────────
//
// Step 1's Save is never disabled for a missing answer. It is held only while
// it saves or while the stored hours are read, and its label says which
// (src/components/SetupBusinessSave.tsx). Everything the step genuinely
// requires is checked when Save is pressed, here, and the answer is a
// sentence that names the field.
//
// Until #942 those sentences were toasts and nothing else. A new business has
// no address yet (signup never asks for one), so an owner who ticked Pet
// waste removal and pressed Save got four seconds of "Add your business
// address" at the top of the screen while looking at the bar at the bottom,
// and the page stayed on step 1. It read as a Save that did nothing, with no
// reason given. The sentence now also stays beside the form, role=alert, the
// way step 2 says why it did not save (#881), and the field it names is
// marked aria-invalid and pointed at it.
//
// The order is the order of the form, so the first problem named is the
// first one the owner reaches scrolling down. Office-only, so English.

import type { ServiceLine } from "@/lib/service-lines";

/** The field a problem is about, so the form can mark it. */
export type BusinessStepField = "services" | "address" | "workday" | "officeEmail";

export type BusinessStepProblem = { field: BusinessStepField; message: string };

export const BUSINESS_STEP_MESSAGES = {
  services: "Choose the services you offer.",
  address: "Add your business address. Routes start from it.",
  officeEmail: "Check the office email. It should look like you@example.com.",
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The first thing step 1 still needs, or null when it can save. */
export function businessStepProblem(a: {
  lines: readonly ServiceLine[];
  address: string;
  /** workdayWriteProblem's answer for the hours this save would write. */
  workday: string | null;
  officeEmail: string;
}): BusinessStepProblem | null {
  if (a.lines.length === 0) return { field: "services", message: BUSINESS_STEP_MESSAGES.services };
  if (!a.address.trim()) return { field: "address", message: BUSINESS_STEP_MESSAGES.address };
  if (a.workday) return { field: "workday", message: a.workday };
  const email = a.officeEmail.trim();
  if (email && !EMAIL_RE.test(email)) {
    return { field: "officeEmail", message: BUSINESS_STEP_MESSAGES.officeEmail };
  }
  return null;
}
