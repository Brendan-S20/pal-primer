// The store screenshot story, shared by the App Store spec
// (app-store-screenshots.spec.ts) and the Play spec
// (play-store-screenshots.spec.ts). One list, so the two listings tell the
// same story in the same order and a change to one is a change to both.
import { expect, type Page } from "@playwright/test";
import { FIRST_PAINT_MS } from "./first-paint";

/** The story a reviewer reads top to bottom, in order.
 *
 *  Deliberately NOT one shot per feature. Five screenshots that say "this is
 *  the day, this is the round, this is the customer, this is the money" beat
 *  ten that say "there is also a settings page". */
export const STORE_SHOTS: Array<{
  name: string;
  path: string;
  ready: (p: Page) => Promise<void>;
}> = [
  {
    name: "todays-work",
    path: "/dashboard",
    ready: async (p) => {
      await expect(p.getByText("Today's schedule", { exact: false }).first()).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
    },
  },
  {
    // BOARD, not Map. The map draws its pins and its per-technician route lines
    // beautifully and then draws them on a SOLID RED RECTANGLE, because the
    // fence blocks tile requests and the container's fallback colour shows
    // through. Letting tiles out would send coordinates to a tile server and
    // break the one guarantee that makes this harness safe to run.
    //
    // The board is the better picture anyway: one column per technician, the
    // round in order, which is the thing being sold.
    name: "the-round",
    path: "/routes",
    ready: async (p) => {
      await expect(p.getByRole("button", { name: "Auto-routing" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await p.getByRole("button", { name: "Board", exact: true }).click();
      await p.waitForTimeout(400);
    },
  },
  {
    name: "auto-routing",
    path: "/routes",
    ready: async (p) => {
      const btn = p.getByRole("button", { name: "Auto-routing" });
      await expect(btn).toBeVisible({ timeout: FIRST_PAINT_MS });
      await btn.click();
      // The panel is now three things: who, which days, Apply. Which is the
      // point of the screenshot.
      await expect(p.getByRole("dialog", { name: "Auto-routing" })).toBeVisible();
    },
  },
  {
    name: "the-customer",
    path: "/clients",
    ready: async (p) => {
      await expect(p.getByRole("heading", { name: "Clients", exact: true }).first()).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
    },
  },
  {
    name: "getting-paid",
    path: "/invoices",
    ready: async (p) => {
      await p.waitForLoadState("networkidle").catch(() => {});
    },
  },
];
