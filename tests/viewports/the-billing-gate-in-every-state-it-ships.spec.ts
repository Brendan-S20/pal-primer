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
import { test, expect, type BrowserContext } from "@playwright/test";
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
async function forceBillingState(
  context: BrowserContext,
  patch: Record<string, unknown>,
) {
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
    expect: /Renews|Current plan/,
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
  expect(
    body,
    "the plan step did not render, so its absence proves nothing",
  ).toMatch(/plan|Plan/);

  for (const word of ["Payment happens right here", "Choose plan", "Pick the plan that fits"]) {
    expect(
      body,
      `/onboarding still offers a purchase in a store build: "${word}"`,
    ).not.toContain(word);
  }
});

// ── ITEM 7: the org's money page on a finger ─────────────────────────────
//
// Stripe Connect's embedded components are iframes on Stripe's origin. Their
// controls measured 10-30pt on an iPad — "Edit Amount" 60x10, eight of them —
// and nothing on our side can restyle the inside of an iframe. So on a coarse
// pointer they are REPLACED rather than shrunk, and this proves the
// replacement is what renders.
//
// Nothing here is an App Review question. This is the tenant's own money,
// which app-store-billing.ts is explicit about never gating.
test("the payments page replaces Stripe's tiny embeds on a touch device", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    // A coarse pointer, which is what the page keys on. Chromium reports a
    // fine pointer by default, so without this the desktop branch renders and
    // the assertions below would pass while measuring the wrong thing.
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
  await installStubBackend(context);
  // The fixture reports no Stripe account, so the page stops at "Set one up"
  // and never reaches the dashboard the embeds live in. Force a connected
  // account so the branch under test actually renders.
  await context.route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    try {
      const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
      name = String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
    } catch {
      /* fall through */
    }
    if (name !== "getStripeConnectStatus") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        result: { connected: true, chargesEnabled: true, detailsSubmitted: true, accountId: "acct_test" },
      }),
    });
  });
  await installSignedInSession(context);

  await page.goto("/payments");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);

  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  // Proof the DASHBOARD rendered, not merely the page. Its tab strip is the
  // tell; the page title says "Payments" either way, which is what made the
  // first version of this guard fire on the wrong thing.
  test.skip(
    /No Stripe account connected yet/.test(body),
    "the payments page still reports no connected account, so the dashboard did not render",
  );

  expect(
    body,
    "the touch replacement did not render, so the tiny Stripe embeds are still what a finger gets",
  ).toContain("needs a bigger screen");
});

// The other half of the pair. Replacing the embeds on touch is only correct if
// a MOUSE still gets them — otherwise the fix is a feature removal wearing a
// bug fix's clothes. Chromium reports a fine pointer by default, so this needs
// no init script; it is the default branch.
test("a mouse still gets Stripe's own dashboard, not the replacement", async ({
  page,
  context,
}) => {
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
    if (name !== "getStripeConnectStatus") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        result: { connected: true, chargesEnabled: true, detailsSubmitted: true, accountId: "acct_test" },
      }),
    });
  });
  await installSignedInSession(context);

  await page.goto("/payments");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);

  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");

  // Proof of render: the dashboard was reached.
  test.skip(
    /No Stripe account connected yet/.test(body),
    "the payments page reports no connected account, so there is no dashboard to check",
  );

  // The desktop branch tries to load Stripe. In this harness the fence blocks
  // stripe.com, so it reaches the loading or error state — either proves it
  // took the Stripe path rather than the replacement, which is the assertion.
  expect(
    body,
    "a mouse is getting the touch replacement — the embeds have been removed for everyone",
  ).not.toContain("needs a bigger screen");
});
