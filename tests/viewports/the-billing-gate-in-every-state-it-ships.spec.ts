// The App Review gate, RENDERED, in all three states a tenant can be in.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// The gate had been proved on one state: Enterprise, Active. That is the state
// the demo org happens to be in, so it is the only one a device QA pass can
// see without mutating a real tenant. The other two carry their OWN copy —
//
//     trialing  "Your trial status is shown here. Plan changes are handled
//                outside the mobile app."
//     past_due  "Your last payment failed. Payment method updates are handled
//                outside the mobile app."
//
// — and each is the not-canBuySaas branch of a ternary whose other half is
// full of purchase verbs. Softening one branch and missing the other is
// exactly the shape of mistake this whole area keeps producing: three separate
// copies of "managed on the web" survived the rewrite, in a vitest file, an
// XCUITest and a Playwright spec, and two of them were only found by a person
// looking at a device.
//
// Reading the source is not enough and is explicitly not what this does. Each
// state is RENDERED in a browser reporting itself as iOS, then the whole
// visible text is scanned.
//
// ── HOW THE STATE IS FORCED ───────────────────────────────────────────────
//
// `installStubBackend` answers `getBillingStatus` with active/paid. Playwright
// matches routes in REVERSE registration order, so a handler registered after
// it wins — that is the documented behaviour the fence in stub-backend.ts
// already relies on, used here to vary one field and leave every other stub
// alone.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

const PHONE = { width: 402, height: 874 };
test.use({ viewport: PHONE });

/** Wording that turns a statement of account state into an instruction to buy,
 *  plus anything that names where to go instead. Both are 3.1.1 concerns. */
const FORBIDDEN = [
  "Choose a plan",
  "Pick a plan",
  "Upgrade",
  "Subscribe",
  "Buy ",
  "Purchase",
  "Update your payment method",
  "Cancel subscription",
  "Resume subscription",
  "Payment methods",
  "Add card",
  "Checkout",
  "Stripe",
  "houndstack.com",
  "on the web",
  "http",
];

/** Make the browser answer getPlatform() === "ios" the way the binary does.
 *  Capacitor reads `window.webkit.messageHandlers.bridge`; replacing the whole
 *  Capacitor object instead breaks its plugin proxies and renders an empty
 *  page, which every absence assertion below would happily pass. */
async function pretendToBeIOS(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as unknown as Record<string, any>;
    w.webkit = w.webkit ?? {};
    w.webkit.messageHandlers = w.webkit.messageHandlers ?? {};
    w.webkit.messageHandlers.bridge = { postMessage: () => {} };
  });
}

/** Override just `getBillingStatus`, leaving the rest of the stub intact. */
async function forceBillingState(context: BrowserContext, patch: Record<string, unknown>) {
  await context.route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    try {
      const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
      name = String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
    } catch {
      /* fall through to the stub below */
    }
    if (name !== "getBillingStatus") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          orgId: "11111111-1111-4111-8111-000000000000",
          orgName: "Demo Pet Waste Co",
          planName: "Growth",
          planSlug: "growth",
          currentPeriodEnd: "2026-09-16T00:00:00.000Z",
          ...patch,
        },
      }),
    });
  });
}

const STATES: Array<{ label: string; patch: Record<string, unknown>; expect: RegExp }> = [
  {
    label: "active",
    patch: { billingStatus: "active", planStatus: "active", isPaidTier: true },
    // SectionLabel uppercases the rendered text through CSS.
    expect: /Renews|Current plan/i,
  },
  {
    label: "trialing",
    patch: { billingStatus: "trialing", planStatus: "trialing", isPaidTier: false },
    expect: /trial status is shown here/,
  },
  {
    label: "past_due",
    patch: { billingStatus: "past_due", planStatus: "past_due", isPaidTier: true },
    expect: /last payment failed/,
  },
];

for (const state of STATES) {
  test(`a store build in the ${state.label} state shows status and no way to buy`, async ({
    page,
    context,
  }) => {
    await pretendToBeIOS(context);
    await installStubBackend(context);
    await forceBillingState(context, state.patch);
    await installSignedInSession(context);

    await page.goto("/settings/billing");

    // PROOF OF RENDER, before any absence is claimed. Every "X is not present"
    // assertion passes on a blank page, and this whole file is absences.
    await expect(page.getByText("Current plan")).toBeVisible({ timeout: FIRST_PAINT_MS });

    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");

    // The state actually rendered — not the fixture's default wearing its name.
    expect(
      body,
      `the ${state.label} state did not render its own copy; the page may still be showing active`,
    ).toMatch(state.expect);

    // Status is KEPT. Hiding what someone is paying for would be worse for the
    // customer and no safer for review.
    expect(body, "the plan itself is not shown").toMatch(/Growth|Current plan/);

    for (const word of FORBIDDEN) {
      expect(
        body.toLowerCase(),
        `the ${state.label} billing screen contains "${word}" — that is a purchase ` +
          `instruction or a destination, and a store build may carry neither`,
      ).not.toContain(word.toLowerCase());
    }
  });
}

// ── THE ROUTE THE ROUTE-LEVEL GATE DID NOT COVER ─────────────────────────
//
// /settings/billing had `canBuySaas &&` around every purchase surface, and
// /onboarding had a full PlanPicker with no gate at all, under the heading
// "Pick the plan that fits your crew" and the line "Payment happens right
// here. You won't leave the app." A new organization lands there.
//
// It was found by grepping for other importers of PlanPicker, not by any test,
// which is the argument for gating the COMPONENT rather than each route: a
// per-route guard is a promise every future route has to remember to keep.
test("a store build cannot reach a plan picker through onboarding either", async ({
  page,
  context,
}) => {
  await pretendToBeIOS(context);
  await installStubBackend(context);
  await installSignedInSession(context);

  await page.goto("/onboarding");
  await page.waitForLoadState("networkidle");

  // REACH THE PLAN STEP. /onboarding opens on "welcome" and only renders the
  // picker after "Pick a plan" — so a test that loads the route and asserts
  // absence passes whether or not the gate exists. The first version of this
  // test did exactly that, and a mutation run with the gate REMOVED still
  // passed it. That is the failure this whole file is about, reproduced by me
  // while writing the file about it.
  const pick = page.getByRole("button", { name: "Pick a plan" });
  await expect(pick, "/onboarding did not render its welcome step").toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await pick.click();
  await page.waitForTimeout(1500);

  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");

  // Proof of render: the plan STEP is on screen, so a picker would be too if
  // one were going to be.
  expect(body, "the plan step did not render, so its absence proves nothing").toMatch(/plan|Plan/);

  for (const word of ["Payment happens right here", "Choose plan", "Pick the plan that fits"]) {
    expect(body, `/onboarding still offers a purchase in a store build: "${word}"`).not.toContain(
      word,
    );
  }
});

// ── ITEM 7: the org's money page, by WIDTH ───────────────────────────────
//
// Stripe Connect's embedded components are iframes on Stripe's origin. Their
// controls measured 10-30pt on an iPad ("Edit Amount" 60x10, eight of them)
// and nothing on our side can restyle the inside of an iframe. Below 1024px
// they are REPLACED rather than shrunk; at 1024px and wider they render,
// touch or mouse.
//
// Until #494 this pair keyed on a coarse pointer, and so did the page: every
// iPad, a 1032px landscape one included, got "needs a bigger screen" and was
// told to find a computer. These three prove the rule is the width: a phone
// gets the replacement, an iPad-sized touch screen gets the embeds, and a
// mouse at the same width gets them too.
//
// Nothing here is an App Review question. This is the tenant's own money,
// which app-store-billing.ts is explicit about never gating.

/** Report a coarse pointer, as a real iPad or phone does. `hasTouch` should
 *  already make Chromium say so; this pins it, so a test that is meant to be
 *  a finger cannot quietly measure a mouse. */
async function reportACoarsePointer(context: BrowserContext) {
  await context.addInitScript(() => {
    const mq = window.matchMedia.bind(window);
    window.matchMedia = ((q: string) =>
      q.includes("pointer: coarse")
        ? ({
            matches: true,
            media: q,
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            addListener() {},
            removeListener() {},
            dispatchEvent: () => false,
          } as unknown as MediaQueryList)
        : mq(q)) as typeof window.matchMedia;
  });
}

/** Open /payments with a live Stripe account. The fixture reports no Stripe
 *  account, so the page stops at "Set one up" and never reaches the dashboard
 *  the embeds live in; this forces a connected one so the branch under test
 *  actually renders. Returns the visible text. */
async function openConnectedPayments(
  page: Page,
  context: BrowserContext,
  /** Other server functions to answer here: a value is sent as the result,
   *  "hang" is never answered at all. */
  overrides: Record<string, unknown> = {},
) {
  await installStubBackend(context);
  await context.route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    try {
      const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
      name = String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
    } catch {
      /* fall through */
    }
    if (name in overrides) {
      if (overrides[name] === "hang") return; // never fulfilled: a call that does not come back
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result: overrides[name] }),
      });
    }
    if (name !== "getStripeConnectStatus") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          connected: true,
          chargesEnabled: true,
          detailsSubmitted: true,
          accountId: "acct_test",
        },
      }),
    });
  });
  await installSignedInSession(context);

  await page.goto("/payments");
  // A call held open on purpose means the network is never idle.
  await page.waitForLoadState(Object.values(overrides).includes("hang") ? "load" : "networkidle");
  await page.waitForTimeout(2500);

  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  // Proof the DASHBOARD rendered, not merely the page. The page title says
  // "Payments" either way, which is what made the first version of this guard
  // fire on the wrong thing.
  test.skip(
    /No Stripe account connected yet/.test(body),
    "the payments page still reports no connected account, so the dashboard did not render",
  );
  return body;
}

/** The desktop branch tries to load Stripe. In this harness the fence blocks
 *  stripe.com, so it reaches the loading or error state of the dashboard or of
 *  the Payouts card. Either proves it took the Stripe path rather than the
 *  replacement. "Balance" is not used as the tell: BalanceSummary, which is
 *  ours, draws "Loading balance" on both branches. */
const TOOK_THE_STRIPE_PATH = /payment dashboard|(Loading|Couldn't load) payouts/i;

test.describe("a phone, 390px with touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the payments page replaces Stripe's embeds below 1024px", async ({ page, context }) => {
    await reportACoarsePointer(context);
    const body = await openConnectedPayments(page, context);

    expect(
      body,
      "the narrow replacement did not render, so Stripe's cramped embeds are still what a phone gets",
    ).toContain("needs a wider screen");
    expect(body, "the replacement no longer says how to get the full view").toContain(
      "turn a tablet sideways",
    );
    // The copy this replaced told an iPad owner their tablet was the problem.
    expect(body).not.toContain("phone or tablet");
    expect(body).not.toContain("needs a bigger screen");
    // The route to the view built for touch is kept.
    await expect(page.getByRole("link", { name: "Invoices" }).first()).toBeVisible();
  });
});

test.describe("an iPad in landscape, 1032px with touch", () => {
  test.use({ viewport: { width: 1032, height: 1376 }, hasTouch: true, isMobile: true });

  test("a touch screen 1024px or wider gets Stripe's own dashboard", async ({ page, context }) => {
    await reportACoarsePointer(context);
    const body = await openConnectedPayments(page, context);

    expect(
      body,
      "a 1032px iPad is getting the narrow replacement: the gate is keyed on touch again, not width",
    ).not.toContain("needs a wider screen");
    expect(body).not.toContain("needs a bigger screen");
    expect(body, "the 1032px touch screen did not take the Stripe path").toMatch(
      TOOK_THE_STRIPE_PATH,
    );
  });
});

// The other half of the pair. Gating on width is only correct if a MOUSE at
// the same width still gets the embeds, unchanged from before #494. Chromium
// reports a fine pointer by default, so this needs no init script.
test.describe("a mouse at 1032px", () => {
  test.use({ viewport: { width: 1032, height: 800 } });

  test("a mouse still gets Stripe's own dashboard, not the replacement", async ({
    page,
    context,
  }) => {
    const body = await openConnectedPayments(page, context);

    expect(
      body,
      "a mouse is getting the narrow replacement: the embeds have been removed for everyone",
    ).not.toContain("needs a wider screen");
    expect(body).toMatch(TOOK_THE_STRIPE_PATH);
  });
});

// #436: "Loading balance…" and "Loading payouts…" that never finished. The
// fence turns back connect-js.stripe.com, which is the same thing a CORS
// failure or a content blocker does to a real owner, and the balance call is
// held open forever. Before the fix both cards waited for as long as the tab
// was open. Now each has a deadline and says it could not load, with a retry.
test.describe("Stripe that never answers, 1280px", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("no card on the Money tab is still loading once its deadline has passed", async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await openConnectedPayments(page, context, {
      createStripeAccountSession: { publishableKey: "pk_test_stub", clientSecret: "stub_secret" },
      getStripeBalanceSummary: "hang",
    });

    // Proof the dashboard rendered before anything is measured: a blank page
    // or the router's skeleton contains no "Loading balance…" either, and an
    // absence-only check passed on exactly that while this was being written.
    await expect(page.getByRole("tab", { name: "Money" })).toBeVisible({ timeout: 60_000 });
    const text = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
    expect(await text(), "the Money tab never showed its loading state").toMatch(
      /Loading (balance|payouts)…/,
    );

    // The deadlines are 20s (panels) and 25s (our own calls; the balance
    // query retries once, so two of them). Polled for the ERROR, not merely
    // for the loading text going away.
    await expect
      .poll(text, { timeout: 80_000, intervals: [2_000] })
      .toContain("Couldn't load your balance");
    await expect
      .poll(text, { timeout: 30_000, intervals: [2_000] })
      .toMatch(/Couldn't load (payouts|balance\.)/);

    const body = await text();
    expect(body, "a card on the Money tab is still loading after its deadline").not.toMatch(
      /Loading (balance|payouts)…/,
    );
    await expect(page.getByRole("button", { name: /Retry|Try again/ }).first()).toBeVisible();
  });
});
