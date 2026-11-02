// QA: "Routes: ... Board today-only; Complete button works from the board."
//
// Complete-from-office is the board's one write with money attached: the RPC
// flips the visit, records station service where the property has stations,
// and debits prepaid credit — all of which happens or doesn't in Postgres,
// which is why the second half of this spec is service-role reads and not
// more DOM.
//
// Since #658 the office's Complete asks what the tech's asks: the seeded
// business requires a completion photo and today's visits have none, so the
// click opens "Complete without the tech's proof?". Saying why is the
// override; it is recorded on the visit and on the client's timeline, and
// only then does the toast fire.

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

  // The #658 gate: no photo, so the office has to say why.
  const ask = page.getByRole("alertdialog");
  await expect(ask.getByText("Complete without the tech's proof?")).toBeVisible({
    timeout: 20_000,
  });
  const missingPhoto = (await ask.textContent())?.includes("no completion photo") ?? false;
  const completeAnyway = ask.getByRole("button", { name: "Complete anyway" });
  await expect(completeAnyway).toBeDisabled();
  const why = `Client confirmed by phone (e2e ${Date.now()})`;
  await ask.getByLabel("Why").fill(why);
  await expect(completeAnyway).toBeEnabled();
  await completeAnyway.click();
  await expect(ask).toBeHidden({ timeout: 20_000 });

  await expect(page.getByText("Visit marked complete")).toBeVisible({ timeout: 20_000 });

  // The card stopped offering it — completion is not re-clickable.
  await expect
    .poll(async () => completeButtons.count(), { timeout: 20_000 })
    .toBe(offeredBefore - 1);

  // Postgres: one more completed visit today, with completed_at actually set.
  await expect.poll(() => completedToday(orgId), { timeout: 20_000 }).toBe(doneBefore + 1);
  const today = await businessToday(orgId);
  const { data: fresh } = await db
    .from("visits")
    .select("completed_at, completion_source, completion_photo_waived_reason")
    .eq("organization_id", orgId)
    .eq("scheduled_on", today)
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1)
    .single();
  expect(fresh?.completed_at).toBeTruthy();
  expect(fresh?.completion_source).toBe("office");
  // The reason is on the visit where the photo was the thing missing, in the
  // same column a tech's no-photo reason uses.
  if (missingPhoto) {
    expect(fresh?.completion_photo_waived_reason).toBe(`Completed from the office: ${why}`);
  }

  // And the paper trail an owner audits by, carrying the reason either way.
  const { data: logged, error: logError } = await db
    .from("activity_log")
    .select("summary, meta")
    .eq("organization_id", orgId)
    .eq("kind", "visit.completed")
    .eq("meta->>override_reason", why);
  if (logError) throw new Error(`reading activity_log: ${logError.message}`);
  expect(logged ?? []).toHaveLength(1);
  expect(logged?.[0]?.summary).toContain(why);

  // The flip is state, not memory: a full reload draws one fewer Complete.
  await page.reload();
  await expect(page.getByText("Dispatch, route, map, and mark visits complete")).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(async () => completeButtons.count(), { timeout: 30_000 })
    .toBe(offeredBefore - 1);
});
