/** Revenue by service on /reports (#410). Pure, so the server function and
 *  the tests read one copy of the grouping.
 *
 *  An invoice line belongs to a service through its visit (visits.service_id)
 *  or, for a line with no visit (a prepaid plan's line), through its plan
 *  (subscriptions.service_id). A line with neither, or whose service cannot
 *  be read, is "Other charges": a surcharge, an add-on, a hand-typed line.
 *  Lines are dated by their invoice, on the same accrual rule as Billed
 *  (billedDay), so the table and the Billed tile count the same invoices. */

import { billedDay } from "@/lib/ar";
import { serviceLinesOrDefault } from "@/lib/service-lines";

export type RevenueLine = {
  invoice_id: string;
  amount_cents: number;
  visit_id: string | null;
  subscription_id: string | null;
};

export type RevenueInvoice = {
  id: string;
  status: string | null;
  issued_at: string | null;
  /** A linked stay deposit bills nothing of its own (billedDay). */
  deposit_for_invoice_id?: string | null;
};

export type RevenueRow = { serviceId: string | null; name: string; cents: number; lines: number };

export const OTHER_CHARGES = "Other charges";

export function revenueByService(input: {
  lines: readonly RevenueLine[];
  invoices: readonly RevenueInvoice[];
  from: string;
  to: string;
  timezone: string;
  visitService: ReadonlyMap<string, string | null>;
  subscriptionService: ReadonlyMap<string, string | null>;
  serviceName: ReadonlyMap<string, string>;
}): RevenueRow[] {
  const inRange = new Set(
    input.invoices
      .filter((inv) => {
        const day = billedDay(inv, input.timezone);
        return !!day && day >= input.from && day <= input.to;
      })
      .map((inv) => inv.id),
  );
  const rows = new Map<string, RevenueRow>();
  for (const l of input.lines) {
    if (!inRange.has(l.invoice_id)) continue;
    const sid =
      (l.visit_id ? input.visitService.get(l.visit_id) : null) ??
      (l.subscription_id ? input.subscriptionService.get(l.subscription_id) : null) ??
      null;
    const name = (sid && input.serviceName.get(sid)) || OTHER_CHARGES;
    const key = sid && name !== OTHER_CHARGES ? sid : OTHER_CHARGES;
    const row = rows.get(key) ?? {
      serviceId: key === OTHER_CHARGES ? null : sid,
      name,
      cents: 0,
      lines: 0,
    };
    row.cents += l.amount_cents ?? 0;
    row.lines += 1;
    rows.set(key, row);
  }
  // Biggest first; Other charges last whatever its size.
  return [...rows.values()].sort((a, b) =>
    a.serviceId === null ? 1 : b.serviceId === null ? -1 : b.cents - a.cents,
  );
}

/** Shown only when it can say something a pet-waste-only report does not:
 *  the business sells more than one service, or runs a line other than pet
 *  waste. A pet-waste-only business's report is unchanged. */
export function showsRevenueByService(serviceCount: number, rawLines: unknown): boolean {
  if (serviceCount > 1) return true;
  return serviceLinesOrDefault(rawLines).some((l) => l !== "pet_waste");
}
