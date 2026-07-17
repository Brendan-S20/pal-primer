import { describe, expect, it } from "vitest";
import {
  netDaysSchema,
  graceDaysSchema,
  clientBillingSettingsSchema,
  NET_DAYS_MAX,
  GRACE_DAYS_MAX,
} from "@/lib/billing-settings";

// QA round 3, B9 + I11: net terms and grace period are validated server-side
// (the same schemas power updateAutomationSettings), with human-readable
// messages — never raw Zod defaults, never a silent clamp.
describe("net terms validation", () => {
  it("accepts sane whole-day values including the bounds", () => {
    for (const v of [0, 1, 15, 30, NET_DAYS_MAX]) {
      expect(netDaysSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects negative terms with a human message", () => {
    const r = netDaysSchema.safeParse(-1);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe("Payment terms can't be negative.");
    }
  });

  it("rejects terms beyond the upper bound with a human message", () => {
    const r = netDaysSchema.safeParse(NET_DAYS_MAX + 1);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toContain(`${NET_DAYS_MAX} days`);
    }
  });

  it("rejects fractional days with a whole-number message", () => {
    const r = netDaysSchema.safeParse(15.5);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe("Payment terms must be a whole number of days.");
    }
  });

  it("rejects a non-number and never leaks a raw type error", () => {
    const r = netDaysSchema.safeParse("30" as unknown as number);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe("Enter the payment terms as a number of days.");
    }
  });
});

describe("grace period validation", () => {
  it("accepts sane whole-day values including the bounds", () => {
    for (const v of [0, 3, GRACE_DAYS_MAX]) {
      expect(graceDaysSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects negative grace with a human message", () => {
    const r = graceDaysSchema.safeParse(-2);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe("The grace period can't be negative.");
    }
  });

  it("rejects grace beyond the upper bound with a human message", () => {
    const r = graceDaysSchema.safeParse(GRACE_DAYS_MAX + 5);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toContain(`${GRACE_DAYS_MAX} days`);
    }
  });

  it("rejects fractional grace days", () => {
    const r = graceDaysSchema.safeParse(2.5);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe("The grace period must be a whole number of days.");
    }
  });
});

// The Invoicing page and the Automation page each send only the fields they
// edit; the one owning fn patches just those. The shared schema must accept a
// partial client-billing payload (any subset of the trio) and still validate
// each field it does receive.
describe("client-billing settings (partial payload)", () => {
  it("accepts just the auto-invoice toggle", () => {
    expect(clientBillingSettingsSchema.safeParse({ autoInvoiceEnabled: true }).success).toBe(true);
  });

  it("accepts the full trio", () => {
    expect(
      clientBillingSettingsSchema.safeParse({
        autoInvoiceEnabled: true,
        invoiceNetDays: 30,
        invoiceGraceDays: 3,
      }).success,
    ).toBe(true);
  });

  it("accepts an empty patch (no-op save)", () => {
    expect(clientBillingSettingsSchema.safeParse({}).success).toBe(true);
  });

  it("still rejects an out-of-bounds field inside a partial payload", () => {
    const r = clientBillingSettingsSchema.safeParse({ invoiceGraceDays: -1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toBe("The grace period can't be negative.");
    }
  });
});
