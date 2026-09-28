// An import brings the business, not just the address book.
//
// Until 2026-09-28 a Jobber shop moving over could import clients,
// properties and dogs, and then had to rebuild every recurring plan by hand
// and could not carry over what anyone owed (persona review, 2026-09-27).
// This drives the real import screen against Postgres: a services file makes
// plans with their price and day and puts visits on the schedule, and a
// balances file makes open invoices marked as opening balances.

import { expect, test } from "@playwright/test";

import { pointTheBrowserAtTheLocalDatabase } from "./point-the-browser-at-the-local-database";
import { e2eOrgId, serviceDb } from "./service-db";
import { signIn } from "./sign-in";

test.beforeEach(async ({ context }) => {
  await pointTheBrowserAtTheLocalDatabase(context, {
    url: process.env.SUPABASE_URL ?? "http://127.0.0.1:54421",
    anonKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  });
});

async function importFile(
  page: import("@playwright/test").Page,
  kind: string,
  csv: string,
): Promise<void> {
  await page.goto("/imports");
  await page.getByLabel("What are you importing?").selectOption({ label: kind });
  await page.locator('input[type="file"]').setInputFiles({
    name: "import.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.getByRole("button", { name: "Dry-run preview" }).click();
  await page.getByRole("button", { name: /Commit import \(\d+ rows\)/ }).click({ timeout: 60_000 });
  await expect(page.getByText(/Import committed: \d+ created/)).toBeVisible({ timeout: 60_000 });
}

test("a services file makes plans with visits, and a balances file makes open invoices", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const stamp = Date.now();
  const names = [`Import Probe A ${stamp}`, `Import Probe B ${stamp}`];

  const clientIds: string[] = [];
  try {
    for (const [i, name] of names.entries()) {
      const { data: c, error } = await db
        .from("clients")
        .insert({ organization_id: orgId, account_type: "residential", display_name: name })
        .select("id")
        .single();
      if (error) throw new Error(`seed client: ${error.message}`);
      clientIds.push(c.id);
      await db.from("properties").insert({
        organization_id: orgId,
        client_id: c.id,
        street: `${10 + i} Import Probe Ln`,
        city: "New York",
        postal_code: "10024",
      });
    }

    await signIn(page);

    await importFile(
      page,
      "Recurring services (plans and prices)",
      [
        "client_name,frequency,price,day",
        `${names[0]},Every 2 weeks,$32.00,Tuesday`,
        `${names[1]},Weekly,27.50,Thu`,
      ].join("\n"),
    );

    const { data: subs } = await db
      .from("subscriptions")
      .select("client_id, frequency, price_cents, preferred_weekdays")
      .in("client_id", clientIds)
      .order("price_cents");
    expect(subs).toEqual([
      { client_id: clientIds[1], frequency: "weekly", price_cents: 2750, preferred_weekdays: [4] },
      { client_id: clientIds[0], frequency: "biweekly", price_cents: 3200, preferred_weekdays: [2] },
    ]);
    const { count: visits } = await db
      .from("visits")
      .select("id", { count: "exact", head: true })
      .in("client_id", clientIds);
    expect(visits ?? 0, "visits generated at commit, not tonight").toBeGreaterThan(0);

    await importFile(
      page,
      "Opening balances (money owed)",
      ["client_name,balance,note", `${names[0]},$64.00,August cleanups`].join("\n"),
    );
    const { data: invs } = await db
      .from("invoices")
      .select("status, total_cents, notes, sent_at")
      .eq("client_id", clientIds[0]);
    expect(invs).toEqual([
      { status: "open", total_cents: 6400, notes: "Opening balance: August cleanups", sent_at: null },
    ]);
  } finally {
    if (clientIds.length) {
      const { data: invs } = await db.from("invoices").select("id").in("client_id", clientIds);
      const invIds = (invs ?? []).map((r) => r.id);
      if (invIds.length) {
        await db.from("invoice_line_items").delete().in("invoice_id", invIds);
        await db.from("invoices").delete().in("id", invIds);
      }
      await db.from("visits").delete().in("client_id", clientIds);
      await db.from("subscriptions").delete().in("client_id", clientIds);
      await db.from("properties").delete().in("client_id", clientIds);
      await db.from("activity_log").delete().in("client_id", clientIds);
      await db.from("clients").delete().in("id", clientIds);
    }
  }
});
