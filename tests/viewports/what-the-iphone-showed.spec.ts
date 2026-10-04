/**
 * What the owner's iPhone showed, measured at the widths it was seen at.
 *
 * Eight screenshots from a TestFlight build on 2026-10-04 (an iPhone 17 Pro,
 * 402pt wide), and not one of them was a fault the sweeps could have failed
 * on. The client-page sweep opens Services and Billing at 360px and passed:
 * a label running out through its own button border is not "off the side"
 * and not "clipped", and a title drawn over a price is neither either. So
 * this spec asks the specific questions, at 320 / 360 / 390 / 402 / 768 with
 * touch on (`pointer: coarse`, which is what turns the `touch:` floors on):
 *
 *   - no button is narrower than its own label (Add card, Add item);
 *   - the service card's title and price do not overlap, its meta line is
 *     not squeezed to a column of single words, and its warning box is as
 *     wide as its words;
 *   - the Fix a time entry dialog's inputs stay inside the dialog and do not
 *     sit on each other;
 *   - a full-height sheet pads by the safe-area insets (asserted in the CSS,
 *     because Chromium's insets are 0 — see that test);
 *   - the station form's actions clear the tab bar once scrolled to;
 *   - Add unit and Add station say what is missing instead of greying out.
 *
 * Fixtures are local to this file and layered over the shared stub backend:
 * a service billing for 3 dogs at a property with none, a commercial client
 * with a station, an empty unit roster. The shared dataset is left alone so
 * twenty other surfaces measure what they always measured.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import * as fx from "./fixtures/dataset";

const SIZES = [
  { width: 320, height: 568 },
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 402, height: 874 },
  { width: 768, height: 1024 },
];

const SECOND_PROPERTY = fx.PROPERTIES[1];
const STATION_ID = "abababab-0000-4000-8000-00000000ab01";

const SERVICE = {
  id: "ffffffff-0000-4000-8000-0000000000a1",
  client_id: fx.CLIENT_ID,
  // The property with NO dogs in the shared fixture, so the card draws the
  // amber "Bills for 3 dogs, but the property has 0" warning the owner saw.
  property_id: SECOND_PROPERTY.id,
  status: "active",
  frequency: "weekly",
  price_cents: 3_300,
  dog_count: 3,
  unit_count: null,
  started_on: fx.day(-86),
  starts_on: fx.day(-86),
  ends_on: null,
  billing_cadence: "postpaid",
  account_type: "residential",
  zone_id: null,
  preferred_weekdays: [5],
  earliest_time: null,
  latest_time: null,
};

/** Names the extra fixtures answer; everything else falls through to the
 *  shared stub backend. */
function overrides(commercial: boolean): Record<string, unknown> {
  return {
    listSubscriptionsForClient: { subscriptions: [SERVICE] },
    ...(commercial
      ? {
          getClient: {
            client: {
              ...fx.CLIENTS[0],
              account_type: "commercial",
              company: "Anastasia Vandermolen-Whitaker",
              organization_id: fx.ORG_ID,
            },
          },
          listStations: {
            stations: [
              {
                id: STATION_ID,
                property_id: fx.PROPERTY_ID,
                station_number: 1,
                label: "1",
                location_description: null,
                liner_size: "Small (8-10 gal)",
                section: null,
                active: true,
                latitude: fx.PROPERTIES[0].latitude,
                longitude: fx.PROPERTIES[0].longitude,
                last_serviced_on: null,
              },
            ],
          },
          listUnitsForClient: { units: [], incidents: [], reviewDogs: [] },
        }
      : {}),
    listItems: [
      {
        id: "12341234-0000-4000-8000-000000000001",
        name: "Paper",
        sku: "123",
        unit: "each",
        unit_cost_cents: 0,
        reorder_threshold: 10,
        on_hand: 10,
        category: null,
        archived_at: null,
      },
    ],
    listAssignments: [],
    listRecentMovements: [],
  };
}

function serverFnName(route: Route): string {
  const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
  try {
    const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
    return String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
  } catch {
    return "";
  }
}

async function signIn(page: Page, { commercial = false } = {}) {
  await installSignedInSession(page.context());
  await installStubBackend(page.context());
  const extra = overrides(commercial);
  // Registered after the shared stubs, so matched before them.
  await page.context().route("**/_serverFn/**", (route) => {
    const name = serverFnName(route);
    if (!(name in extra)) return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: extra[name] }),
    });
  });
}

async function openClientTab(page: Page, tab: string) {
  await page.goto(`/clients/${fx.CLIENT_ID}`, { waitUntil: "domcontentloaded" });
  // Proof this is the client page and not /auth, and that the fixture arrived.
  await expect(page.getByRole("tab", { name: "Reviews & referrals" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Anastasia Vandermolen-Whitaker").first()).toBeVisible();
  const t = page.getByRole("tab", { name: tab, exact: true }).first();
  await t.click();
  await expect(t).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(500);
}

/** Every visible button or button-styled link whose content is wider than its
 *  own box while its overflow is visible: a label drawn out through the
 *  border. Truncating controls (overflow hidden) are another rule's business. */
async function findControlsNarrowerThanTheirLabel(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>('button, a[role="button"], [data-slot="button"]'),
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // A label is text. A checkbox draws its hit area wider than its 14px
      // box on purpose, and an icon button has nothing to spill.
      if (/^(checkbox|switch|radio)$/.test(el.getAttribute("role") ?? "")) continue;
      if (!(el.textContent ?? "").trim()) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.overflowX !== "visible") continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
        out.push(`"${label}": content ${el.scrollWidth}px in a ${el.clientWidth}px button`);
      }
    }
    return out;
  });
}

for (const size of SIZES) {
  test.describe(`what the iPhone showed, at ${size.width}px`, () => {
    test.use({
      viewport: size,
      isMobile: size.width < 768,
      hasTouch: true,
      deviceScaleFactor: 2,
    });

    test("Billing: Add card is as wide as its label", async ({ page }) => {
      await signIn(page);
      await openClientTab(page, "Billing");
      const add = page.getByRole("button", { name: "Add card" }).first();
      await expect(add).toBeVisible();
      const box = (await add.boundingBox())!;
      expect(box.x + box.width, "Add card runs past the screen edge").toBeLessThanOrEqual(
        size.width,
      );
      expect(await findControlsNarrowerThanTheirLabel(page)).toEqual([]);
    });

    test("Inventory: Add item is as wide as its label and on the screen", async ({ page }) => {
      await signIn(page);
      await page.goto("/inventory", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Inventory" })).toBeVisible({
        timeout: 30_000,
      });
      // Proof the fixture arrived: the item row, not an empty table.
      await expect(page.getByText("Paper").first()).toBeVisible();
      const add = page.getByRole("button", { name: "Add item" }).first();
      const box = (await add.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(size.width - 8);
      expect(await findControlsNarrowerThanTheirLabel(page)).toEqual([]);
    });

    test("Services: the card is not crushed beside its actions", async ({ page }) => {
      await signIn(page);
      await openClientTab(page, "Services");
      const title = page.getByText("Recurring pet waste removal").first();
      await expect(title).toBeVisible();
      const card = page.locator("li", { has: title }).first();
      // The visible price: below sm it is the one in the title row.
      const price = card.locator("span", { hasText: "$33.00" }).locator("visible=true").first();
      const warning = card.getByText(/Bills for 3 dogs/).first();
      await expect(warning).toBeVisible();

      const [t, p, c] = await Promise.all([
        title.boundingBox(),
        price.boundingBox(),
        card.boundingBox(),
      ]);
      const overlap =
        t!.x < p!.x + p!.width &&
        p!.x < t!.x + t!.width &&
        t!.y < p!.y + p!.height &&
        p!.y < t!.y + t!.height;
      expect(overlap, "the title is drawn over the price").toBe(false);

      // The meta line ("Weekly · <street> · 3 dogs") had about 80px on the
      // owner's phone and went one word per line. It must get most of the card.
      const meta = card.getByText(/Weekly ·/).first();
      const m = (await meta.boundingBox())!;
      expect(m.width, "the meta line is squeezed").toBeGreaterThan(c!.width * 0.6);

      // The warning box is at least as wide as its own words.
      const box = warning.locator("xpath=..");
      const sw = await box.evaluate((el) => [el.scrollWidth, el.clientWidth]);
      expect(sw[0], "the warning's text runs out of its box").toBeLessThanOrEqual(sw[1] + 1);
      expect(await findControlsNarrowerThanTheirLabel(page)).toEqual([]);
    });

    test("Edit service opens a sheet that pads by the safe-area insets", async ({ page }) => {
      // Chromium reports every safe-area inset as 0, and the hosted build does
      // not opt into viewport-fit=cover, so the real inset can only be seen on
      // a device. What CAN be proved here is that the rules are in the CSS
      // and apply to the sheet that opened: its padding-top and the close
      // button's top both reference env(safe-area-inset-top), and its padding
      // bottom references env(safe-area-inset-bottom).
      await signIn(page);
      await openClientTab(page, "Services");
      await page.getByRole("button", { name: "Edit", exact: true }).first().click();
      const sheet = page.getByRole("dialog", { name: "Edit service" });
      await expect(sheet).toBeVisible();
      const found = await sheet.evaluate((el) => {
        const close = Array.from(el.querySelectorAll(":scope > button")).find(
          (b) => b.textContent?.trim() === "Close",
        ) as HTMLElement | undefined;
        const decl = (target: Element, prop: string): string[] => {
          const hits: string[] = [];
          const walk = (rules: CSSRuleList) => {
            for (const r of Array.from(rules)) {
              if (r instanceof CSSStyleRule) {
                let matches = false;
                try {
                  matches = target.matches(r.selectorText);
                } catch {
                  /* a selector this engine cannot parse is not one that matched */
                }
                const v = r.style.getPropertyValue(prop);
                if (matches && v) hits.push(v);
              }
              if ("cssRules" in r && (r as CSSGroupingRule).cssRules) {
                walk((r as CSSGroupingRule).cssRules);
              }
            }
          };
          for (const s of Array.from(document.styleSheets)) {
            try {
              walk(s.cssRules);
            } catch {
              /* cross-origin sheet */
            }
          }
          return hits;
        };
        return {
          paddingTop: decl(el, "padding-top"),
          paddingBottom: decl(el, "padding-bottom"),
          closeTop: close ? decl(close, "top") : [],
          closeBox: close ? close.getBoundingClientRect().height : 0,
        };
      });
      expect(found.paddingTop.join(" | ")).toContain("safe-area-inset-top");
      expect(found.paddingBottom.join(" | ")).toContain("safe-area-inset-bottom");
      expect(found.closeTop.join(" | ")).toContain("safe-area-inset-top");
      expect(found.closeBox, "the close button lost its 44px box").toBeGreaterThanOrEqual(44);
    });

    test("Timesheets: Fix a time entry keeps both inputs inside the dialog", async ({ page }) => {
      // iOS draws a native date or time control at the width of its value and
      // will not go narrower: ~195px each on the owner's phone. Chromium's
      // controls are narrower, so the fault does not reproduce here unless
      // WebKit's floor is imposed. That is what this does.
      await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", () => {
          const s = document.createElement("style");
          s.textContent = 'input[type="date"], input[type="time"] { min-width: 195px; }';
          document.head.appendChild(s);
        });
      });
      await signIn(page);
      await page.goto("/timesheets", { waitUntil: "domcontentloaded" });
      await expect(page.getByText(fx.LONG_STAFF_NAME).first()).toBeVisible({ timeout: 30_000 });
      // A day with time on it, then its first entry's Edit.
      await page
        .getByRole("button", { name: /\d+h/ })
        .filter({ hasText: /h/ })
        .first()
        .click();
      await page.getByRole("button", { name: "Edit", exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: "Fix a time entry" });
      await expect(dialog).toBeVisible();
      const d = (await dialog.boundingBox())!;
      const date = (await dialog.getByLabel("Clock-in date").boundingBox())!;
      const time = (await dialog.getByLabel("Clock-in time").boundingBox())!;
      for (const [name, b] of [
        ["date", date],
        ["time", time],
      ] as const) {
        expect(b.x, `${name} starts left of the dialog`).toBeGreaterThanOrEqual(d.x - 1);
        expect(b.x + b.width, `${name} runs past the dialog`).toBeLessThanOrEqual(
          d.x + d.width + 1,
        );
      }
      const sameRow = date.y < time.y + time.height && time.y < date.y + date.height;
      if (sameRow) {
        expect(date.x + date.width, "the time input sits on the date").toBeLessThanOrEqual(
          time.x + 1,
        );
      }
    });

    test("Add station says what is missing, and its actions clear the tab bar", async ({
      page,
    }) => {
      await signIn(page, { commercial: true });
      await openClientTab(page, "Services");
      await page.getByRole("button", { name: "Add station" }).first().click();
      const submit = page.getByRole("button", { name: "Add station" }).last();
      await expect(submit).toBeEnabled();
      await submit.click();
      const label = page.locator("#station-label");
      await expect(label).toHaveAttribute("aria-invalid", "true");
      await expect(page.locator("#station-label-error")).toBeVisible();
      await expect(label).toBeFocused();
      await expect(page.getByText(/A new station needs one/)).toBeVisible();

      // The owner's screenshot showed the action row half under the tab bar.
      // Scrolled to the end of the page, it must be fully above it.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(300);
      const bar = page.locator("nav[data-bottom-chrome]");
      const cancel = page.getByRole("button", { name: "Cancel", exact: true }).last();
      const c = (await cancel.boundingBox())!;
      if (await bar.isVisible()) {
        const b = (await bar.boundingBox())!;
        expect(c.y + c.height, "the station form's actions are under the tab bar").toBeLessThanOrEqual(
          b.y,
        );
      }
    });

    test("Add unit says what is missing instead of greying out", async ({ page }) => {
      await signIn(page, { commercial: true });
      await openClientTab(page, "Units");
      await page.getByRole("button", { name: "Add unit" }).first().click();
      const sheet = page.getByRole("dialog", { name: "Add unit" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText("Resident name (optional)")).toBeVisible();
      const submit = sheet.getByRole("button", { name: "Add unit" });
      await expect(submit).toBeEnabled();
      await submit.click();
      const label = sheet.locator("#unit-label");
      await expect(label).toHaveAttribute("aria-invalid", "true");
      await expect(sheet.locator("#unit-label-error")).toBeVisible();
      await expect(label).toBeFocused();
    });
  });
}
