// What a skipped visit says about why it was skipped, on the office's
// screens. Never blank: a "Skipped" with nothing beside it read, on a future
// stop, as a fault in the schedule (QA row 15), and the office cannot tell a
// skip nobody explained from a page that failed to load the reason.

const CODE_TEXT: Record<string, string> = {
  client_cancelled_late: "Client cancelled late",
  gate_locked: "Gate locked",
  dog_outside: "Dog outside",
  weather: "Weather",
  our_fault: "Our fault",
  access_blocked: "Access blocked",
  unsafe_conditions: "Unsafe conditions",
  customer_requested: "Customer requested",
  other: "Other",
};

export const NO_SKIP_REASON = "No reason recorded";

export function skipReasonText(reason?: string | null, code?: string | null): string {
  const typed = (reason ?? "").trim();
  if (typed) return typed;
  if (code && CODE_TEXT[code]) return CODE_TEXT[code];
  return NO_SKIP_REASON;
}
