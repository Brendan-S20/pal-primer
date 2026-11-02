// QA: "Routes: ... Board today-only; Complete button works from the board."
//
// Complete-from-office is the board's one write with money attached: the RPC
// flips the visit, records station service where the property has stations,
// and debits prepaid credit — all of which happens or doesn't in Postgres,
// which is why the second half of this spec is service-role reads and not
// more DOM. There is deliberately NO confirm dialog on the button (a
// dispatcher clearing a day clicks it dozens of times), so the toast is the
// only acknowledgement and the spec treats it that way.
//
// Since #658 the office Complete asks what the tech's does: when the business
// requires a completion photo (the seeded org does) or the visit's line has
// required checklist items, the database refuses until the office says why,
// and the board asks in a dialog. That is not a confirm: it only appears when
// proof is missing. The spec answers it the way a dispatcher would and then
// checks the reason landed on the visit. This spec went unrun on main from
// #658 until #683, because the database job stopped at the embed check
// before it reached the E2E step.

import { expect, test } from "@playwright/test";

import { pointTheBrowserAtTheLocalDatabase } from "./point-the-browser-at-the-local-database";
import { businessToday as sharedBusinessToday, e2eOrgId, serviceDb } from "./service-db";
import { signIn } from "./sign-in";

test.beforeEach(async ({ context }) => {
  await pointTheBrowserAtTheLocalDatabase(context, {
    url: process.env.SUPABASE_URL ?? "http://127.0.0.1:54421",
    anonKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? "",
  });
});

// "Today" is the BUSINESS's day, which is what the board shows -- not the
// runner's. The seeded org is on America/Chicago and the runner on Eastern, so
// a local date put this spec on tomorrow for the hour after midnight Eastern:
// the board completed one of today's visits and the count of tomorrow's never
// moved (0 received, 1 expected, at 12:08 a.m. on 2026-10-02).
// The helper now lives in service-db.ts, shared with every spec that asks.
const businessToday = (orgId: string) => sharedBusinessToday(serviceDb(), orgId);

async function completedToday(orgId: string) {
  const db = serviceDb();
  const today = await businessToday(orgId);
  const { count, error } = await db
    .from("visits")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("scheduled_on", today)
    .eq("status", "completed");
  if (error) throw new Error(`counting completed visits: ${error.message}`);
  return count ?? 0;
}

test("Complete on a board card flips the visit in Postgres and logs the action", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const doneBefore = await completedToday(orgId);

  await signIn(page);
  await page.goto("/routes");
  await expect(page.getByText("Dispatch, route, map, and mark visits complete")).toBeVisible({
    timeout: 30_000,
  });
  // The board renders in both view modes, but Board mode is the QA item and
  // keeps the map from stealing the viewport.
  await page.getByRole("button", { name: "Board", exact: true }).click();

  // Any card still offering Complete: the seed leaves several of today's six
  // visits scheduled. Re-runs inside one session shrink the pool by one each
  // time; the reseed on the next `npm run test:e2e` restores it, and the
  // guard here says which of those two truths a failure is about.
  const completeButtons = page.getByRole("button", { name: "Complete", exact: true });
  await expect
    .poll(async () => completeButtons.count(), {
      message:
        "no card offers Complete — either every visit today is already " +
        "completed (reseed) or the board did not render",
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  const offeredBefore = await completeButtons.count();

  await completeButtons.first().click();

  // Either it completes at once, or the business wants proof the board
  // cannot give and asks why (#658). Whichever comes first decides.
  const askWhy = page.getByRole("alertdialog", { name: "Complete without the tech's proof?" });
  const toast = page.getByText("Visit marked complete");
  await expect(askWhy.or(toast).first()).toBeVisible({ timeout: 20_000 });
  const REASON = "E2E: client confirmed by phone";
  const askedWhy = await askWhy.isVisible();
  if (askedWhy) {
    // The button stays disabled until there is a reason: an override with
    // nothing written is not one.
    const anyway = askWhy.getByRole("button", { name: "Complete anyway" });
    await expect(anyway).toBeDisabled();
    await askWhy.getByLabel("Why").fill(REASON);
    await anyway.click();
  }
  await expect(toast).toBeVisible({ timeout: 20_000 });

  // The card stopped offering it — completion is not re-clickable.
  await expect
    .poll(async () => completeButtons.count(), { timeout: 20_000 })
    .toBe(offeredBefore - 1);

  // Postgres: one more completed visit today, with completed_at actually set.
  await expect.poll(() => completedToday(orgId), { timeout: 20_000 }).toBe(doneBefore + 1);
  const today = await businessToday(orgId);
  const { data: fresh } = await db
    .from("visits")
    .select("completed_at, completion_photo_waived_reason")
    .eq("organization_id", orgId)
    .eq("scheduled_on", today)
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1)
    .single();
  expect(fresh?.completed_at).toBeTruthy();
  // The reason the office gave is what the owner reads later, on the visit.
  // Recorded there when it was the photo that was missing; a checklist-only
  // gap goes to the checklist answers instead, so only assert what applies.
  const { data: org } = await db
    .from("organizations")
    .select("require_completion_photo")
    .eq("id", orgId)
    .single();
  if (askedWhy && org?.require_completion_photo) {
    expect(fresh?.completion_photo_waived_reason).toBe(REASON);
  }

  // And the paper trail an owner audits by.
  const { count: logged } = await db
    .from("activity_log")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("kind", "visit.completed");
  expect(logged ?? 0).toBeGreaterThan(0);

  // The flip is state, not memory: a full reload draws one fewer Complete.
  await page.reload();
  await expect(page.getByText("Dispatch, route, map, and mark visits complete")).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(async () => completeButtons.count(), { timeout: 30_000 })
    .toBe(offeredBefore - 1);
});
