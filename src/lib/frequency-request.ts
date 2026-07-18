// Parser for portal frequency-change requests filed as concerns (C4/G4
// deferred item). Mirrors hold-request.ts: the portal RPC writes a canonical,
// parseable message ("Frequency change requested: weekly → monthly
// (subscription <uuid>).") and the office Concerns page re-derives the
// structured request from it to offer a one-click apply.

export interface ParsedFrequencyRequest {
  subscriptionId: string;
  fromFrequency: string;
  toFrequency: string;
}

const PORTAL_FREQUENCIES = new Set(["weekly", "biweekly", "twice_weekly", "monthly"]);

export const FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  twice_weekly: "Twice a week",
  monthly: "Monthly",
  one_time: "One time",
  every_n_days: "Every few days",
};

export function frequencyLabel(value: string): string {
  return FREQUENCY_LABELS[value] ?? value.replace(/_/g, " ");
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
