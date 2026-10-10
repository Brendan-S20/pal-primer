// NP-2, the LAUNCH20 founding offer, for scripts/release-gate-test-mode.mjs.
//
// Owner, 2026-10-10: a founding place is used only by an account that PAID.
// Stripe counts a redemption when the unpaid subscription is created, so the
// app counts paid accounts itself (founding_accounts) and Stripe's
// max_redemptions is a backstop set higher (PROMO_MAX, 30).
//
// Redemptions are real: test subscriptions are created through the app's
// createPlanSubscription with the code and paid with pm_card_visa, then the app's
// refreshBillingStatus is called, which is what the payment form does next and
// what takes the place (no webhook reaches a local stack). They are spent on a
// STAND-IN LAUNCH20 (same coupon, the backstop cap, first-time only) while the
// real test code is deactivated, so the real one is never used up. The finally
// block puts the real code back whatever happens.
import { PROMO_MAX } from "../stripe-test-setup.mjs";

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
  /** Places taken: accounts that PAID with the code. */
  const paid = async () => {
    const { count, error } = await fx.admin
      .from("founding_accounts")
      .select("organization_id", { count: "exact", head: true })
      .not("place", "is", null);
    if (error) throw new Error(`founding_accounts: ${error.message}`);
    return count ?? 0;
  };
  const placeOf = async (orgId) =>
    (
      await fx.admin
        .from("founding_accounts")
        .select("place, discount_removed_at")
        .eq("organization_id", orgId)
        .maybeSingle()
    ).data;
  let standIn = null;
  const redeemed = async () => (await stripe.promotionCodes.retrieve(standIn.id)).times_redeemed;
  const invoiceId = (sub) =>
    typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice.id;

  try {
    await stripe.promotionCodes.update(original.id, { active: false });
    standIn = await stripe.promotionCodes.create({
      promotion: { type: "coupon", coupon: couponId },
      code: "LAUNCH20",
      max_redemptions: PROMO_MAX,
      restrictions: { first_time_transaction: true },
      metadata: { release_gate: RUN, stand_in_for: original.id },
    });

    await check("NP-2 live count starts at 20 of 20 (app getFoundingOffer)", async () => {
      const b = await banner();
      const p = await paid();
      return {
        pass: b?.visible === true && b.left === 20 && p === 0,
        evidence: `stand-in ${standIn.id} on coupon ${couponId}, max_redemptions ${standIn.max_redemptions}; paid founding accounts ${p}; banner ${JSON.stringify(b)}`,
      };
    });

    await check(
      "NP-2 an abandoned checkout takes no place (Stripe counts it, the app does not)",
      async () => {
        const o = await trial("np2-abandoned", "launch");
        const before = await redeemed();
        const r = await call(billing.createPlanSubscription, o, {
          planId: await fx.planIdFor("launch"),
          interval: "month",
          promoCode: "LAUNCH20",
        });
        await track(o.orgId);
        if (!r.ok) return { pass: false, evidence: r.message };
        // What the payment form would call; the subscription is still unpaid.
        await call(billing.refreshBillingStatus, o);
        const sub = await stripe.subscriptions.retrieve(r.value.subscriptionId);
        const after = await redeemed();
        const p = await paid();
        const row = await placeOf(o.orgId);
        const b = await banner();
        return {
          pass:
            r.value.promoApplied === "LAUNCH20" &&
            sub.status === "incomplete" &&
            after === before + 1 &&
            p === 0 &&
            !row &&
            b?.visible === true &&
            b.left === 20,
          evidence: `${sub.id} ${sub.status}; Stripe times_redeemed ${before}->${after}; paid founding accounts ${p}; founding row ${JSON.stringify(row)}; banner ${JSON.stringify(b)}`,
        };
      },
    );

    let n = 0;
    // Paid 1: Launch monthly with one extra person, then two add-ons.
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
        const paidBefore = await paid();
        const sub = await v.pay(r.value.subscriptionId);
        await call(billing.refreshBillingStatus, o);
        n += 1;
        const row = await placeOf(o.orgId);
        const paidAfter = await paid();
        const first = await v.invoiceLines(invoiceId(sub));
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
          paidBefore === 0 &&
          paidAfter === 1 &&
          row?.place === 1 &&
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
          evidence: `${sub.id}; Stripe times_redeemed at create ${atCreate}; paid founding accounts ${paidBefore}->${paidAfter}, place ${row?.place ?? null}; first invoice: ${describe(first)}; next invoice: ${describe(next)}`,
        };
      },
    );

    await check("NP-2 LAUNCH20 on yearly: base only (Growth yearly + 1 seat)", async () => {
      const o = await trial("np2-2", "growth", 6);
      const { created, sub } = await subscribeAndPay(o, "growth", "year", "LAUNCH20");
      n += 1;
      const lines = await v.invoiceLines(invoiceId(sub));
      const base = lines.find((l) => l.amount === 199000);
      const seat = lines.find((l) => l.amount === 15000);
      const row = await placeOf(o.orgId);
      return {
        pass:
          created.promoApplied === "LAUNCH20" &&
          row?.place === 2 &&
          v.lineDiscount(base) === 59700 &&
          v.lineDiscount(seat) === 0,
        evidence: `${sub.id}: base ${$(base?.amount ?? 0)} -${$(v.lineDiscount(base))}, seat ${$(seat?.amount ?? 0)} -${$(v.lineDiscount(seat))}; place ${row?.place ?? null}`,
      };
    });

    const counts = [];
    const snap = async () =>
      counts.push({ n, paid: await paid(), redeemed: await redeemed(), banner: await banner() });
    while (n < 19) {
      const o = await trial(`np2-${n + 1}`, "launch");
      const { created } = await subscribeAndPay(o, "launch", "month", "LAUNCH20");
      if (created.promoApplied !== "LAUNCH20")
        throw new Error(
          `redemption ${n + 1} was not applied: ${JSON.stringify(created.promoDropped)}`,
        );
      n += 1;
      if (n === 10) await snap();
    }
    await snap();

    // A checkout STARTED while 19 have paid (so the code is applied), and paid
    // only after the 20th: the race the owner's rule leaves open.
    const late = await trial("np2-late", "launch");
    const lateStart = await call(billing.createPlanSubscription, late, {
      planId: await fx.planIdFor("launch"),
      interval: "month",
      promoCode: "LAUNCH20",
    });
    await track(late.orgId);

    {
      const o = await trial("np2-20", "launch");
      const { created } = await subscribeAndPay(o, "launch", "month", "LAUNCH20");
      if (created.promoApplied !== "LAUNCH20")
        throw new Error(`redemption 20 was not applied: ${JSON.stringify(created.promoDropped)}`);
      n += 1;
    }
    await snap();

    await check("NP-2 the live count reads 20 minus PAID accounts, not Stripe's redemptions", async () => {
      const ok = counts.every(
        (c) =>
          c.paid === c.n &&
          c.redeemed > c.paid &&
          (c.n < 20 ? c.banner?.visible && c.banner.left === 20 - c.n : c.banner?.visible === false),
      );
      return {
        pass: ok,
        evidence: counts
          .map(
            (c) =>
              `after ${c.n} paid: founding_accounts ${c.paid}, Stripe times_redeemed ${c.redeemed}, banner ${JSON.stringify(c.banner)}`,
          )
          .join("; "),
      };
    });

    await check("NP-2 at 20 paid, checkout applies no discount (app refuses; Stripe's backstop is higher)", async () => {
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
      const after = await stripe.promotionCodes.retrieve(standIn.id);
      return {
        pass:
          r.ok &&
          r.value.promoApplied == null &&
          r.value.promoDropped?.detail === "All 20 founding places have been taken." &&
          !discounted,
        evidence: `app: promoApplied ${r.value?.promoApplied ?? null}, promoDropped ${JSON.stringify(r.value?.promoDropped ?? r.message)}, ${sub?.id} discounted=${discounted}; Stripe stand-in times_redeemed ${after.times_redeemed}/${after.max_redemptions} (the backstop, not reached)`,
      };
    });

    await check(
      "NP-2 a checkout started at 19 and paid after the 20th gets no place, and its discount comes off",
      async () => {
        if (!lateStart.ok || lateStart.value.promoApplied !== "LAUNCH20")
          return { pass: false, evidence: `late checkout: ${JSON.stringify(lateStart.value ?? lateStart.message)}` };
        const sub = await v.pay(lateStart.value.subscriptionId);
        await call(billing.refreshBillingStatus, late);
        const row = await placeOf(late.orgId);
        const p = await paid();
        const now = await stripe.subscriptions.retrieve(sub.id, { expand: ["items.data.price"] });
        const itemDiscounts = now.items.data.reduce((a, i) => a + (i.discounts ?? []).length, 0);
        const first = await v.invoiceLines(invoiceId(sub));
        const preview = await stripe.invoices.createPreview({ subscription: sub.id });
        const nextBase = preview.lines.data.find((l) => l.amount === 7900);
        return {
          pass:
            !!row &&
            row.place === null &&
            !!row.discount_removed_at &&
            p === 20 &&
            itemDiscounts === 0 &&
            now.metadata?.founding_over_limit === "LAUNCH20" &&
            !!nextBase &&
            v.lineDiscount(nextBase) === 0,
          evidence: `${sub.id}: founding row ${JSON.stringify(row)}; paid founding accounts ${p}; item discounts now ${itemDiscounts}; metadata ${JSON.stringify(now.metadata)}; first invoice discount ${$(first.reduce((a, l) => a + v.lineDiscount(l), 0))} (already charged); next invoice base ${$(nextBase?.amount ?? 0)} -${$(v.lineDiscount(nextBase ?? {}))}`,
        };
      },
    );
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
