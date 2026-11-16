// ── What /setup step 2 still needs before it can save (#946 follow-up) ─────
//
// Step 2 said why it refused a save beside Save (#881), role=alert. But the
// sentence was written once, on the press, into the same state a failed
// server save used, and nothing took it away until the next press. So an
// owner refused for the first cleanup who then picked Off saw "Choose whether
// new clients pay for a first cleanup." stay on screen under a choice that
// was now made, while the "Choose one" nudge above it had already gone.
//
// Step 1 has read its problem live since #942 (lib/setup-business-problem):
// shown from the first refused press on, and recomputed from the form on
// every render after that, so fixing the field is what takes the sentence
// away. Step 2 now does the same with this function. A save the SERVER
// refused is a different thing, and stays as it was: kept beside Save until
// the next try.
//
// The order is the order the checks always ran in, which is the order of the
// form. Office-only, so English.

import { setupAreaCenterProblem, type SetupAreaPin } from "@/lib/setup-area-center";
import { setupFirstCleanupCents, type SetupFirstCleanup } from "@/lib/setup-pricing";

export type ServiceAreaStepField =
  "price" | "zip" | "firstCleanup" | "firstCleanupPrice" | "schedule";

export type ServiceAreaStepProblem = { field: ServiceAreaStepField; message: string };

export const SERVICE_AREA_STEP_MESSAGES = {
  price: "Enter what you charge per visit.",
  firstCleanup: "Choose whether new clients pay for a first cleanup.",
  firstCleanupPrice: "Enter what a first cleanup costs, or choose Off.",
  schedule: "Each schedule needs a number between 0.1 and 10.",
} as const;

/** The first thing step 2 still needs, or null when it can save. */
export function serviceAreaStepProblem(a: {
  price: string;
  zip: string;
  pin: SetupAreaPin | null;
  /** First cleanup is tiered on Zones, so the step does not ask. */
  tiered: boolean;
  firstCleanup: SetupFirstCleanup | null;
  firstCleanupPrice: string;
  /** setupMultipliers answered with a full set. */
  schedulesOk: boolean;
}): ServiceAreaStepProblem | null {
  if (!(parseFloat(a.price) > 0)) {
    return { field: "price", message: SERVICE_AREA_STEP_MESSAGES.price };
  }
  const center = setupAreaCenterProblem({ zip: a.zip, pin: a.pin });
  if (center) return { field: "zip", message: center };
  if (!a.tiered && !a.firstCleanup) {
    return { field: "firstCleanup", message: SERVICE_AREA_STEP_MESSAGES.firstCleanup };
  }
  if (
    !a.tiered &&
    a.firstCleanup &&
    setupFirstCleanupCents(a.firstCleanup, a.firstCleanupPrice) == null
  ) {
    return { field: "firstCleanupPrice", message: SERVICE_AREA_STEP_MESSAGES.firstCleanupPrice };
  }
  if (!a.schedulesOk) return { field: "schedule", message: SERVICE_AREA_STEP_MESSAGES.schedule };
  return null;
}
