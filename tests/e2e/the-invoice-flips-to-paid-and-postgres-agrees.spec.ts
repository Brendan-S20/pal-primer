// QA: "Invoice popup → Take payment → flips to Paid instantly". The first
// behavioural round trip: not "does /invoices render", which
// the-routes-the-qa-list-asks-about already proves, but "does acting on an
// invoice actually move money state".
//
// ── WHY MARK PAID AND NOT TAKE PAYMENT ────────────────────────────────────
//
// "Take payment" is the Stripe card form, and a local stack has no Stripe.
// "Mark paid" is the product's own out-of-band path — cash, check — and it is
// fully local: bulkMarkInvoicesPaid updates the invoice, inserts a payments
// row with raw_event.source = "manual_mark_paid", and its one Stripe touch
// (syncInvoicePaymentIntentAmount) short-circuits with "none" because seeded
// invoices carry no stripe_payment_intent_id. So this spec proves the whole
// non-Stripe half of the QA item: status flip, payment recorded, state
// survives a refresh. The card form stays with a person, like the one real
// charge the checklist keeps.
//
// ── AND HOW IT WAS PAID ───────────────────────────────────────────────────
//
// Since 2026-09-28 the action is "Record payment" and asks how the money came
// in and when. Until then the row said only `manual_mark_paid`, dated the
// moment somebody clicked, so a check received Friday and entered Monday was
// Monday's income on the cash-basis report. The spec records a CHECK with a
// number, received YESTERDAY, and asserts both land: the method and reference
// on the row, and a paid_at that reads as yesterday on the org's calendar.
//
// ── WHY THE ASSERTIONS COUNT ROWS RATHER THAN NAMING ONE ──────────────────
//
// The list draws client name + amount + status, none of which is unique on
// seeded data (ten clients, thirty-four invoices). Rather than guess at
// currency formatting to fingerprint a row, the spec acts on the FIRST open
// row and asserts three things that do not need its identity: the count of
// visible "Open" chips drops by exactly one and stays dropped through a full
// reload, and Postgres gains exactly one manual_mark_paid payment whose
// invoice is now 'paid'. Identity lives in the database half.

import { expect, test } from "@playwright/test";

import { pointTheBrowserAtTheLocalDatabase } from "./point-the-browser-at-the-local-database";
import { e2eOrgId, serviceDb } from "./service-db";
import { orgLocalDay, orgToday } from "../../src/lib/org-day";
import { signIn } from "./sign-in";

test.beforeEach(async ({ context }) => {
  await pointTheBrowserAtTheLocalDatabase(context, {
    url: process.env.SUPABASE_URL ?? "http://127.0.0.1:54421",
    anonKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  });
});

async function manualPaidCount(orgId: string) {
  const db = serviceDb();
  const { count, error } = await db
    .from("payments")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("raw_event->>source", "manual_mark_paid");
  if (error) throw new Error(`counting manual payments: ${error.message}`);
  return count ?? 0;
}

test("record payment flips the invoice, records how and when, and survives a refresh", async ({
  page,
}) => {
  // Several navigations and a reload on a machine that is measurably slow —
  // see the swap note in sandboxes.yml. The default 60s is for one-page specs.
  test.setTimeout(180_000);

  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const paymentsBefore = await manualPaidCount(orgId);
  const { data: org } = await db.from("organizations").select("timezone").eq("id", orgId).single();
  const tz = org?.timezone || "America/Chicago";
  const today = orgToday(tz);
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);

  await signIn(page);
  await page.goto("/invoices");

  // The status chip renders sentenceCase(status), so an open invoice's row
  // contains an element whose exact text is "Open". The filter chip and the
  // "Open invoices" stat card are not rows, and the "Open full invoice" menu
  // item renders in a portal outside the table.
  const openRows = page.getByRole("row").filter({ has: page.getByText("Open", { exact: true }) });

  await expect
    .poll(async () => openRows.count(), {
      message:
        "no open invoices on the page — seed_demo_org should produce some; " +
        "if this fails the fixture changed shape, not this spec",
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  const openBefore = await openRows.count();

  // Row click opens the drawer, so the entry point is the ••• menu.
  await openRows.first().getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Record payment" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Record payment" })).toBeVisible();
  await dialog.getByRole("button", { name: "Check" }).click();
  await dialog.getByLabel(/Check number/).fill("1042");
  await dialog.getByLabel("Received on").fill(yesterday);
  await dialog.getByRole("button", { name: "Record payment" }).click();

  await expect(page.getByText("Payment recorded. Invoice paid")).toBeVisible({ timeout: 20_000 });

  // The flip, in place: one fewer row wearing an "Open" chip.
  await expect.poll(async () => openRows.count(), { timeout: 20_000 }).toBe(openBefore - 1);

  // The database half: exactly one new payments row that says where it came
  // from, and the invoice it points at really is 'paid' with a paid_at.
  await expect.poll(() => manualPaidCount(orgId), { timeout: 20_000 }).toBe(paymentsBefore + 1);

  const { data: payment, error: payErr } = await db
    .from("payments")
    .select("invoice_id, status, amount_cents, method, reference, paid_at")
    .eq("organization_id", orgId)
    .eq("raw_event->>source", "manual_mark_paid")
    // created_at, not paid_at: this one is back-dated, so it is not the
    // latest by paid_at.
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (payErr) throw new Error(`reading the payment back: ${payErr.message}`);
  expect(payment.status).toBe("succeeded");
  expect(payment.method).toBe("check");
  expect(payment.reference).toBe("1042");
  expect(orgLocalDay(payment.paid_at!, tz), "paid_at on the org's calendar").toBe(yesterday);

  const { data: invoice, error: invErr } = await db
    .from("invoices")
    .select("status, paid_at")
    .eq("id", payment.invoice_id)
    .single();
  if (invErr) throw new Error(`reading the invoice back: ${invErr.message}`);
  expect(invoice.status).toBe("paid");
  expect(invoice.paid_at).toBe(payment.paid_at);

  // And the refresh: the state above came out of Postgres, so a full reload
  // must show the same one-fewer-open list, not a cache that forgot.
  await page.reload();
  await expect.poll(async () => openRows.count(), { timeout: 30_000 }).toBe(openBefore - 1);
});
