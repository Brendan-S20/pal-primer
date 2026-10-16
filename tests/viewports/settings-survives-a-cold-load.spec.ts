import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

test.describe.configure({ mode: "parallel" });

const aliases = [
  ["/settings", "/settings/preferences", "Preferences"],
  ["/settings/payments?connected=1", "/payments", "Payments"],
  ["/billing?checkout=success", "/settings/billing", "Plan & billing"],
  ["/settings/lead-form", "/settings/online-signup", "Signup & quote form"],
  ["/ai-tools", "/dashboard", "Today's map"],
  ["/platform", "/platform/overview", "Overview"],
  ["/", "/auth", "Sign in or create your account"],
] as const;

for (const width of [390, 1440]) {
  test.describe(`${width}px cold redirects`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });
    for (const [path, target, heading] of aliases) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        test(`${path} attempt ${attempt}`, async ({ page }) => {
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          page.on("console", (message) => {
            if (
              message.type() === "error" &&
              /_nonReactive|Error during router hydration/.test(message.text())
            ) {
              errors.push(message.text());
            }
          });
          if (path !== "/") await installSignedInSession(page);
          await installStubBackend(page);
          await page.goto(path, { waitUntil: "domcontentloaded" });
          await expect(
            page.getByRole("heading", { name: heading, exact: true }).first(),
          ).toBeVisible({ timeout: FIRST_PAINT_MS });
          await expect.poll(() => new URL(page.url()).pathname).toBe(target);
          const query = new URL(path, "http://localhost").searchParams;
          for (const [key, value] of query) {
            expect(new URL(page.url()).searchParams.get(key)).toBe(value);
          }
          await expect(
            page.getByRole("alert").filter({ hasText: "This page didn't load" }),
          ).toHaveCount(0);
          expect(errors).toEqual([]);
        });
      }
    }
  });
}

// Inject a render failure into a real route module so the shell boundary is
// exercised through the router's own boundaries, including falsy throws.
for (const thrown of ["undefined", "null", "false", '"unexpected"']) {
  test(`root shell recovers from thrown ${thrown}`, async ({ page }) => {
    await installSignedInSession(page);
    await installStubBackend(page);
    let injected = false;
    await page.route("**/src/routes/_authenticated/settings.preferences.tsx*", async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const body = source.replace(/function PreferencesPage\(\) \{/, (match) => {
        injected = true;
        return `${match} throw ${thrown};`;
      });
      await route.fulfill({ response, body });
    });
    await page.goto("/settings/preferences", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", {
        name: thrown === '"unexpected"' ? "Something went wrong" : "This page didn't load",
      }),
    ).toBeVisible({ timeout: FIRST_PAINT_MS });
    expect(injected).toBe(true);
    await expect(page.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });
}
