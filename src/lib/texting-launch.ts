// #988 / #1032 follow-up: what of texting usage is switched on, in one place.
//
// Every text a business sends or receives is COUNTED (sms_usage_events, rolled
// up into sms_usage_periods) whatever this says. What this switch holds back
// is the part a business would feel: the monthly overage invoice item
// (sms-overage-billing.server.ts) and the monthly ceiling that stops automatic
// texts (sms-usage.server.ts, assertUnderTextingCeiling). Both turn on
// together or not at all.
//
// Why it is off, and why it is a constant rather than a setting: the
// managed-sms catalog row already carries the allowance (1,000 included,
// $10 per 500, ceiling 5 blocks), so without this the first business to go
// live on texting would be billed and capped on terms it was never shown.
// The owner warnings at 80% and 100%, the owner-set ceiling, the Settings
// meter and the approved terms wording have to ship first. A constant cannot
// be switched on by a missing env var, a database row or a deploy; turning it
// on is this one line, in a reviewed change.
export const TEXTING_USAGE_BILLING_LIVE = false;
