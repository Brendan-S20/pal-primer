// Parser for portal frequency-change requests filed as concerns (C4/G4
// deferred item). Mirrors hold-request.ts: the portal RPC writes a canonical,
// parseable message ("Frequency change requested: weekly → monthly
// (subscription <uuid>).") and the office Concerns page re-derives the
// structured request from it to offer a one-click apply.

import { formatWeekdaySet } from "@/lib/weekday-set";

export interface ParsedFrequencyRequest {
  subscriptionId: string;
  fromFrequency: string;
  toFrequency: string;
}

/** The four cadences a client can self-serve request from the portal. */
export const PORTAL_FREQUENCY_VALUES = ["weekly", "biweekly", "twice_weekly", "monthly"] as const;
const PORTAL_FREQUENCIES = new Set<string>(PORTAL_FREQUENCY_VALUES);

/** Canonical frequency labels (I3: one label map — the portal plan row, the
 * portal account tab, public signup, and the office Concerns page all read
 * from here instead of carrying drifting local copies). */
export const FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  twice_weekly: "Twice weekly",
  monthly: "Monthly",
  one_time: "One time",
  every_n_days: "Every few days",
  // The two `addon_frequency` values that no service plan uses. They live here
  // because the portal's active-add-on row renders a cadence off the SAME
  // helper as the plan row, and an unmapped value falls through to the
  // de-underscored raw string — so a quarterly add-on read "$35.00 · quarterly"
  // in a list where everything else was capitalised. Cheaper to complete the
  // map than to give add-ons a second one that will drift from this.
  quarterly: "Quarterly",
  yearly: "Yearly",
};

export function frequencyLabel(value: string): string {
  return FREQUENCY_LABELS[value] ?? value.replace(/_/g, " ");
}

/** How a plan's cadence reads to a client: its days when it runs on a
 *  weekday set ("Mon, Wed, Fri", "Mon–Fri"; subscriptions.weekdays, the
 *  catalog), else its frequency's label as before. The portal is English. */
export function cadenceLabel(
  frequency: string | null | undefined,
  weekdays?: readonly number[] | null,
): string {
  if (weekdays && weekdays.length > 0) return formatWeekdaySet(weekdays, "en-US");
  return frequency ? frequencyLabel(frequency) : "";
}

const REQUEST_RE =
  /frequency change requested:\s*(\w+)\s*(?:→|->)\s*(\w+)\s*\(subscription\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i;

export function parseFrequencyRequest(message: string | null | undefined): ParsedFrequencyRequest | null {
  if (!message) return null;
  const m = REQUEST_RE.exec(message);
  if (!m) return null;
  const [, from, to, subscriptionId] = m;
  const fromFrequency = from.toLowerCase();
  const toFrequency = to.toLowerCase();
  // The portal can only request the four self-serve frequencies; anything else
  // in a message is not a well-formed request.
  if (!PORTAL_FREQUENCIES.has(toFrequency)) return null;
  if (fromFrequency === toFrequency) return null;
  return { subscriptionId, fromFrequency, toFrequency };
}
