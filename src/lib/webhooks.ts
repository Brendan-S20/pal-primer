// Outbound webhooks: the part the settings page and the server share.
//
// The event list is the same nine names the migration's CHECK constraints
// allow (20260929080000). Adding an event is a change in three places — here,
// the CHECK on webhook_endpoints.events and webhook_deliveries.event_type, and
// a trigger that emits it — and
// tests/nothing-could-listen-for-a-completed-visit.test.ts fails if this list
// and the migration disagree.

export const WEBHOOK_EVENTS = [
  { type: "client.created", label: "A client is added" },
  { type: "visit.completed", label: "A visit is completed" },
  { type: "visit.skipped", label: "A visit is skipped" },
  { type: "invoice.created", label: "An invoice is created" },
  { type: "invoice.paid", label: "An invoice is paid" },
  { type: "payment.received", label: "A payment is received" },
  { type: "quote.accepted", label: "A quote is accepted" },
  { type: "quote.declined", label: "A quote is declined" },
  { type: "lead.created", label: "A lead comes in" },
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]["type"];

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = WEBHOOK_EVENTS.map((e) => e.type);

/** The event a "Send test event" press delivers. Not subscribable, and it
 *  never counts toward switching an endpoint off. */
export const WEBHOOK_TEST_EVENT = "webhook.test";

/** Enough for Zapier, Make, n8n and an in-house system with room to spare,
 *  and a ceiling on how much one tenant can make the worker send. */
export const MAX_WEBHOOK_ENDPOINTS = 10;

/** The request header carrying `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const WEBHOOK_SIGNATURE_HEADER = "HoundStack-Signature";

export function isWebhookEventType(s: string): s is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(s);
}
