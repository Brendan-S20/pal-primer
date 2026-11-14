/**
 * #807, the part #810 could not reach: the auth server's leaked-password
 * check. Brendan, 2026-11-09: "it doesn't tell you that the password is weak
 * til you're all the way through, it should tell you as you try to move from
 * then."
 *
 * The shared rules were already checked as the person typed. A password that
 * passed them but was in a breach corpus still came back only from
 * registerAccount, on the Finish step. checkNewPassword now asks on the
 * account step, when the person leaves the field and when they press
 * Continue. This measures that state, at 360 / 768 / 1024 / 1440 (the widths
 * the issue's fix was asked for, with touch on below 1280), and checks that
 * the message is tied to the field (aria-describedby, aria-invalid) and has
 * at least 4.5:1 contrast against the card behind it.
 *
 * The state is asserted to be on screen before anything is measured.
 */
import { test, expect, type Page } from "@playwright/test";
import { installStubBackend } from "./fixtures/stub-backend";
import { findControlsOffTheSide, findControlsUnder44px, measurePageOverflow } from "./rules";

const PROBLEM =
  "That password can't be used: Password is known to be weak and easy to guess, please choose a different one.";
const EMAIL = "new.owner.with.a-rather-long-address@houndstack-sweep.test";
const BREACHED = "password1234";
const GOOD = "a much better passphrase";

const WIDTHS = [
  { width: 360, height: 780 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

async function measured(page: Page, where: string) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: no sideways page scroll`).toBeLessThanOrEqual(innerW);
  expect(await findControlsOffTheSide(page), `${where}: every control on the page`).toEqual([]);
  if ((page.viewportSize()?.width ?? 0) < 1280) {
    expect(await findControlsUnder44px(page), `${where}: 44px controls`).toEqual([]);
  }
}

async function hydrated(page: Page, selector: string) {
  await page.waitForFunction(
    (sel) => Object.keys(document.querySelector(sel) ?? {}).some((k) => k.startsWith("__react")),
    selector,
  );
}

/** WCAG contrast of an element's text against the nearest painted background.
 *  Colours are resolved through a canvas, so oklch() reads the same as rgb(). */
async function contrastOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((el) => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    const rgb = (css: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a };
    };
    let bg = { r: 255, g: 255, b: 255, a: 0 };
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.a > 0) {
        bg = c;
        break;
      }
    }
    if (bg.a === 0) bg = { r: 255, g: 255, b: 255, a: 255 };
    const fg = rgb(getComputedStyle(el).color);
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  });
}

for (const size of WIDTHS) {
  test.describe(`${size.width}px`, () => {
    test.use({ viewport: size, hasTouch: size.width < 1280 });

    test("a breached password is named on the account step, by blur and by Continue", async ({
      page,
    }) => {
      const asked: string[] = [];
      await installStubBackend(page.context(), {
        overrides: {
          checkEmailAccount: { exists: false, pendingInvite: false },
          checkNewPassword: (args: { password?: unknown }) => {
            const pw = String(args?.password ?? "");
            asked.push(pw);
            return pw === BREACHED ? { ok: false, problem: PROBLEM } : { ok: true, problem: null };
          },
        },
      });
      await page.goto("/get-started");
      await hydrated(page, "#gs-pass");
      await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

      const field = page.locator("#gs-pass");
      const said = page.locator("[data-password-server-error]");
      const cont = page.getByRole("button", { name: "Continue" });

      // Leaving the field.
      await page.locator("#gs-email").fill(EMAIL);
      await field.fill(BREACHED);
      await page.locator("#gs-email").focus();
      await expect(said).toHaveText(PROBLEM);
      await expect(cont).toBeDisabled();
      await expect(field).toHaveAttribute("aria-invalid", "true");
      const saidId = await said.getAttribute("id");
      expect((await field.getAttribute("aria-describedby"))?.split(" ")).toContain(saidId);
      expect(await contrastOf(page, "[data-password-server-error]")).toBeGreaterThanOrEqual(4.5);
      await expect(field).toHaveValue(BREACHED);
      await expect(page.locator("#gs-email")).toHaveValue(EMAIL);
      await measured(page, "account step, breached password named on blur");

      // A better one clears it and Continue goes on.
      await field.fill(GOOD);
      await expect(said).toHaveCount(0);
      await expect(cont).toBeEnabled();
      await cont.click();
      await expect(page.locator("#gs-org")).toBeVisible();

      // Back, and Continue pressed straight from the field (no blur first).
      await page.getByRole("button", { name: "Back" }).click();
      await page.locator("#gs-pass").fill(BREACHED);
      await page.locator("#gs-pass").press("Enter");
      await expect(said).toHaveText(PROBLEM);
      await expect(page.locator("#gs-org")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
      await measured(page, "account step, breached password named on Continue");

      expect(asked).toContain(BREACHED);
      expect(asked).toContain(GOOD);
    });
  });
}
