// Real Postgres proof of the deposit rule when a stay is canceled (#411
// review, item 5). Refundable far enough ahead, kept as a cancellation fee
// inside the window, and the office can refund anyway. Skipped without
// TEST_SUPABASE_* env. No production credentials.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dbEnabled, insertRow, makeWalkOrg, type WalkOrg } from "../support/walk-db";

let org: WalkOrg;
let nightService: string;
const day = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A confirmed two-night stay starting `startIn` days from today, with a
 *  $100 deposit. */
async function booked(startIn: number) {
  const clientId = await insertRow(org.admin, "clients", {
    organization_id: org.orgId,
    display_name: "Deposit client",
    account_type: "residential",
    active: true,
  });
  const propertyId = await insertRow(org.admin, "properties", {
    organization_id: org.orgId,
    client_id: clientId,
    street: "5 Deposit St",
    city: "Austin",
    postal_code: "78701",
  });
  const petId = await insertRow(org.admin, "dogs", {
    organization_id: org.orgId,
    property_id: propertyId,
    name: "Bo",
    active: true,
  });
  const req = await org.admin.rpc("portal_request_stay", {
    _org_id: org.orgId,
    _client_id: clientId,
    _request_key: randomUUID(),
    _input: { propertyId, serviceId: nightService, startsOn: day(startIn), endsOn: day(startIn + 2), petIds: [petId] },
  });
  expect(req.error).toBeNull();
  const stayId = req.data as string;
  const confirmed = await org.owner.client.rpc("confirm_stay", { _stay_id: stayId, _deposit_cents: 10000 });
  expect(confirmed.error).toBeNull();
  const st = await org.admin.from("stays").select("invoice_id, deposit_invoice_id").eq("id", stayId).single();
  return { clientId, stayId, invoiceId: st.data!.invoice_id as string, depositId: st.data!.deposit_invoice_id as string };
}

async function invoice(id: string) {
  const r = await org.admin
    .from("invoices")
    .select("status, kind, total_cents, tax_cents, credit_applied_cents")
    .eq("id", id)
    .single();
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

async function credit(clientId: string) {
  const r = await org.admin.from("clients").select("credit_balance_cents").eq("id", clientId).single();
  return r.data?.credit_balance_cents;
}

const payDeposit = async (id: string) =>
  expect(
    (await org.admin.from("invoices").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", id))
      .error,
  ).toBeNull();

describe.skipIf(!dbEnabled)("a stay deposit when the stay is canceled", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Stay deposits");
    expect(
      (
        await org.admin
          .from("organizations")
          .update({ service_lines: ["pet_sitting"], sales_tax_rate_bps: 825 })
          .eq("id", org.orgId)
      ).error,
    ).toBeNull();
    nightService = await insertRow(org.admin, "services", {
      organization_id: org.orgId,
      name: "Overnight care",
      service_line: "pet_sitting",
      price_unit: "night",
      base_price_cents: 6000,
    });
  });
  afterAll(async () => {
    await org?.cleanup();
  });

  it("defaults to refundable up to 7 days before", async () => {
    const r = await org.admin.from("organizations").select("stay_deposit_refund_days").eq("id", org.orgId).single();
    expect(r.data?.stay_deposit_refund_days).toBe(7);
  });

  it("canceled 7 or more days ahead, an unpaid deposit is voided and nothing is charged", async () => {
    const s = await booked(7);
    const r = await org.owner.client.rpc("cancel_stay", { _stay_id: s.stayId });
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ deposit: "refunded", fee_invoice_id: null });
    expect((await invoice(s.depositId)).status).toBe("void");
    expect((await invoice(s.invoiceId)).status).toBe("void");
  });

  it("canceled later, an unpaid deposit becomes an untaxed cancellation fee", async () => {
    const s = await booked(3);
    const r = await org.owner.client.rpc("cancel_stay", { _stay_id: s.stayId });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ deposit: "kept" });
    const feeId = (r.data as any).fee_invoice_id as string;
    expect((await invoice(s.depositId)).status).toBe("void");
    expect((await invoice(s.invoiceId)).status).toBe("void");
    expect(await invoice(feeId)).toMatchObject({ status: "open", kind: "postpaid", total_cents: 10000, tax_cents: 0 });
    const lines = await org.admin.from("invoice_line_items").select("description, amount_cents").eq("invoice_id", feeId);
    expect(lines.data).toEqual([{ description: "Cancellation fee: Overnight care deposit", amount_cents: 10000 }]);
  });

  it("canceled later, a paid deposit pays the fee from the client's credit", async () => {
    const s = await booked(3);
    await payDeposit(s.depositId);
    expect(await credit(s.clientId)).toBe(10000);
    const r = await org.owner.client.rpc("cancel_stay", { _stay_id: s.stayId });
    expect(r.error).toBeNull();
    const feeId = (r.data as any).fee_invoice_id as string;
    expect(await invoice(feeId)).toMatchObject({ status: "paid", credit_applied_cents: 10000 });
    expect(await credit(s.clientId)).toBe(0);
  });

  it("the office can refund anyway", async () => {
    const s = await booked(3);
    await payDeposit(s.depositId);
    const r = await org.owner.client.rpc("cancel_stay", { _stay_id: s.stayId, _refund_deposit: true });
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ deposit: "refunded", fee_invoice_id: null });
    expect(await credit(s.clientId)).toBe(10000);
  });

  it("follows the business's setting, and a plain cancel applies it too", async () => {
    expect(
      (await org.admin.from("organizations").update({ stay_deposit_refund_days: 2 }).eq("id", org.orgId)).error,
    ).toBeNull();
    const s = await booked(3);
    const r = await org.owner.client.from("stays").update({ status: "canceled" }).eq("id", s.stayId);
    expect(r.error).toBeNull();
    expect((await invoice(s.depositId)).status).toBe("void");
    expect(
      (await org.admin.from("invoices").select("id").eq("client_id", s.clientId).eq("status", "open")).data,
    ).toEqual([]);
    expect(
      (await org.admin.from("organizations").update({ stay_deposit_refund_days: 366 }).eq("id", org.orgId)).error,
    ).not.toBeNull();
    expect(
      (await org.admin.from("organizations").update({ stay_deposit_refund_days: 7 }).eq("id", org.orgId)).error,
    ).toBeNull();
  });

  describe("when the deposit's credit was already spent", () => {
    /** What the client still has to pay: open and draft invoices, less the
     *  credit already applied to them. */
    async function owed(clientId: string) {
      const r = await org.admin
        .from("invoices")
        .select("total_cents, credit_applied_cents")
        .eq("client_id", clientId)
        .in("status", ["open", "draft"]);
      if (r.error) throw new Error(r.error.message);
      return r.data.reduce((n, i) => n + i.total_cents - i.credit_applied_cents, 0);
    }

    /** An invoice for other work, $100 unless said, open on the same client. */
    async function otherInvoice(clientId: string, cents = 10000) {
      return insertRow(org.admin, "invoices", {
        organization_id: org.orgId,
        client_id: clientId,
        status: "open",
        kind: "postpaid",
        period_start: day(-30),
        period_end: day(-1),
        subtotal_cents: cents,
        total_cents: cents,
        notes: "Walks",
      });
    }

    async function applyCredit(invoiceId: string, cents: number) {
      const r = await org.admin.rpc("apply_credit_to_invoice", { _invoice_id: invoiceId });
      expect(r.error).toBeNull();
      expect((r.data as any).applied_cents).toBe(cents);
    }

    async function cancel(stayId: string, refund?: boolean) {
      const r = await org.owner.client.rpc(
        "cancel_stay",
        refund === undefined ? { _stay_id: stayId } : { _stay_id: stayId, _refund_deposit: refund },
      );
      expect(r.error).toBeNull();
      return r.data as { deposit: string; fee_invoice_id: string | null };
    }

    // Two $60 nights at 8.25%: the stay invoice is $129.90.
    const STAY_TOTAL = 12990;

    it("spent on another invoice, a late cancel keeps the deposit once: the other invoice was paid with it", async () => {
      const s = await booked(3);
      await payDeposit(s.depositId);
      const other = await otherInvoice(s.clientId);
      await applyCredit(other, 10000);
      expect(await credit(s.clientId)).toBe(0);

      const r = await cancel(s.stayId);
      expect(r.deposit).toBe("kept");
      expect((await invoice(s.invoiceId)).status).toBe("void");
      expect((await invoice(other)).status).toBe("paid");
      // The client paid $100 once. It bought the $100 walks invoice, and the
      // business keeps $100 for the late cancel, so $100 is owed and no more.
      // The fee is that $100; the deposit itself is not billed again.
      const fee = await invoice(r.fee_invoice_id!);
      expect(fee).toMatchObject({ status: "open", total_cents: 10000, credit_applied_cents: 0 });
      expect(await owed(s.clientId)).toBe(10000);
      expect(await credit(s.clientId)).toBe(0);
      const notes = await org.admin.from("invoices").select("notes").eq("id", r.fee_invoice_id!).single();
      expect(notes.data?.notes).toMatch(/already applied/);
    });

    it("spent on another invoice, an early cancel gives nothing back a second time", async () => {
      const s = await booked(10);
      await payDeposit(s.depositId);
      const other = await otherInvoice(s.clientId);
      await applyCredit(other, 10000);

      const r = await cancel(s.stayId);
      expect(r).toEqual({ deposit: "refunded", fee_invoice_id: null });
      expect((await invoice(s.invoiceId)).status).toBe("void");
      expect((await invoice(other)).status).toBe("paid");
      // The refund already happened: it paid the walks invoice.
      expect(await credit(s.clientId)).toBe(0);
      expect(await owed(s.clientId)).toBe(0);
    });

    it("spent on another invoice, the office refunding anyway does not mint credit", async () => {
      const s = await booked(3);
      await payDeposit(s.depositId);
      await applyCredit(await otherInvoice(s.clientId), 10000);
      expect(await cancel(s.stayId, true)).toEqual({ deposit: "refunded", fee_invoice_id: null });
      expect(await credit(s.clientId)).toBe(0);
      expect(await owed(s.clientId)).toBe(0);
    });

    it("partly spent on another invoice, a late cancel bills only the part that is gone", async () => {
      const s = await booked(3);
      await payDeposit(s.depositId);
      const other = await otherInvoice(s.clientId, 4000);
      await applyCredit(other, 4000);

      const r = await cancel(s.stayId);
      expect(await invoice(r.fee_invoice_id!)).toMatchObject({
        status: "open",
        total_cents: 10000,
        credit_applied_cents: 6000,
      });
      expect(await owed(s.clientId)).toBe(4000);
      expect(await credit(s.clientId)).toBe(0);
    });

    it("applied to the stay invoice, a late cancel keeps the deposit and bills nothing", async () => {
      const s = await booked(3);
      await payDeposit(s.depositId);
      await applyCredit(s.invoiceId, 10000);
      expect(await owed(s.clientId)).toBe(STAY_TOTAL - 10000);

      const r = await cancel(s.stayId);
      expect(r.deposit).toBe("kept");
      expect(await invoice(s.invoiceId)).toMatchObject({ status: "void", credit_applied_cents: 0 });
      expect(await invoice(r.fee_invoice_id!)).toMatchObject({ status: "paid", credit_applied_cents: 10000 });
      const notes = await org.admin.from("invoices").select("notes").eq("id", r.fee_invoice_id!).single();
      expect(notes.data?.notes).not.toMatch(/already applied/);
      expect(await owed(s.clientId)).toBe(0);
      expect(await credit(s.clientId)).toBe(0);
    });

    it("applied to the stay invoice, an early cancel returns the deposit as credit once", async () => {
      const s = await booked(10);
      await payDeposit(s.depositId);
      await applyCredit(s.invoiceId, 10000);

      expect(await cancel(s.stayId)).toEqual({ deposit: "refunded", fee_invoice_id: null });
      expect(await invoice(s.invoiceId)).toMatchObject({ status: "void", credit_applied_cents: 0 });
      expect(await owed(s.clientId)).toBe(0);
      expect(await credit(s.clientId)).toBe(10000);
      const back = await org.admin
        .from("credit_ledger")
        .select("delta_cents")
        .eq("client_id", s.clientId)
        .gt("delta_cents", 0);
      // The deposit payment, and the one return from the voided stay invoice.
      expect(back.data?.map((e) => e.delta_cents).sort()).toEqual([10000, 10000]);
    });

    it("applied to a stay invoice paid in full, a late cancel credits the stay less the kept deposit", async () => {
      const s = await booked(3);
      await payDeposit(s.depositId);
      await applyCredit(s.invoiceId, 10000);
      await payDeposit(s.invoiceId); // the rest, in cash

      const r = await cancel(s.stayId);
      expect(r.deposit).toBe("kept");
      expect((await invoice(s.invoiceId)).status).toBe("paid");
      expect((await invoice(r.fee_invoice_id!)).status).toBe("paid");
      // Paid $129.90 in all, $100 kept.
      expect(await credit(s.clientId)).toBe(STAY_TOTAL - 10000);
      expect(await owed(s.clientId)).toBe(0);
    });

    it("applied to a stay invoice paid in full, an early cancel credits the stay once", async () => {
      const s = await booked(10);
      await payDeposit(s.depositId);
      await applyCredit(s.invoiceId, 10000);
      await payDeposit(s.invoiceId);

      expect(await cancel(s.stayId)).toEqual({ deposit: "refunded", fee_invoice_id: null });
      expect(await credit(s.clientId)).toBe(STAY_TOTAL);
      expect(await owed(s.clientId)).toBe(0);
    });
  });

  it("only the office cancels, and only once", async () => {
    const s = await booked(10);
    expect((await org.walker.client.rpc("cancel_stay", { _stay_id: s.stayId })).error).not.toBeNull();
    expect((await org.anon.rpc("cancel_stay", { _stay_id: s.stayId })).error).not.toBeNull();
    expect((await org.owner.client.rpc("cancel_stay", { _stay_id: s.stayId })).error).toBeNull();
    expect((await org.owner.client.rpc("cancel_stay", { _stay_id: s.stayId })).error?.message).toMatch(
      /already canceled/,
    );
  });
});
