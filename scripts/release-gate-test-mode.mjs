#!/usr/bin/env node
// The Oct 9 release gate, in Stripe TEST mode against a PRIVATE local Supabase.
//
//   STRIPE_SECRET_KEY=<test key> node scripts/release-gate-test-mode.mjs
//
// Prints one PASS/FAIL line per check, then cleans up every Stripe object it
// made (customers, their subscriptions, test clocks). It keeps the catalog, the
// `founding-30-plan-only` coupon and LAUNCH20.
//
// It refuses a live key, a non-local database, and the shared local stacks
// (54421-54427, 545xx, 543xx): see scripts/release-gate/harness.mjs, which also
// explains how the app's own server functions are called from node. Where a
// check calls the app, it says so; where it calls Stripe directly (renewal on a
// test clock, a direct redemption attempt), it says that too.
//
// LAUNCH20 has max_redemptions 20 and a redemption cannot be undone. To prove
// the cut-off without spending the real test code, the run deactivates it,
// creates a stand-in LAUNCH20 on the same coupon with the same restrictions,
// redeems that 20 times, then deactivates the stand-in and reactivates the
// original (in a finally block, so a crash still restores it).
import {
  RUN,
  ROOT,
  appLoader,
  call,
  daysFromNow,
  gate,
  loadConfig,
  makeFixtures,
  makeVerifier,
  redact,
  sourceText,
} from "./release-gate/harness.mjs";

const cfg = loadConfig();
const load = appLoader();
const results = [];
function report(id, pass, evidence) {
  results.push({ id, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${redact(evidence)}`);
}
async function check(id, fn) {
  try {
    const r = await fn();
    report(id, r.pass, r.evidence);
  } catch (e) {
    report(id, false, `threw: ${e.message}`);
  }
}

const billing = await load("src/lib/billing.functions.ts");
const addons = await load("src/lib/platform-addons.functions.ts");
const users = await load("src/lib/users.functions.ts");
const founding = await load("src/lib/founding-offer.functions.ts");
const foundingServer = await load("src/lib/founding-offer.server.ts");
const lockServer = await load("src/lib/account-lock.server.ts");
const exporter = await load("src/lib/account-export.functions.ts");
const deletion = await load("src/lib/account-deletion.server.ts");
const priceCatalog = await load("src/lib/stripe-price-catalog.server.ts");
const lookupKeys = await load("src/lib/stripe-lookup-keys.ts");
const { STRIPE_API_VERSION } = await load("src/lib/stripe-client.server.ts");

const fx = makeFixtures(cfg);
const v = makeVerifier(cfg, STRIPE_API_VERSION);
const { stripe } = v;
const $ = (c) => `$${(c / 100).toFixed(2)}`;
const planId = (slug) => fx.planIdFor(slug);

console.log(`release gate ${RUN}: Stripe TEST, database ${cfg.url}`);

/** Remember the customer the app made for an org, for cleanup. */
async function track(orgId) {
  const { data } = await fx.admin
    .from("organizations")
    .select("stripe_customer_id")
    .eq("id", orgId)
    .single();
  if (data?.stripe_customer_id) v.ledger.customers.add(data.stripe_customer_id);
}

/** App path: createPlanSubscription, then pay with pm_card_visa, then refreshBillingStatus. */
async function subscribeAndPay(o, plan, interval, promoCode) {
  const r = await call(billing.createPlanSubscription, o, {
    planId: await planId(plan),
    interval,
    promoCode,
  });
  await track(o.orgId);
  if (!r.ok) throw new Error(`createPlanSubscription: ${r.message}`);
  const sub = await v.pay(r.value.subscriptionId);
  const refreshed = await call(billing.refreshBillingStatus, o);
  if (!refreshed.ok) throw new Error(`refreshBillingStatus: ${refreshed.message}`);
  return { created: r.value, sub };
}

// ── Harness self-check: the Stripe counter is wired, so a zero means zero ──
await check("harness: the app's Stripe client is counted", async () => {
  const o = await fx.org({
    label: "selfcheck",
    plan: "launch",
    plan_status: "trialing",
    billing_status: "trialing",
    trial_ends_at: daysFromNow(10),
  });
  const r = await call(founding.getFoundingOffer, o);
  return {
    pass: r.ok && r.stripeClients === 1 && r.stripeRequests >= 1,
    evidence: `getFoundingOffer made ${r.stripeClients} client(s), ${r.stripeRequests} request(s)`,
  };
});

// ── B-P0: purchase blocks ─────────────────────────────────────────────────
const HELD = [
  "ai-receptionist",
  "managed-sms",
  "white-label",
  "white-label-portal",
  "white-label-emails",
];
const paidLaunch = await fx.org({
  label: "bp0",
  plan: "launch",
  plan_status: "active",
  billing_status: "active",
  stripe_subscription_id: `sub_${RUN}_never_called`,
});
for (const worst of [false, true]) {
  for (const slug of HELD) {
    await check(
      `B-P0 held add-on refused before Stripe: ${slug}${worst ? " (row flipped to active)" : ""}`,
      async () => {
        const addon = await fx.addonIdFor(slug);
        if (worst)
          await fx.admin
            .from("platform_addons")
            .update({ status: "active", is_active: true })
            .eq("id", addon.id);
        try {
          const before = await fx.count("org_platform_addons", paidLaunch.orgId);
          const r = await call(addons.subscribePlatformAddon, paidLaunch, { addonId: addon.id });
          const after = await fx.count("org_platform_addons", paidLaunch.orgId);
          return {
            pass: !r.ok && r.stripeClients === 0 && r.stripeRequests === 0 && after === before,
            evidence: `app subscribePlatformAddon (row ${worst ? "active" : addon.status}): "${r.message ?? "ACCEPTED"}", Stripe clients ${r.stripeClients}, requests ${r.stripeRequests}, org_platform_addons rows ${before}->${after}`,
          };
        } finally {
          if (worst)
            await fx.admin
              .from("platform_addons")
              .update({ status: addon.status, is_active: addon.is_active })
              .eq("id", addon.id);
        }
      },
    );
  }
}

await check("B-P0 Priority support refused on Growth before Stripe (NP-3)", async () => {
  const g = await fx.org({
    label: "bp0g",
    plan: "growth",
    plan_status: "active",
    billing_status: "active",
    stripe_subscription_id: `sub_${RUN}_growth_never_called`,
  });
  const r = await call(addons.subscribePlatformAddon, g, {
    addonId: (await fx.addonIdFor("priority-support")).id,
  });
  return {
    pass: !r.ok && r.stripeRequests === 0,
    evidence: `"${r.message}", Stripe requests ${r.stripeRequests}`,
  };
});

await check("B-P0 an owner cannot grant themselves an add-on (RLS, #368)", async () => {
  const addon = await fx.addonIdFor("ai-receptionist");
  const db = paidLaunch.client;
  const ins = await db
    .from("org_platform_addons")
    .insert({ organization_id: paidLaunch.orgId, addon_id: addon.id, status: "active" });
  const upd = await db
    .from("org_platform_addons")
    .update({ status: "active" })
    .eq("organization_id", paidLaunch.orgId);
  const del = await db.from("org_platform_addons").delete().eq("organization_id", paidLaunch.orgId);
  const rows = await fx.count("org_platform_addons", paidLaunch.orgId);
  const denied = (x) => x.error && /permission denied/i.test(x.error.message);
  return {
    pass: denied(ins) && denied(upd) && denied(del) && rows === 0,
    evidence: `as the owner's JWT: insert "${ins.error?.message ?? "ALLOWED"}", update "${upd.error?.message ?? "ALLOWED"}", delete "${del.error?.message ?? "ALLOWED"}", rows ${rows}`,
  };
});

// ── Grandfathered renewal on a test clock (direct Stripe: no app code runs at renewal) ──
const allPrices = [];
for await (const p of stripe.prices.list({ active: true, limit: 100, expand: ["data.product"] }))
  allPrices.push(p);
const byKey = (k) => allPrices.find((p) => p.lookup_key === k);
const oldPrice = (slugKey, slug, cents) =>
  allPrices.find(
    (p) =>
      !p.lookup_key &&
      p.unit_amount === cents &&
      p.product.metadata?.[slugKey] === slug &&
      p.recurring?.interval === "month",
  );

const { runRenewalCheck } = await import("./release-gate/renewal.mjs");
await runRenewalCheck({ check, stripe, v, RUN, byKey, oldPrice, $ });

await check(
  "grandfathered: a NEW purchase resolves the $15 seat by lookup key (app resolver)",
  async () => {
    const catalog = await priceCatalog.loadPriceCatalog(stripe);
    const m = priceCatalog.resolvePriceId(
      catalog,
      lookupKeys.planLookupKey("launch", "seat_monthly"),
      null,
    );
    const y = priceCatalog.resolvePriceId(
      catalog,
      lookupKeys.planLookupKey("launch", "seat_annual"),
      null,
    );
    const pm = allPrices.find((p) => p.id === m);
    const py = allPrices.find((p) => p.id === y);
    return {
      pass: pm?.unit_amount === 1500 && py?.unit_amount === 15000,
      evidence: `launch_seat_monthly -> ${m} ${$(pm?.unit_amount ?? 0)}; launch_seat_annual -> ${y} ${$(py?.unit_amount ?? 0)}`,
    };
  },
);

// ── NP-10: a checkout at each plan and interval, one extra person ─────────
const PLANS = {
  launch: { people: 2, base: [7900, 79000] },
  growth: { people: 6, base: [19900, 199000] },
  scale: { people: 21, base: [44900, 449000] },
};
let launchMonthly = null;
const productDescriptions = new Map();
for (const [slug, p] of Object.entries(PLANS)) {
  for (const interval of ["month", "year"]) {
    await check(`NP-10 checkout ${slug} ${interval}ly, ${p.people} people (1 extra)`, async () => {
      const o = await fx.org({
        label: `np10-${slug}-${interval}`,
        plan: slug,
        people: p.people,
        plan_status: "trialing",
        billing_status: "trialing",
        trial_ends_at: daysFromNow(7),
      });
      const r = await call(billing.createPlanSubscription, o, {
        planId: await planId(slug),
        interval,
      });
      await track(o.orgId);
      if (!r.ok) return { pass: false, evidence: r.message };
      const sub = await stripe.subscriptions.retrieve(r.value.subscriptionId, {
        expand: ["items.data.price.product", "latest_invoice"],
      });
      const kind = interval === "year" ? "annual" : "monthly";
      const base = sub.items.data.find((i) => i.price.lookup_key === `${slug}_base_${kind}`);
      const seat = sub.items.data.find((i) => i.price.lookup_key === `${slug}_seat_${kind}`);
      const want = interval === "year" ? [p.base[1], 15000] : [p.base[0], 1500];
      productDescriptions.set(slug, base?.price.product.description);
      const lines = await v.invoiceLines(sub.latest_invoice.id);
      const ok =
        sub.items.data.length === 2 &&
        base?.price.unit_amount === want[0] &&
        base.quantity === 1 &&
        seat?.price.unit_amount === want[1] &&
        seat.quantity === 1 &&
        sub.latest_invoice.amount_due === want[0] + want[1] &&
        r.value.includedSeats === { launch: 1, growth: 5, scale: 20 }[slug];
      if (slug === "launch" && interval === "month") launchMonthly = { o, subId: sub.id };
      return {
        pass: ok,
        evidence: `app createPlanSubscription -> ${sub.id}: ${sub.items.data.map((i) => `${i.price.lookup_key} x${i.quantity} ${$(i.price.unit_amount)}`).join(" + ")}; invoice due ${$(sub.latest_invoice.amount_due)}; included ${r.value.includedSeats}; lines: ${lines.map((l) => JSON.stringify(l.description)).join(", ")}`,
      };
    });
  }
}

await check(
  "B-P0-3 Priority support ($99, Launch) and setup ($199) still sell (app path)",
  async () => {
    if (!launchMonthly) return { pass: false, evidence: "no Launch monthly checkout" };
    const { o, subId } = launchMonthly;
    await v.pay(subId);
    await call(billing.refreshBillingStatus, o);
    const prio = await call(addons.subscribePlatformAddon, o, {
      addonId: (await fx.addonIdFor("priority-support")).id,
    });
    const setup = await call(addons.subscribePlatformAddon, o, {
      addonId: (await fx.addonIdFor("developer-setup")).id,
    });
    const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
    const prioItem = sub.items.data.find((i) => i.price.lookup_key === "addon_priority_support");
    const pending = await stripe.invoiceItems.list({
      customer: sub.customer,
      pending: true,
      limit: 10,
    });
    const setupItem = pending.data.find((i) => i.amount === 19900);
    return {
      pass: prio.ok && setup.ok && prioItem?.price.unit_amount === 9900 && !!setupItem,
      evidence: `priority: ${prio.ok ? `item ${prioItem?.id} ${$(prioItem?.price.unit_amount ?? 0)}` : prio.message}; setup: ${setup.ok ? `invoice item ${setupItem?.id} ${$(setupItem?.amount ?? 0)}` : setup.message}`,
    };
  },
);

// ── NP-10: the caps ───────────────────────────────────────────────────────
async function capCase(slug, enabled, expectRefusal) {
  const o = await fx.org({
    label: `cap-${slug}`,
    plan: slug,
    people: enabled,
    disabled: 1,
    plan_status: "active",
    billing_status: "active",
  });
  const off = (await fx.staffOf(o.orgId)).find((s) => !s.active);
  const enable = await call(users.setStaffActive, o, { staffId: off.id, active: true });
  const nowActive = (await fx.staffOf(o.orgId)).find((s) => s.id === off.id).active;
  const invitesBefore = await fx.count("org_invites", o.orgId);
  const invite = await call(users.createOrgInvite, o, {
    email: `${RUN}-invitee-${slug}@release-gate.test`,
    role: "tech",
  });
  const invitesAfter = await fx.count("org_invites", o.orgId);
  let rpc = null;
  if (expectRefusal) {
    // The database backstop: the owner calls the RPC straight from the browser.
    rpc = await o.client.rpc("set_staff_active", { _staff_id: off.id, _active: true });
  }
  return { o, enable, nowActive, invite, invitesBefore, invitesAfter, rpc };
}
await check("NP-10 cap: Launch refuses a 4th (enable, invite, and the DB trigger)", async () => {
  const c = await capCase("launch", 3, true);
  const want = "Launch covers up to 3 people. To add a 4th, move to Growth.";
  const ok =
    !c.enable.ok &&
    c.enable.message === want &&
    !c.nowActive &&
    !c.invite.ok &&
    c.invite.message === want &&
    c.invitesAfter === c.invitesBefore &&
    c.rpc.error?.message?.includes(want);
  return {
    pass: ok,
    evidence: `setStaffActive "${c.enable.message}"; createOrgInvite "${c.invite.message}" (invites ${c.invitesBefore}->${c.invitesAfter}); rpc set_staff_active "${c.rpc.error?.message ?? "ALLOWED"}"`,
  };
});
await check("NP-10 cap: Growth refuses a 16th (enable, invite, and the DB trigger)", async () => {
  const c = await capCase("growth", 15, true);
  const want = "Growth covers up to 15 people. To add a 16th, move to Scale.";
  const ok =
    !c.enable.ok &&
    c.enable.message === want &&
    !c.nowActive &&
    !c.invite.ok &&
    c.invite.message === want &&
    c.rpc.error?.message?.includes(want);
  return {
    pass: ok,
    evidence: `setStaffActive "${c.enable.message}"; createOrgInvite "${c.invite.message}"; rpc "${c.rpc.error?.message ?? "ALLOWED"}"`,
  };
});
await check("NP-10 cap: Scale has none (22nd enabled, invite allowed, no email sent)", async () => {
  const c = await capCase("scale", 21, false);
  return {
    pass:
      c.enable.ok &&
      c.nowActive &&
      c.invite.ok &&
      c.invitesAfter === c.invitesBefore + 1 &&
      gate.invitesSuppressed.length >= 1,
    evidence: `setStaffActive ${c.enable.ok ? "ok" : c.enable.message}; createOrgInvite ${c.invite.ok ? "ok" : c.invite.message}; emails suppressed ${gate.invitesSuppressed.length}`,
  };
});
await check(
  "NP-10 cap: a plan below the enabled users can't be chosen (before Stripe)",
  async () => {
    const o = await fx.org({
      label: "cap-choose",
      plan: "growth",
      people: 5,
      plan_status: "trialing",
      billing_status: "trialing",
      trial_ends_at: daysFromNow(5),
    });
    const r = await call(billing.createPlanSubscription, o, {
      planId: await planId("launch"),
      interval: "month",
    });
    return {
      pass: !r.ok && r.stripeRequests === 0 && /Launch covers up to 3 people/.test(r.message),
      evidence: `"${r.message}", Stripe requests ${r.stripeRequests}`,
    };
  },
);

// ── NP-2: LAUNCH20 ────────────────────────────────────────────────────────
const { runFoundingChecks } = await import("./release-gate/founding.mjs");
await runFoundingChecks({
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
});

// ── NP-12: lock, export, deletion dry run ─────────────────────────────────
const { runLockChecks } = await import("./release-gate/lock.mjs");
await runLockChecks({
  check,
  call,
  fx,
  billing,
  lockServer,
  exporter,
  deletion,
  subscribeAndPay,
  daysFromNow,
  sourceText,
  v,
});

// ── scripts/check-stripe-catalog.mjs ──────────────────────────────────────
const { runCatalogChecks } = await import("./release-gate/catalog.mjs");
await runCatalogChecks({ check, cfg, ROOT, allPrices });

console.log(
  "\nproduct descriptions on the plan's Stripe product (what an invoice and receipt carry):",
);
for (const [slug, d] of productDescriptions) console.log(`  ${slug}: ${JSON.stringify(d)}`);

// ── Clean up ──────────────────────────────────────────────────────────────
const done = await v.cleanup();
console.log(
  `\ncleanup: ${done.customers} customer(s) deleted (their subscriptions with them), ${done.clocks} test clock(s) deleted${done.errors.length ? `; errors: ${done.errors.join("; ")}` : ""}`,
);
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
