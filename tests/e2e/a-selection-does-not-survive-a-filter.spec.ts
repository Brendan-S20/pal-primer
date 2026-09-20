// QA: "Bulk bars everywhere ... (switch filters and confirm selection
// clears)". Two bulk bars stand in for the family: invoices (the one the QA
// line names for the clearing rule) and concerns (a queue whose bulk action
// is safe on a local stack — resolving qc_tickets sends nothing anywhere,
// unlike invoices' "Send invoices", which is a Resend loop this suite must
// never press).
//
// The clearing rule is useRowSelection's clearKey: any filter change wipes
// the Set, which unmounts the whole bar. A selection that SURVIVED a filter
// switch is the bug this guards against — bulk-voiding what you can no
// longer see.

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

test("invoices: switching the status filter clears the selection", async ({ page }) => {
  test.setTimeout(180_000);

  await signIn(page);
  await page.goto("/invoices");
  await expect(page.getByText("Invoices generate automatically")).toBeVisible({ timeout: 30_000 });

  await page.getByLabel("Select all invoices").filter({ visible: true }).first().click();
  const bar = page.getByText(/\d+ selected/);
  await expect(bar).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Paid", exact: true }).click();
  await expect(bar).not.toBeVisible({ timeout: 20_000 });

  // And back again, to prove the clear was the FILTER and not a one-off.
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(bar).not.toBeVisible();
});

test("concerns: the filter clears the selection, and bulk resolve empties the queue", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const db = serviceDb();
  const orgId = await e2eOrgId(db);

  // Own the queue: put the two unresolved seeded tickets back the way
  // seed_demo_org writes them (one open, one 'acknowledged' — a status
  // outside the filter chips that only the All view can see, which is
  // exactly why bulk-resolving from All is the case worth pinning).
  await db
    .from("qc_tickets")
    .update({ status: "open", resolved_at: null, resolved_by: null })
    .eq("organization_id", orgId)
    .eq("kind", "gate_left_open");
  await db
    .from("qc_tickets")
    .update({ status: "acknowledged", resolved_at: null, resolved_by: null })
    .eq("organization_id", orgId)
    .eq("kind", "other");

  await signIn(page);
  await page.goto("/concerns");
  await expect(page.getByText("Issues clients submit from their portal")).toBeVisible({
    timeout: 30_000,
  });

  // Received (the default) shows the one open ticket; select it.
  await page.getByLabel("Select all unresolved concerns").click();
  const bar = page.getByText(/\d+ selected/);
  await expect(bar).toBeVisible({ timeout: 20_000 });

  // The filter switch is also what surfaces the second, off-chip ticket.
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(bar).not.toBeVisible({ timeout: 20_000 });

  await page.getByLabel("Select all unresolved concerns").click();
  await expect(page.getByText("2 selected")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Mark resolved" }).first().click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("Resolve 2 concerns?")).toBeVisible();
  await dialog.getByRole("button", { name: "Mark resolved" }).click();
  await expect(page.getByText("Resolved 2 concerns")).toBeVisible({ timeout: 20_000 });

  // Postgres holds the decision, with the who and the when.
  await expect
    .poll(
      async () => {
        const { count } = await db
          .from("qc_tickets")
          .select("*", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("status", "resolved")
          .not("resolved_by", "is", null);
        return count ?? 0;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(2);

  // And the queue is worked: a reload's Received view has nothing to select.
  await page.reload();
  await expect(page.getByText("Issues clients submit from their portal")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel("Select all unresolved concerns")).not.toBeVisible({
    timeout: 20_000,
  });
});
