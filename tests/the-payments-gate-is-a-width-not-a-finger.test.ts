// #494. /payments replaced Stripe's Connect dashboards (Balance, Payouts,
// Payments, Business details) on a coarse pointer, so every iPad got
// "needs a bigger screen" and was told to open the page on a computer,
// including a 1032px landscape iPad with room for the whole dashboard.
//
// The question that gate answers is whether there is room for Stripe's layout,
// which is a width. So the panels render at 1024px and wider, touch or mouse,
// and are replaced below it. Read as text, like the other static tests here,
// because the failure this pins is one line: somebody "fixing" the iPad again
// by putting `(pointer: coarse)` back.
//
// The browser half is tests/viewports/the-billing-gate-in-every-state-it-ships.spec.ts,
// which renders the page at 390px and at 1032px with touch on.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const PAYMENTS = "src/routes/_authenticated/payments.tsx";

/** Comment lines stripped, so the doc comment that explains the old rule in
 *  exactly the words this test looks for cannot fail it. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(
        t.startsWith("//") ||
        t.startsWith("*") ||
        t.startsWith("/*") ||
        t.startsWith("{/*")
      );
    })
    .join("\n");

/** The source of one top-level function, from its declaration to the next. */
function fn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `${PAYMENTS} no longer declares ${name}`).toBeGreaterThan(-1);
  const next = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("the Stripe dashboards on /payments are gated on width", () => {
  const src = read(PAYMENTS);
  const code = codeOnly(src);

  it("does not gate them on a coarse pointer", () => {
    expect(
      code,
      "payments.tsx asks useMediaQuery about the pointer again. That took Stripe's " +
        "dashboards away from every iPad (#494); gate on width",
    ).not.toMatch(/useMediaQuery\(\s*["'`]\(\s*pointer\s*:\s*coarse\s*\)/);
    expect(code).not.toMatch(/\bisTouch\b/);

    // The one place a coarse pointer may be read is the Stripe appearance,
    // which makes controls bigger and decides nothing about what renders.
    const appearance = fn(code, "connectAppearance");
    const outside = code.replace(appearance, "");
    expect(
      outside,
      "(pointer: coarse) is read outside connectAppearance(); the panels must key on width",
    ).not.toMatch(/pointer\s*:\s*coarse/);
  });

  it("gates them at 1024px", () => {
    const dash = fn(code, "ConnectDashboard");
    expect(dash).toContain('useMediaQuery("(min-width: 1024px)")');
    expect(dash).toMatch(/const narrow = !isWide;/);
    // Every Stripe dashboard is behind the same `narrow` switch, with the
    // replacement on the narrow side.
    for (const [what, component] of [
      ["Balance", "ConnectBalances"],
      ["Payouts", "ConnectPayouts"],
      ["Payments", "ConnectPayments"],
      ["Business details", "ConnectAccountManagement"],
    ]) {
      const replacement = dash.indexOf(`<NeedsAWiderScreen what="${what}"`);
      expect(replacement, `${what} has no narrow replacement`).toBeGreaterThan(-1);
      const before = dash.slice(0, replacement);
      expect(before.trimEnd().endsWith("{narrow ? ("), `${what} is not behind \`narrow ?\``).toBe(
        true,
      );
      expect(dash.indexOf(`<${component}`, replacement)).toBeGreaterThan(replacement);
    }
  });

  it("never gates onboarding, at any width", () => {
    const dash = fn(code, "ConnectDashboard");
    expect(dash).toContain("<ConnectAccountOnboarding");
    // The session is skipped only once the account is live AND the screen is
    // narrow; before that, onboarding needs it at every width.
    expect(dash).toContain("const replaced = narrow && chargesEnabled;");
    expect(dash).toContain("if (replaced) return;");
  });

  it("the replacement says the view needs a wider screen, not a computer", () => {
    const panel = fn(src, "NeedsAWiderScreen");
    expect(panel).toContain("needs a wider screen");
    expect(panel).not.toContain("phone or tablet");
    expect(panel).not.toContain("bigger screen");
    expect(panel).not.toMatch(/\bcomputer\b/);
    // Kept: the route to the view built for touch, and how to refund from it.
    expect(panel).toContain('to="/invoices"');
    expect(panel).toMatch(/open their invoice and press/);
  });
});
