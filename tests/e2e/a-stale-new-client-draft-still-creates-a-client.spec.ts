// #784, the second time: Create client failed with "Cannot read properties
// of undefined (reading 'trim')" on a wizard that had opened on a kept draft.
//
// Onboarding QA, 2026-11-11, live build 3a028504: after client 1 saved,
// reopening New client said "We kept what you typed here last time on this
// device", stuck at step 2. Create client from that draft failed three times
// with the trim error; Discard draft and typing it again worked.
//
// #798 kept the error on screen; it did not stop it. The wizard restored every
// stored field straight into its setter, and a draft written by an older
// build has no key for a field added since, so the field became `undefined`.
// a-second-client-with-a-manual-price-is-created.spec.ts never restored a
// draft and always typed every field, so it could not see this path.
//
// This spec plants a draft in the OLD shape -- no primaryEmail, accessNotes,
// officeNote or anything added after them, on step 2 -- then drives the real
// wizard against the real database to a created client: the second (or
// eleventh) client of the seeded business, with no email, at a typed price.
// The pure half is tests/a-stale-new-client-draft-loads-safely.test.ts.

import { expect, test, type Page } from "@playwright/test";

import { e2eOrgId, serviceDb } from "./service-db";
import { signIn, waitForHydration } from "./sign-in";

/** What the wizard kept before email, notes and the plan's later choices
 *  were part of its draft. Every key a later build added is missing. */
function oldShapeDraft(name: string) {
  return {
    step: 2,
    displayName: name,
    accountType: "residential",
    primaryPhone: "",
    street: "200 Test Ave",
    city: "Lansing",
    region: "MI",
    postalCode: "48933",
    dogs: [{ name: "Testdog2", breed: "", weightClass: "" }],
    frequency: "weekly",
    priceOverride: "",
  };
}

async function plantDraft(page: Page, orgId: string, value: unknown) {
  await page.evaluate(
    ({ orgId, value }) => {
      let userId: string | null = null;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !/^sb-.*-auth-token$/.test(k)) continue;
        userId = JSON.parse(localStorage.getItem(k) ?? "null")?.user?.id ?? null;
      }
      if (!userId) throw new Error("no signed-in user in storage to key the draft by");
      localStorage.setItem(
        `hs:form-draft:${userId}:${orgId}:new-client`,
        JSON.stringify({ v: 1, savedAt: Date.now(), value }),
      );
    },
    { orgId, value },
  );
}

async function clientsNamed(name: string) {
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const { data } = await db
    .from("clients")
    .select("id, primary_email, subscriptions(price_cents)")
    .eq("organization_id", orgId)
    .eq("display_name", name);
  return data ?? [];
}

async function removeClientsNamed(name: string) {
  const db = serviceDb();
  for (const r of await clientsNamed(name)) await db.from("clients").delete().eq("id", r.id);
}

test("a client is created from a draft kept by an older build", async ({ page }) => {
  test.setTimeout(150_000);
  const name = `QA Stale Draft Client (fake) ${Date.now()}`;
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const { count } = await db
    .from("clients")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  expect(count ?? 0, "not the business's first client").toBeGreaterThan(0);

  try {
    await signIn(page);
    await plantDraft(page, orgId, oldShapeDraft(name));

    await page.goto("/clients/new");
    await waitForHydration(page, "[aria-current='step']");
    await expect(
      page.getByText(/we kept what you typed here last time on this device/i),
      "the wizard opened on the stale draft, as the tester's did",
    ).toBeVisible({ timeout: 20_000 });

    // Forward to Plan from wherever the draft put us, as the tester did.
    const create = page.getByRole("button", { name: /^create client$/i });
    for (let i = 0; i < 5; i++) {
      if (await create.isVisible()) break;
      const stepBefore = await page.locator("[aria-current='step']").getAttribute("aria-label");
      await page.getByRole("button", { name: /^continue$/i }).click();
      await expect(page.locator("[aria-current='step']")).not.toHaveAttribute(
        "aria-label",
        stepBefore ?? "",
      );
    }
    await expect(create).toBeVisible();

    await page.locator("#po").fill("$20");
    await expect(create).toBeEnabled();
    await create.click();

    await expect
      .poll(
        async () => {
          if (/\/clients\/[0-9a-f-]{36}/.test(page.url())) return "navigated";
          const alert = page.getByTestId("create-client-error");
          if (await alert.count()) return `error: ${await alert.innerText()}`;
          return "nothing";
        },
        { timeout: 30_000, message: "Create client created the client" },
      )
      .toBe("navigated");

    const rows = await clientsNamed(name);
    expect(rows.length, "exactly one client written").toBe(1);
    const row = rows[0] as {
      primary_email: string | null;
      subscriptions: Array<{ price_cents: number }>;
    };
    expect(row.primary_email ?? "", "no email, as in the draft").toBe("");
    expect(
      row.subscriptions.map((s) => s.price_cents),
      "the plan at the typed price",
    ).toEqual([2000]);
    expect(pageErrors, "nothing thrown in the page").toEqual([]);

    // The saved draft is gone: the next New client opens blank, not on the
    // client just created.
    await page.goto("/clients/new");
    await waitForHydration(page, "#dn");
    await expect(page.locator("#dn")).toHaveValue("");
    await expect(page.getByText(/we kept what you typed here last time/i)).toHaveCount(0);
  } finally {
    await removeClientsNamed(name);
  }
});
