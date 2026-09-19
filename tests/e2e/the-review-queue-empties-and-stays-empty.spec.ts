// QA: "Review queue (/review). Same shape — a queue that must empty."
//
// ── WHY THE ITEM IS PLANTED RATHER THAN SEEDED ────────────────────────────
//
// seed_demo_org writes nothing into review_items — its "QC tickets" are
// qc_tickets rows, which surface on /concerns. Review items are filed by the
// nightly hook's detect_review_items(), and the seeded fixture is deliberately
// too healthy to trip it: every completed visit took 26 minutes, the one
// in_progress visit is today's. So the spec plants one row the way the
// detector would (service role; review_items has no INSERT policy, which is
// correct — only the machinery files these), pointing at a real visit so the
// card can resolve what it is about. It clears the org's review_items first,
// because the empty-state assertion below is only meaningful on a queue this
// spec owns, and reseeding deletes payments/visits out from under old rows
// without deleting the rows.
//
// ── WHAT "EMPTIES" MEANS HERE ─────────────────────────────────────────────
//
// Not "the element disappeared" — that passes on a filter change, a crash, a
// blank page. The queue has emptied when: the open list draws its named empty
// state; a full reload still draws it (the decision reached Postgres); the
// Resolved filter shows the same item wearing the note that was typed; and
// the row itself says status='resolved' with a resolved_by.

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

const NOTE = "E2E: confirmed with the tech, the visit was finished; clock drift on the tablet.";

test("working the one open item empties the queue, and the decision sticks", async ({ page }) => {
  test.setTimeout(180_000);

  const db = serviceDb();
  const orgId = await e2eOrgId(db);

  // Own the queue: earlier runs' rows point at visits a reseed has deleted.
  const { error: clearErr } = await db.from("review_items").delete().eq("organization_id", orgId);
  if (clearErr) throw new Error(`clearing review_items: ${clearErr.message}`);

  const { data: visit, error: visitErr } = await db
    .from("visits")
    .select("id")
    .eq("organization_id", orgId)
    .limit(1)
    .single();
  if (visitErr) throw new Error(`finding a seeded visit: ${visitErr.message}`);

  const { data: planted, error: insErr } = await db
    .from("review_items")
    .insert({
      organization_id: orgId,
      kind: "visit_stuck_in_progress",
      subject_table: "visits",
      subject_id: visit.id,
      reason: "This visit was left in progress and its scheduled day has passed.",
      detail: {},
      dispute_ref: "",
    })
    .select("id")
    .single();
  if (insErr) throw new Error(`planting the review item: ${insErr.message}`);

  await signIn(page);
  await page.goto("/review");

  await expect(page.getByRole("heading", { name: "Needs review" })).toBeVisible({ timeout: 30_000 });
  // exact, because the card's own reason copy contains the phrase in lowercase
  // and an inexact getByText matches both.
  await expect(page.getByText("Left in progress", { exact: true })).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Record a decision" }).click();
  await page.getByLabel(/what did you find/i).fill(NOTE);

  // Two buttons are named "Resolved" while the form is open: the filter pill
  // at the top of the page and the form's submit inside the card. DOM order
  // puts the pills first, so .last() is the card's.
  await page.getByRole("button", { name: "Resolved", exact: true }).last().click();
  await expect(page.getByText("Recorded.")).toBeVisible({ timeout: 20_000 });

  // The queue is empty, by name — not by the card merely being gone.
  await expect(page.getByText("Nothing needs your attention")).toBeVisible({ timeout: 20_000 });

  // Postgres agrees about what was decided and who decided it.
  const { data: row, error: rowErr } = await db
    .from("review_items")
    .select("status, resolution_note, resolved_at, resolved_by")
    .eq("id", planted.id)
    .single();
  if (rowErr) throw new Error(`reading the decision back: ${rowErr.message}`);
  expect(row.status).toBe("resolved");
  expect(row.resolution_note).toBe(NOTE);
  expect(row.resolved_at).not.toBeNull();
  expect(row.resolved_by).not.toBeNull();

  // And it stays empty through a full reload — the sidebar badge and list are
  // reading the database, not remembering the mutation.
  await page.reload();
  await expect(page.getByText("Nothing needs your attention")).toBeVisible({ timeout: 30_000 });

  // The item did not vanish; it moved. The Resolved filter shows it wearing
  // the note that was typed.
  await page.getByRole("button", { name: "Resolved", exact: true }).click();
  await expect(page.getByText("Left in progress", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(NOTE)).toBeVisible();
});
