// An owner sets each role's permissions (#863), at the four widths, with
// touch on below desktop.
//
// The signed-in sweep lays /settings/roles out (it is a SURFACE now), but a
// sweep proves a page rendered, not that THIS change's pieces were on it.
// Each case here proves its piece first, with a string only the #863 fixture
// draws, then measures:
//
//   * the owner's page: the floor card, three role cards, a switch per
//     permission with its explanation, the "Changed" badge and the count on
//     the role the fixture changed, Reset enabled there and disabled on the
//     roles at their defaults;
//   * a switch: flipping one sends setRolePermission with the role, the
//     permission and the new answer, and the page keeps the new answer;
//   * Reset: the confirm names the role and sends resetRolePermissions;
//   * the rail: the owner finds "Roles & permissions" under Team, and an
//     office manager does not, nor the page (sent to the dashboard).
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { BASE_STUBS, installStubBackend, type Stub } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import {
  WIDTHS,
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

async function measure(page: Page, label: string, touch: boolean) {
  await page.waitForTimeout(500);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label}: scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), label).toEqual([]);
  expect(await findSilentlyClippedText(page), label).toEqual([]);
  if (touch) expect(await findControlsUnder44px(page), label).toEqual([]);
}

type Calls = Array<{ name: string; args: Record<string, unknown> }>;

/** Sign in as the owner on the stubbed backend, recording the two writes
 *  this page makes (the stub decodes the payload the way the server does). */
async function signInRecording(page: Page): Promise<Calls> {
  const calls: Calls = [];
  const record =
    (name: string, reply: (args: Record<string, unknown>) => unknown): Stub =>
    (args) => {
      calls.push({ name, args });
      return reply(args);
    };
  // The page refetches after every save, so the stub has to remember what
  // was written, as the database does: a flipped switch that the next read
  // flips back would be the fixture's fault, not the page's.
  const base = BASE_STUBS.getRolePermissions as RolesAnswer;
  const stored = new Map<string, boolean>();
  const reset = new Set<string>();
  const current = (): RolesAnswer => ({
    roles: base.roles.map((r) => {
      const permissions = r.permissions.map((p) => {
        const key = `${r.role}:${p.permission}`;
        if (stored.has(key)) return { ...p, allowed: stored.get(key)! };
        if (reset.has(r.role)) return { ...p, allowed: p.byDefault };
        return p;
      });
      const changed = permissions.filter((p) => p.allowed !== p.byDefault).length;
      return { ...r, permissions, changed, lastChange: changed ? r.lastChange : null };
    }),
  });
  await installSignedInSession(page);
  await installStubBackend(page, {
    overrides: {
      getRolePermissions: () => current(),
      setRolePermission: record("setRolePermission", (args) => {
        stored.set(`${args.role}:${args.permission}`, args.allowed as boolean);
        return { ok: true, allowed: args.allowed, byDefault: false };
      }),
      resetRolePermissions: record("resetRolePermissions", (args) => {
        reset.add(args.role);
        for (const key of [...stored.keys()])
          if (key.startsWith(`${args.role}:`)) stored.delete(key);
        return { ok: true };
      }),
    },
  });
  return calls;
}

type RolesAnswer = {
  roles: Array<{
    role: string;
    permissions: Array<{
      permission: string;
      allowed: boolean;
      byDefault: boolean;
      ownerOnly: boolean;
    }>;
    changed: number;
    lastChange: { by: string; at: string } | null;
  }>;
};

for (const { w, h, label } of WIDTHS) {
  const touch = w < 1280;
  test.describe(`${label}`, () => {
    test.use({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: w < 768 });

    test("the owner goes through each role", async ({ page }) => {
      await installSignedInSession(page);
      await installStubBackend(page);
      await page.goto("/settings/roles", { waitUntil: "domcontentloaded" });
      const heading = page.getByRole("heading", { name: "Roles & permissions" });
      await expect(heading).toBeVisible({ timeout: FIRST_PAINT_MS });

      // The floor, listed without a switch.
      await expect(page.getByText("Always the owner's")).toBeVisible();
      await expect(page.getByText("The business's own plan and payouts")).toBeVisible();
      await expect(
        page.getByRole("switch", { name: /The business's own plan and payouts/ }),
      ).toHaveCount(0);

      // Three role cards, each with a switch per configurable permission.
      await expect(page.locator("[data-role-card]")).toHaveCount(3);
      await expect(
        page.getByRole("switch", { name: "Set prices for dispatchers" }),
      ).not.toBeChecked();
      await expect(
        page.getByRole("switch", { name: "Book at the set price for dispatchers" }),
      ).toBeChecked();

      // The fixture's two changes on the dispatcher: the count, the actor,
      // the badge, and Reset enabled there only.
      const dispatcher = page.locator('[data-role-card="dispatcher"]');
      await expect(dispatcher.getByText("2 permissions changed from the defaults.")).toBeVisible();
      await expect(dispatcher.getByText("Last changed by Dana Whitfield-Ramirez")).toBeVisible();
      await expect(
        dispatcher.getByRole("switch", { name: "See the money for dispatchers" }),
      ).toBeChecked();
      await expect(
        dispatcher.getByRole("switch", { name: "Message clients for dispatchers" }),
      ).not.toBeChecked();
      await expect(dispatcher.getByText("Changed", { exact: true })).toHaveCount(2);
      await expect(dispatcher.getByRole("button", { name: "Reset to defaults" })).toBeEnabled();
      const om = page.locator('[data-role-card="office_manager"]');
      await expect(om.getByText("The defaults.")).toBeVisible();
      await expect(om.getByRole("button", { name: "Reset to defaults" })).toBeDisabled();

      await measure(page, `/settings/roles @${w}`, touch);
      await dispatcher.scrollIntoViewIfNeeded();
      await measure(page, `/settings/roles, dispatcher card @${w}`, touch);
    });

    test("a switch saves the role, the permission and the answer", async ({ page }) => {
      const calls = await signInRecording(page);
      await page.goto("/settings/roles", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Roles & permissions" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      const sw = page.getByRole("switch", { name: "Move visits for technicians" });
      await expect(sw).not.toBeChecked();
      await sw.scrollIntoViewIfNeeded();
      await sw.click();
      await expect(sw).toBeChecked();
      await expect
        .poll(() => calls.filter((c) => c.name === "setRolePermission").map((c) => c.args))
        .toEqual([{ role: "tech", permission: "manage_schedule", allowed: true }]);
      await expect(page.getByText("Move visits turned on for technicians")).toBeVisible();
      await measure(page, `/settings/roles after a switch @${w}`, touch);
    });

    test("Reset to defaults asks first, then sends the role", async ({ page }) => {
      const calls = await signInRecording(page);
      await page.goto("/settings/roles", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Roles & permissions" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      const dispatcher = page.locator('[data-role-card="dispatcher"]');
      const reset = dispatcher.getByRole("button", { name: "Reset to defaults" });
      await reset.scrollIntoViewIfNeeded();
      await reset.click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Reset dispatcher to the defaults?")).toBeVisible();
      await measure(page, `/settings/roles, reset confirm @${w}`, touch);
      await dialog.getByRole("button", { name: "Reset to defaults" }).click();
      await expect
        .poll(() => calls.filter((c) => c.name === "resetRolePermissions").map((c) => c.args))
        .toEqual([{ role: "dispatcher" }]);
      await expect(page.getByText("Dispatcher is back to the defaults")).toBeVisible();
    });

    test("an office manager has neither the link nor the page", async ({ page }) => {
      await installSignedInSession(page);
      await installStubBackend(page, { role: "office_manager" });
      await page.goto("/settings/users", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Users & roles" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.getByRole("link", { name: "Roles & permissions" })).toHaveCount(0);
      await page.goto("/settings/roles", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/dashboard/, { timeout: FIRST_PAINT_MS });
    });
  });
}
