// NP-2, the LAUNCH20 founding offer, for scripts/release-gate-test-mode.mjs.
//
// Redemptions are real: 20 test subscriptions are created through the app's
// createPlanSubscription with the code and paid with pm_card_visa. They are
// spent on a STAND-IN LAUNCH20 (same coupon, max 20, first-time only) while the
// real test code is deactivated, so the real one is never used up. The finally
// block puts the real code back whatever happens.
export async function runFoundingChecks(ctx) {
  const {
    check,
    call,
    fx,
    v,
    billing,
    addons,
    founding,
    foundingServer,
    subscribeAndPay,
    track,
    RUN,
    daysFromNow,
    $,
  } = ctx;
  const { stripe } = v;

  const found = await stripe.promotionCodes.list({ code: "LAUNCH20", active: true, limit: 5 });
  const original = found.data[0];
  if (!original) {
    await check("NP-2 LAUNCH20 exists in test mode", async () => ({
      pass: false,
      evidence: "no active LAUNCH20",
    }));
    return;
  }
  const couponId = original.promotion?.coupon ?? original.coupon?.id;
  const trial = (label, plan, people = 1) =>
    fx.org({
      label,
      plan,
      people,
      plan_status: "trialing",
      billing_status: "trialing",
      trial_ends_at: daysFromNow(7),
    });
  const viewer = await trial("np2-viewer", "launch");
  const banner = async () => {
    foundingServer.forgetFoundingOffer();
    return (await call(founding.getFoundingOffer, viewer)).value;
  };
  let standIn = null;
  const redeemed = async () => (await stripe.promotionCodes.retrieve(standIn.id)).times_redeemed;

  try {
    await stripe.promotionCodes.update(original.id, { active: false });
    standIn = await stripe.promotionCodes.create({
      promotion: { type: "coupon", coupon: couponId },
      code: "LAUNCH20",
      max_redemptions: 20,
      restrictions: { first_time_transaction: true },
      metadata: { release_gate: RUN, stand_in_for: original.id },
    });

    await check("NP-2 live count starts at 20 of 20 (app getFoundingOffer)", async () => {
      const b = await banner();
      return {
        pass: b?.visible === true && b.left === 20,
        evidence: `stand-in ${standIn.id} on coupon ${couponId}; banner ${JSON.stringify(b)}`,
      };
    });

    let n = 0;
    // Redemption 1: Launch monthly with one extra person, then two add-ons.
    await check(
      "NP-2 LAUNCH20 discounts the base plan line only (Launch monthly + 1 seat + Priority + setup)",
      async () => {
        const o = await trial("np2-1", "launch", 2);
        const r = await call(billing.createPlanSubscription, o, {
          planId: await fx.planIdFor("launch"),
          interval: "month",
          promoCode: "LAUNCH20",
        });
        await track(o.orgId);
        if (!r.ok) return { pass: false, evidence: r.message };
        const atCreate = await redeemed();
        const sub = await v.pay(r.value.subscriptionId);
        const afterPay = await redeemed();
        n += 1;
        await call(billing.refreshBillingStatus, o);
        const first = await v.invoiceLines(
          typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice.id,
        );
        const prio = await call(addons.subscribePlatformAddon, o, {
          addonId: (await fx.addonIdFor("priority-support")).id,
        });
        const setup = await call(addons.subscribePlatformAddon, o, {
          addonId: (await fx.addonIdFor("developer-setup")).id,
        });
        const preview = await stripe.invoices.createPreview({ subscription: sub.id });
        const next = preview.lines.data;
        const keyOf = new Map(
          (
            await stripe.subscriptions.retrieve(sub.id, { expand: ["items.data.price"] })
          ).items.data.map((i) => [i.price.id, i.price.lookup_key]),
        );
        const describe = (lines) =>
          lines
            .map(
              (l) =>
                `${keyOf.get(v.linePrice(l)) ?? l.description} ${$(l.amount)} -${$(v.lineDiscount(l))}`,
            )
            .join("; ");
        const line = (lines, key) => lines.find((l) => keyOf.get(v.linePrice(l)) === key);
        const setupLine = next.find((l) => l.amount === 19900);
        const ok =
          r.value.promoApplied === "LAUNCH20" &&
          v.lineDiscount(line(first, "launch_base_monthly")) === 2370 &&
          v.lineDiscount(line(first, "launch_seat_monthly")) === 0 &&
          prio.ok &&
          setup.ok &&
          v.lineDiscount(line(next, "launch_base_monthly")) === 2370 &&
          v.lineDiscount(line(next, "launch_seat_monthly")) === 0 &&
          v.lineDiscount(line(next, "addon_priority_support")) === 0 &&
          !!setupLine &&
          v.lineDiscount(setupLine) === 0;
        return {
          pass: ok,
          evidence: `${sub.id}; redeemed at create ${atCreate}, after payment ${afterPay}; first invoice: ${describe(first)}; next invoice: ${describe(next)}`,
        };
      },
    );

    await check("NP-2 LAUNCH20 on yearly: base only (Growth yearly + 1 seat)", async () => {
      const o = await trial("np2-2", "growth", 6);
      const { created, sub } = await subscribeAndPay(o, "growth", "year", "LAUNCH20");
      n += 1;
      const lines = await v.invoiceLines(
        typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice.id,
      );
      const base = lines.find((l) => l.amount === 199000);
      const seat = lines.find((l) => l.amount === 15000);
      return {
        pass:
          created.promoApplied === "LAUNCH20" &&
          v.lineDiscount(base) === 59700 &&
          v.lineDiscount(seat) === 0,
        evidence: `${sub.id}: base ${$(base?.amount ?? 0)} -${$(v.lineDiscount(base))}, seat ${$(seat?.amount ?? 0)} -${$(v.lineDiscount(seat))}`,
      };
    });

    const counts = [];
    while (n < 20) {
      const o = await trial(`np2-${n + 1}`, "launch");
      const { created } = await subscribeAndPay(o, "launch", "month", "LAUNCH20");
      if (created.promoApplied !== "LAUNCH20")
        throw new Error(
          `redemption ${n + 1} was not applied: ${JSON.stringify(created.promoDropped)}`,
        );
      n += 1;
      if (n === 10 || n === 19)
        counts.push({ n, redeemed: await redeemed(), banner: await banner() });
    }
    counts.push({ n, redeemed: await redeemed(), banner: await banner() });

    await check("NP-2 the live count reads 20 minus redemptions", async () => {
      const ok = counts.every(
        (c) =>
          c.redeemed === c.n &&
          (c.n < 20
            ? c.banner?.visible && c.banner.left === 20 - c.n
            : c.banner?.visible === false),
      );
      return {
        pass: ok,
        evidence: counts
          .map(
            (c) =>
              `after ${c.n}: Stripe times_redeemed ${c.redeemed}, banner ${JSON.stringify(c.banner)}`,
          )
          .join("; "),
      };
    });

    await check("NP-2 redemption 21 is refused (app drops it, Stripe refuses it)", async () => {
      const o = await trial("np2-21", "launch");
      const r = await call(billing.createPlanSubscription, o, {
        planId: await fx.planIdFor("launch"),
        interval: "month",
        promoCode: "LAUNCH20",
      });
      await track(o.orgId);
      const sub = r.ok
        ? await stripe.subscriptions.retrieve(r.value.subscriptionId, {
            expand: ["items.data.discounts"],
          })
        : null;
      const discounted =
        !!sub &&
        ((sub.discounts ?? []).length > 0 ||
          sub.items.data.some((i) => (i.discounts ?? []).length > 0));
      const customer = await stripe.customers.create({ metadata: { release_gate: RUN } });
      v.ledger.customers.add(customer.id);
      let direct = "ACCEPTED";
      try {
        const s = await stripe.subscriptions.create({
          customer: customer.id,
          items: [
            {
              price: (await stripe.prices.list({ lookup_keys: ["launch_base_monthly"] })).data[0]
                .id,
              discounts: [{ promotion_code: standIn.id }],
            },
          ],
          payment_behavior: "default_incomplete",
        });
        direct = `ACCEPTED ${s.id}`;
      } catch (e) {
        direct = `refused: ${e.message}`;
      }
      const after = await stripe.promotionCodes.retrieve(standIn.id);
      return {
        pass:
          r.ok &&
          r.value.promoApplied == null &&
          !discounted &&
          /^refused/.test(direct) &&
          after.times_redeemed === 20,
        evidence: `app: promoApplied ${r.value?.promoApplied ?? null}, promoDropped ${JSON.stringify(r.value?.promoDropped ?? r.message)}, ${sub?.id} discounted=${discounted}; direct Stripe: ${direct}; times_redeemed ${after.times_redeemed}, active ${after.active}`,
      };
    });
  } finally {
    if (standIn)
      await stripe.promotionCodes.update(standIn.id, { active: false }).catch(() => undefined);
    await stripe.promotionCodes.update(original.id, { active: true });
    const back = await stripe.promotionCodes.retrieve(original.id);
    console.log(
      `      LAUNCH20 restored: ${back.id} active=${back.active} times_redeemed=${back.times_redeemed}/${back.max_redemptions}; stand-in ${standIn?.id ?? "-"} deactivated`,
    );
  }
}
