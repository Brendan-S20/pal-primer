// The grandfathered renewal, for scripts/release-gate-test-mode.mjs: a
// subscription on the OLD prices ($10 seat, $29 Priority support, $49 AI
// Receptionist) renews on a Stripe test clock. Direct Stripe on purpose: no app
// code runs at renewal, so this is what proves the blocks and the new catalog
// leave an existing subscription's price alone.
export async function runRenewalCheck({ check, stripe, v, RUN, byKey, oldPrice, $ }) {
  await check(
    "grandfathered: OLD $10 seat (+$29 Priority, +$49 Receptionist) renews at its own price",
    async () => {
      const seat10 = oldPrice("plan_slug", "launch", 1000);
      const prio29 = oldPrice("addon_slug", "priority-support", 2900);
      const recep49 = oldPrice("addon_slug", "ai-receptionist", 4900);
      if (!seat10 || !prio29 || !recep49)
        return { pass: false, evidence: "old test prices not found" };
      const clock = await stripe.testHelpers.testClocks.create({
        frozen_time: Math.floor(Date.now() / 1000),
        name: `release gate ${RUN}`,
      });
      v.ledger.clocks.add(clock.id);
      const customer = await stripe.customers.create({
        test_clock: clock.id,
        payment_method: "pm_card_visa",
        invoice_settings: { default_payment_method: "pm_card_visa" },
        metadata: { release_gate: RUN },
      });
      v.ledger.customers.add(customer.id);
      const sub = await stripe.subscriptions.create({
        customer: customer.id,
        items: [
          { price: byKey("launch_base_monthly").id },
          { price: seat10.id, quantity: 1 },
          { price: prio29.id },
          { price: recep49.id },
        ],
        metadata: { release_gate: RUN },
      });
      const end = sub.items.data[0].current_period_end;
      await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: end + 3 * 3600 });
      for (let i = 0; i < 60; i++) {
        const c = await stripe.testHelpers.testClocks.retrieve(clock.id);
        if (c.status === "ready") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const invs = await stripe.invoices.list({ subscription: sub.id, limit: 10 });
      const renewal = invs.data.find((i) => i.billing_reason === "subscription_cycle");
      if (!renewal)
        return {
          pass: false,
          evidence: `no renewal invoice; reasons: ${invs.data.map((i) => i.billing_reason)}`,
        };
      const lines = await v.invoiceLines(renewal.id);
      const amt = (pid) => lines.find((l) => v.linePrice(l) === pid)?.amount;
      const ok =
        amt(seat10.id) === 1000 &&
        amt(prio29.id) === 2900 &&
        amt(recep49.id) === 4900 &&
        renewal.status === "paid";
      return {
        pass: ok,
        evidence: `${sub.id} on clock ${clock.id}: renewal ${renewal.id} (${renewal.status}) seat ${$(amt(seat10.id) ?? 0)} [${seat10.id}], Priority ${$(amt(prio29.id) ?? 0)}, Receptionist ${$(amt(recep49.id) ?? 0)}, total ${$(renewal.total)}`,
      };
    },
  );
}
