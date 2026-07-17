import { z } from "zod";

// Shared client-billing (invoicing) settings contract. ONE definition of the
// net-terms + grace-period bounds and their human-readable validation messages
// (QA round 3, B9 + I11), imported by the server fn that owns these org columns
// (updateAutomationSettings) and mirrored in the UI copy so the client and
// server agree. These are the workspace's client-invoicing rules, distinct from
// HoundStack's own platform subscription ("Settings > Billing").

export const NET_DAYS_MIN = 0;
export const NET_DAYS_MAX = 90;
export const GRACE_DAYS_MIN = 0;
export const GRACE_DAYS_MAX = 30;

// Net terms: how many days after an invoice is issued it's due. Drives
// invoice due_on via the tg_set_invoice_due_on trigger (round 8).
export const netDaysSchema = z
  .number({
    required_error: "Enter the payment terms as a number of days.",
    invalid_type_error: "Enter the payment terms as a number of days.",
  })
  .int("Payment terms must be a whole number of days.")
  .min(NET_DAYS_MIN, "Payment terms can't be negative.")
  .max(NET_DAYS_MAX, `Payment terms can't be more than ${NET_DAYS_MAX} days.`);

// Grace period: how many days an auto-generated invoice waits (held) before it
// auto-sends, so staff can review, edit, void, or send it now first.
export const graceDaysSchema = z
  .number({
    required_error: "Enter the grace period as a number of days.",
    invalid_type_error: "Enter the grace period as a number of days.",
  })
  .int("The grace period must be a whole number of days.")
  .min(GRACE_DAYS_MIN, "The grace period can't be negative.")
  .max(GRACE_DAYS_MAX, `The grace period can't be more than ${GRACE_DAYS_MAX} days.`);

// The three fields the Invoicing settings page owns/edits. All optional so a
// caller (either the Invoicing page or the Automation page) can send just the
// fields it touches; updateAutomationSettings patches only what's provided.
export const clientBillingSettingsSchema = z.object({
  autoInvoiceEnabled: z.boolean().optional(),
  invoiceNetDays: netDaysSchema.optional(),
  invoiceGraceDays: graceDaysSchema.optional(),
});

export type ClientBillingSettingsInput = z.infer<typeof clientBillingSettingsSchema>;
