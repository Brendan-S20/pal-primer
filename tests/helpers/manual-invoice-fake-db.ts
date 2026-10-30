// A fake of exactly the Supabase chain insertManualInvoice walks, so the
// sales-tax tests can ask what it WRITES without a database: the organization's
// terms and rate, the client's exemption, the invoice row, its lines.
//
// Not a general fake. Anything it is asked that it was not built for throws,
// so a change to the path shows up here as a loud failure rather than a quiet
// `undefined` that happens to pass.

export type FakeDbState = {
  org: {
    invoice_net_days?: number | null;
    timezone?: string | null;
    sales_tax_rate_bps?: number | null;
    sales_tax_label?: string | null;
  };
  client: { tax_exempt?: boolean | null } | null;
  inserted: { invoices: Record<string, unknown>[]; lines: Record<string, unknown>[] };
};

export function manualInvoiceFakeDb(state: FakeDbState) {
  const single = (data: unknown) => ({
    single: async () => ({ data, error: null }),
    maybeSingle: async () => ({ data, error: null }),
  });
  return {
    // create_manual_invoice: the invoice and its lines in one transaction.
    async rpc(
      fn: string,
      args: { _invoice: Record<string, unknown>; _lines: Record<string, unknown>[] },
    ) {
      if (fn !== "create_manual_invoice") {
        throw new Error(`manualInvoiceFakeDb was not built to answer rpc ${fn}`);
      }
      state.inserted.invoices.push(args._invoice);
      state.inserted.lines.push(...args._lines);
      return { data: "11111111-1111-4111-8111-111111111111", error: null };
    },
    from(table: string) {
      if (table === "organizations") {
        return { select: () => ({ eq: () => single(state.org) }) };
      }
      if (table === "clients") {
        return { select: () => ({ eq: () => single(state.client) }) };
      }
      if (table === "invoices") {
        return {
          // invoiceRef, for the activity summary.
          select: () => ({ eq: () => single({ number: 1042 }) }),
        };
      }
      throw new Error(`manualInvoiceFakeDb was not built to answer ${table}`);
    },
  };
}

export function freshState(over: Partial<FakeDbState> = {}): FakeDbState {
  return {
    org: {
      invoice_net_days: 15,
      timezone: "America/Chicago",
      sales_tax_rate_bps: 0,
      sales_tax_label: "Sales tax",
    },
    client: { tax_exempt: false },
    inserted: { invoices: [], lines: [] },
    ...over,
  };
}
