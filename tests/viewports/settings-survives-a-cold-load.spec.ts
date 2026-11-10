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

// Inject a render failure into a real route module. The route boundary
// catches every thrown value, including falsy ones, and RouteError stays
// inside the signed-in shell.
for (const thrown of ["undefined", "null", "false", '"unexpected"']) {
  test(`a route boundary catches a thrown ${thrown}`, async ({ page }) => {
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
    await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    expect(injected).toBe(true);
    await expect(page.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });
}

// RootShell renders this beside the route tree, so no router boundary is
// around it. RootRecovery is the backstop that still catches the throw.
test("the root recovery catches a throw outside the route tree", async ({ page }) => {
  await installSignedInSession(page);
  await installStubBackend(page);
  let injected = false;
  await page.route("**/src/routes/__root.tsx*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const reactImport = source.match(
      /import\s+(\w+)\s+from\s+"\/node_modules\/\.vite\/deps\/react\.js/,
    );
    const shell = "function RootShell({ children }) {";
    if (!reactImport || !source.includes(shell)) {
      await route.fulfill({ response, body: source });
      return;
    }
    const body = source.replace(
      shell,
      `${shell}\n  children = ${reactImport[1]}.createElement(function OutsideRouteTree() { throw undefined; });`,
    );
    injected = body !== source;
    await route.fulfill({ response, body });
  });
  await page.goto("/settings/preferences", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "This page didn't load" })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.getByText("Try refreshing or return to the dashboard.")).toBeVisible();
  expect(injected).toBe(true);
  await expect(page.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
    "href",
    "/dashboard",
  );
});
