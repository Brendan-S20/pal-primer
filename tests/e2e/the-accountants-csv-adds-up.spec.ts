// QA: "Tax reports (/tax-reports). The screen an owner sends to an
// accountant: figures right, export lands."
//
// "Export lands" is a real browser download — downloadCsv builds a Blob and
// clicks a detached anchor, so the assertion is Playwright's download event
// plus the file's contents, not a network response. "Figures right" is the
// income report's Total row checked against the same query the server runs:
// succeeded/refunded payments for the org, year to date. The seed writes no
// refunds, which buys a second, seed-independent invariant for free: Net
// income must equal Gross received, or a refund appeared from nowhere.

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

test("the income CSV downloads, and its Total row matches Postgres", async ({ page }) => {
  test.setTimeout(180_000);

  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const year = new Date().getFullYear();

  // The same population the report reads: succeeded + refunded payments,
  // bucketed year-to-date. (Mark-paid specs add succeeded payments; that is
  // fine — this count is taken NOW, after any earlier spec's writes.)
  const { data: payments, error } = await db
    .from("payments")
    .select("amount_cents, paid_at, created_at")
    .eq("organization_id", orgId)
    .in("status", ["succeeded", "refunded"])
    .gte("created_at", `${year}-01-01`);
  if (error) throw new Error(`payments for the cross-check: ${error.message}`);
  expect(payments!.length, "seeded payments exist to sum").toBeGreaterThan(0);

  await signIn(page);
  await page.goto("/tax-reports");
  await expect(page.getByText("Tax & accountant reports")).toBeVisible({ timeout: 30_000 });
  // income_cash is the default selection and Year to date the default range;
  // wait for its table to have real rows before downloading.
  await expect(page.getByRole("cell", { name: "Total" })).toBeVisible({ timeout: 30_000 });

  const downloadP = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV" }).click();
  const download = await downloadP;

  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^e2e-demo-yard_income_cash_${year}-01-01_to_\\d{4}-\\d{2}-\\d{2}\\.csv$`),
  );

  const path = await download.path();
  const { readFileSync } = await import("node:fs");
  // downloadCsv prepends a UTF-8 BOM so Excel reads it right; strip it here.
  const csv = readFileSync(path!, "utf8").replace(/^﻿/, "");
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");

  expect(lines[0]).toBe("Month,Gross received,Refunds & chargebacks,Net income,Payments");

  const total = lines.find((l) => l.startsWith("Total,"));
  expect(total, "a Total row in the CSV").toBeTruthy();
  const [, gross, refunds, net, count] = total!.split(",");

  // Net is arithmetic, not a copy: gross minus refunds-and-chargebacks, to
  // the cent. (An earlier draft asserted refunds === 0 off the seed — and the
  // dispute spec's planted chargeback correctly landed in this column when
  // the whole suite ran, because the report nets chargebacks exactly as its
  // own description promises. The invariant that survives other specs is the
  // subtraction, not the zero.)
  expect(Math.round(Number(net) * 100)).toBe(
    Math.round(Number(gross) * 100) - Math.round(Number(refunds) * 100),
  );

  // Figures right: the payment COUNT is the cheapest exact cross-check (the
  // gross involves org-timezone day bucketing this spec should not re-derive;
  // the count is bucket-independent inside a YTD window in September).
  expect(Number(count)).toBe(payments!.length);
  const grossCents = Math.round(Number(gross) * 100);
  const dbCents = payments!.reduce((n, p) => n + (p.amount_cents ?? 0), 0);
  expect(grossCents).toBe(dbCents);
});
