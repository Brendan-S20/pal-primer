// QA: "Disputes (/disputes). The dispute queue: open one, work it, confirm it
// leaves the queue." — which this spec deliberately does NOT do, because the
// product deliberately cannot. src/lib/disputes.functions.ts is explicit:
// outcomes come from Stripe's webhook, and a "mark as won" button would let
// the app disagree with the money. So the QA item as written is untestable BY
// DESIGN, and this spec covers what the page actually is:
//
//   1. a planted chargeback (the row the Stripe webhook would write; the seed
//      writes none and a local stack has no Stripe) renders as an open
//      dispute with the copy that tells an owner where evidence really goes;
//   2. the page's one write — the "count open disputes as revenue" switch —
//      round-trips: organizations.disputes_in_analytics flips, the label
//      flips, and a full reload still shows the flipped label.
//
// The switch is toggled relative to whatever state the org is in and toggled
// back at the end, so the spec is idempotent across runs and leaves analytics
// the way it found them.

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

const DISPUTE_KINDS = [
  "payment_dispute_inquiry",
  "payment_dispute_inquiry_closed",
  "payment_chargeback",
  "payment_chargeback_won",
  "payment_chargeback_lost",
];

async function disputesInAnalytics(orgId: string): Promise<boolean> {
  const db = serviceDb();
  const { data, error } = await db
    .from("organizations")
    .select("disputes_in_analytics")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(`reading disputes_in_analytics: ${error.message}`);
  return Boolean(data.disputes_in_analytics);
}

test("a chargeback shows up read-only, and the one switch survives a refresh", async ({ page }) => {
  test.setTimeout(180_000);

  const db = serviceDb();
  const orgId = await e2eOrgId(db);

  // Clear only dispute-kind rows: a reseed deletes payments out from under
  // last run's rows without deleting the rows, and stale "Unknown customer"
  // cards would make the assertions below about the wrong dispute.
  const { error: clearErr } = await db
    .from("review_items")
    .delete()
    .eq("organization_id", orgId)
    .in("kind", DISPUTE_KINDS);
  if (clearErr) throw new Error(`clearing dispute rows: ${clearErr.message}`);

  // Point at a real payment when one exists so the customer resolves; a
  // random subject still renders (as "Unknown customer"), which is the
  // webhook-raced case the page already has to survive.
  const { data: payment } = await db
    .from("payments")
    .select("id, amount_cents")
    .eq("organization_id", orgId)
    .eq("status", "succeeded")
    .order("paid_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error: insErr } = await db.from("review_items").insert({
    organization_id: orgId,
    kind: "payment_chargeback",
    subject_table: "payments",
    subject_id: payment?.id ?? crypto.randomUUID(),
    reason: "Customer disputed the charge as unrecognized",
    detail: { amount_cents: payment?.amount_cents ?? 4200 },
    dispute_ref: "du_e2e_witnessed_1",
  });
  if (insErr) throw new Error(`planting the chargeback: ${insErr.message}`);

  const before = await disputesInAnalytics(orgId);

  await signIn(page);
  await page.goto("/disputes");

  await expect(page.getByRole("heading", { name: "Disputes" })).toBeVisible({ timeout: 30_000 });

  // The planted chargeback, wearing the honest copy: an open dispute with
  // money withdrawn, and the pointer at where evidence actually goes.
  await expect(page.getByText("Open, money withdrawn")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Evidence is submitted in Stripe, not here\./)).toBeVisible();

  // The page's one write. Relative to current state, so reruns don't flap.
  const toggle = page.getByRole("switch");
  await expect(page.getByText(before ? "Counted" : "Deducted")).toBeVisible();
  await toggle.click();

  await expect(
    page.getByText(
      before
        ? "Open disputes are now deducted from your analytics"
        : "Open disputes are now counted in your analytics",
    ),
  ).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => disputesInAnalytics(orgId), { timeout: 20_000 }).toBe(!before);

  // The refresh half: the flipped label came out of Postgres.
  await page.reload();
  await expect(page.getByText(!before ? "Counted" : "Deducted")).toBeVisible({ timeout: 30_000 });

  // Put it back the way it was found.
  await page.getByRole("switch").click();
  await expect.poll(() => disputesInAnalytics(orgId), { timeout: 20_000 }).toBe(before);
});
