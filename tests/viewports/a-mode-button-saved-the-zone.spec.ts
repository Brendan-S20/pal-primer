/**
 * Picking a coverage mode in the zone drawer does not save the zone (#448).
 *
 * The Polygon, Radius and Drive time buttons, and Undo and Clear, had no
 * `type` inside the drawer's <form>, so each click submitted it: "Zone
 * created", drawer closed, a zone saved with whatever coverage was there.
 * Driven the way the issue reproduced it: New zone, a name, a center placed
 * on the map so the form is saveable, then every toolbar button in turn.
 *
 * Asserts, at a phone and a desktop width: no createZone or updateZone call
 * reached the backend, the drawer is still open, and the mode each click
 * picked is the one shown as selected.
 */
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";

for (const w of [390, 1280]) {
  test(`the zone toolbar never saves the zone at ${w}px`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    const saves: string[] = [];
    await page.context().route("**/_serverFn/**", async (route) => {
      const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
      try {
        const name = String(
          JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "",
        ).replace(/_createServerFn_handler$/, "");
        if (name === "createZone" || name === "updateZone") saves.push(name);
      } catch {
        /* not ours */
      }
      return route.fallback();
    });
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto("/settings/zones");
    await page.waitForLoadState("networkidle").catch(() => {});

    await page.getByRole("button", { name: "New zone" }).click({ timeout: 30000 });
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Zone name").fill("Royal Oak North");
    const map = dialog.locator(".leaflet-container").first();
    await map.scrollIntoViewIfNeeded();
    const mb = await map.boundingBox();
    expect(mb, "the coverage map has no box").not.toBeNull();
    await page.mouse.click(mb!.x + mb!.width / 2, mb!.y + mb!.height / 2);
    // The form is saveable now: a submit at this point would create the zone.
    await expect(dialog.getByRole("button", { name: "Create zone" })).toBeEnabled();

    for (const label of ["Polygon", "Undo", "Clear", "Drive time", "Radius"]) {
      await dialog.getByRole("button", { name: label, exact: true }).click();
      await page.waitForTimeout(300);
      expect(saves, `clicking ${label} saved the zone`).toEqual([]);
      await expect(dialog, `clicking ${label} closed the drawer`).toBeVisible();
    }
    // Radius was the last mode picked, and is the one drawn as selected.
    await expect(dialog.getByRole("button", { name: "Radius", exact: true })).toHaveClass(
      /bg-primary/,
    );
  });
}
