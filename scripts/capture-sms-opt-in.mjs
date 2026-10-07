// Re-captures the opt-in evidence that /legal/sms links and that goes in
// Twilio's `optInImageUrls`. Run against production once a change is live, so
// the pictures are of the journey a reviewer will actually walk:
//
//   node scripts/capture-sms-opt-in.mjs https://app.houndstack.com
//
// Walks /get-started to step 3 WITHOUT submitting (no account is created) and
// takes the three legal pages whole, so the operator identity block, the
// "coming soon" notice and the consent wording are all in frame.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const base = (process.argv[2] ?? "http://localhost:8080").replace(/\/$/, "");
const out = process.argv[3] ?? join(process.cwd(), "public/sms-opt-in");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 960, height: 1000 } });
const shot = (name, opts = {}) => page.screenshot({ path: join(out, name), ...opts });

await page.goto(`${base}/get-started`, { waitUntil: "networkidle" });
await page.locator("#gs-email").fill("reviewer@example.com");
await page.locator("#gs-pass").fill("example-password-123");
await page.locator('form button[type="submit"]').click();
await page.locator("#gs-org").fill("Example Scoop Co");
await page.locator("#gs-name").fill("Alex Example");
await page.locator('form button[type="submit"]').click();
await page.locator("#gs-phone").waitFor();
await shot("3-finish-no-number.png");
await page.locator("#gs-phone").fill("(555) 123-4567");
await shot("4-opt-in-unticked.png");
await page.locator('form input[type="checkbox"]').check();
await shot("5-opt-in-ticked.png");

for (const [name, path] of [
  ["6-sms-policy.png", "/legal/sms"],
  ["7-terms.png", "/legal/terms"],
  ["8-privacy.png", "/legal/privacy"],
]) {
  await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
  await shot(name, { fullPage: true });
}

await browser.close();
console.log(`captured into ${out} from ${base}`);
