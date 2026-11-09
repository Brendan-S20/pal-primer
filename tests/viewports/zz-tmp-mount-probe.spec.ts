import { test } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
for (const path of ["/my-schedule", "/review"]) {
  for (let i = 0; i < 8; i++) {
    test(`${path} #${i}`, async ({ page }) => {
      await page.addInitScript(() => {
        const orig = console.error;
        (window as any).__mountWarn = 0;
        console.error = function (...args: any[]) {
          if (/hasn't mounted/.test(String(args[0] ?? ""))) (window as any).__mountWarn++;
          return orig.apply(this, args as any);
        };
      });
      await installSignedInSession(page.context());
      await installStubBackend(page.context());
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      const n: number = await page.evaluate(() => (window as any).__mountWarn);
      console.log(n ? `HIT ${path} #${i}` : `none ${path} #${i}`);
    });
  }
}
