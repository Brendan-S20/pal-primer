// A tip the office is handed with cash or a check (#653, F-09).
//
// Card tips have been taken on the pay screen since 20260929030000. A
// customer who handed the tech, or the office, $10 in cash had nowhere to
// put it: Record payment took the invoice amount only. Now it takes a tip
// beside it, under the one rule every tip follows (a-customer-could-not-
// leave-a-tip): `payments.tip_cents` sits beside `amount_cents`, never inside
// it. So the tip is not applied to the invoice, is not revenue, and shows in
// the Tips received report and on the technician's timesheet like a card tip.

import { TIP_CUSTOM_MAX_CENTS } from "@/lib/tips";

export type OfficeTipRequest = {
  ids: readonly string[];
  method?: string;
  fieldCollectionId?: string;
  tipCents?: number;
};

/** Why this tip cannot be recorded, or null. One invoice, cash or check, not
 *  a field collection (the tech's collection form has no tip). */
export function officeTipProblem(r: OfficeTipRequest): string | null {
  if (r.tipCents == null) return null;
  if (!Number.isInteger(r.tipCents) || r.tipCents < 1 || r.tipCents > TIP_CUSTOM_MAX_CENTS) {
    return "A tip is from $0.01 to $1,000.00.";
  }
  if (r.ids.length !== 1 || r.fieldCollectionId) {
    return "A tip can only be recorded with one invoice's payment.";
  }
  if (r.method !== "cash" && r.method !== "check") {
    return "A tip can be recorded with cash or a check.";
  }
  return null;
}
