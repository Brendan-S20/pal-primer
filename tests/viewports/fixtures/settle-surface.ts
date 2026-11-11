import { expect, type Page } from "@playwright/test";
import type { Surface } from "./surfaces";

/**
 * "Signed in, stubbed, settled": the proof-of-render guard every signed-in
 * sweep runs before it measures anything. Lifted out of
 * `every-signed-in-page-at-every-width.spec.ts` when the axe sweep
 * (`axe-finds-nothing-serious-on-the-main-pages.spec.ts`) became its second
 * user, so the two cannot drift into different ideas of "this page rendered".
 * The reasons for each check are written beside it.
 */
export async function settle(page: Page, surface: Surface, widthLabel: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(250);

  const where = `${surface.id} at ${widthLabel}`;

  // Vite can be network-idle while the lazy route is still only the router's
  // "Loading" status. Wait for that shell to leave, or the health snapshot
  // measures a page-shaped silence and fails before the surface proof gets
  // its own 15 seconds.
  await page
    .waitForFunction(
      () => {
        const meaningfulText = document.body.innerText.replace(/Loading(?:…|\.{3})/gi, "").trim();
        const loadingStatus = [...document.querySelectorAll('[role="status"]')].some((el) => {
          const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
          return el.getAttribute("aria-busy") === "true" && /^Loading(?:…|\.{3})?$/.test(name);
        });
        return meaningfulText.length > 0 && !loadingStatus;
      },
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => {});

  const health = await page.evaluate(() => ({
    path: location.pathname,
    els: document.querySelectorAll("*").length,
    text: document.body.innerText.trim().length,
    overlay: Boolean(document.querySelector("vite-error-overlay")),
    // TanStack Router's error boundary. A route whose loader threw renders
    // this, and it is a page: it has a heading, two buttons and a message, so
    // it clears any size threshold while containing none of the app.
    boundary: document.body.innerText.includes("Something went wrong"),
  }));

  expect(health.overlay, `${where} rendered a Vite error overlay`).toBe(false);
  expect(health.boundary, `${where} rendered the router's error boundary instead of the page`).toBe(
    false,
  );

  // The signed-out bounce. `_authenticated.beforeLoad` redirects to /auth on a
  // rejected identity and to /no-workspace on an account with no org; both are
  // pages this sweep's public half already proves are well laid out, so
  // measuring one of them would be a green run about the wrong screen.
  //
  // Compared by PATHNAME: a surface may carry a query string
  // (/clients/new?fromLead=…), which `location.pathname` never includes. What
  // the query selects is proved by that surface's own `proof` locator, which
  // only the query's branch of the page draws.
  const expectedPath = surface.path.split("?")[0];
  expect(
    health.path,
    `${where} ended up on ${health.path} — the session did not take, so what was measured is not this page`,
  ).toBe(expectedPath);

  expect(
    health.els,
    `${where} rendered only ${health.els} elements — the page did not render, so every assertion about it would pass vacuously`,
  ).toBeGreaterThan(40);
  expect(
    health.text,
    `${where} rendered only ${health.text} characters of text — the page did not render`,
  ).toBeGreaterThan(200);

  // The two that make this guard about THIS page rather than about any page.
  await expect(
    surface.proof(page).first(),
    `${where}: ${surface.proofLabel} is not on screen, so this is not the surface the test names`,
  ).toBeVisible({ timeout: 15_000 });

  const hasData = await page.evaluate(
    (needle) => document.body.innerText.includes(needle),
    surface.expectsData,
  );
  expect(
    hasData,
    `${where} rendered its chrome but not "${surface.expectsData}" — an empty surface has no layout to measure`,
  ).toBe(true);
}

/** Whatever the surface says has to be opened, plus proof it opened. */
export async function openExtras(page: Page, surface: Surface, widthLabel: string) {
  if (!surface.open) return;
  await surface.open(page);
  await page.waitForTimeout(400);
  if (surface.opened) {
    await expect(
      surface.opened(page).first(),
      `${surface.id} at ${widthLabel}: ${surface.openedLabel} never appeared, so the thing this surface exists to measure was not measured`,
    ).toBeVisible({ timeout: 10_000 });
  }
}
