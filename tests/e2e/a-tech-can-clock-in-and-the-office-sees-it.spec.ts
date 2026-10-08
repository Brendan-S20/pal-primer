// A tech clocks in and out, and the office sees it and can fix it.
//
// 20260928100000 added the time clock: time_entries, readable by the person
// it belongs to and by manage_users, writable by nobody except four SECURITY
// DEFINER functions. This spec proves each of those claims against real
// Postgres and real RLS, with real logins:
//
//   * the time clock (in the menu since #357) clocks a tech in and out, and the row lands;
//   * clock_in is idempotent -- a double tap, and an offline replay arriving
//     while a shift is open, return the same shift -- and a replay keeps the
//     tap time and says it was a replay;
//   * clock_out with nothing open is a no-op;
//   * the tech cannot write the table, and a second tech cannot read the
//     first one's hours or correct them;
//   * the owner reads everyone's, corrects a forgotten clock-out, adds a
//     forgotten day, is refused an overlapping one, and sees the week on
//     /timesheets.
//
// Two throwaway tech logins, made with the service role like the other
// tech-role specs (the seed's only field tech is the owner), and removed in
// `finally` along with every row they caused.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { e2eOrgId, serviceDb } from "./service-db";
import { OWNER, signIn } from "./sign-in";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

async function makeTech(db: SupabaseClient, orgId: string, name: string) {
  const email = `clock-probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.houndstack.test`;
  const password = `clock-probe-${Math.random().toString(36).slice(2)}-Aa1`;
  const { data: created, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    // The guided tour opens over a new account's first page and intercepts
    // every click; seed.mjs stamps the owner the same way.
    user_metadata: { tour_seen_at: new Date().toISOString() },
  });
  if (error || !created.user) throw new Error(`create tech user: ${error?.message}`);
  return { email, password, userId: created.user.id, name, staffId: null as string | null };
}

async function signedIn(email: string, password: string) {
  const c = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return c;
}

test("a tech clocks in and out, and the office sees it and can fix it", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const a = await makeTech(db, orgId, `Clock Probe A ${Date.now().toString(36)}`);
  const b = await makeTech(db, orgId, "Clock Probe B");

  try {
    for (const t of [a, b]) {
      const { error: rErr } = await db
        .from("user_roles")
        .insert({ user_id: t.userId, organization_id: orgId, role: "tech" });
      if (rErr) throw new Error(`user_roles: ${rErr.message}`);
      const { data: staff, error: sErr } = await db
        .from("staff")
        .insert({ organization_id: orgId, user_id: t.userId, display_name: t.name, role: "tech" })
        .select("id")
        .single();
      if (sErr || !staff) throw new Error(`staff: ${sErr?.message}`);
      t.staffId = staff.id;
    }
    const entriesOf = async (staffId: string) =>
      (
        await db
          .from("time_entries")
          .select("id, clock_in, clock_out, clock_in_source, clock_out_source, edited_by, note")
          .eq("staff_id", staffId)
          .order("clock_in")
      ).data ?? [];

    // ── The time clock, driven as the tech. ───────────────────────────────
    // Since #357 the clock lives in the menu (More on a phone, the sidebar at
    // this config's 1280px) and opens a sheet. My Day shows an "off the
    // clock" banner only when there is work today, and this tech has none,
    // so the menu entry is the one way in that always exists.
    await signIn(page, { email: a.email, password: a.password });
    await page.goto("/my-day");
    const clockSheet = async () => {
      const sheet = page.getByRole("dialog", { name: "Time clock" });
      if (await sheet.isVisible()) return sheet;
      const row = page.locator("[data-time-clock-row]:visible").first();
      await expect(row, "the time clock in the menu").toBeVisible({ timeout: 30_000 });
      await row.click();
      await expect(sheet).toBeVisible({ timeout: 10_000 });
      return sheet;
    };
    // A successful tap closes the sheet once the clock has refetched
    // (TimeClockSheetHost: `if (ok) setOpen(false)`), so each tap waits for
    // that close and then reopens it rather than reading a sheet on its way out.
    const tapAndWaitForClose = async (name: "Clock in" | "Clock out") => {
      const sheet = await clockSheet();
      await sheet.getByRole("button", { name }).click();
      await expect(sheet, `the sheet closes after ${name}`).toBeHidden({ timeout: 20_000 });
    };
    let card = await clockSheet();
    await expect(card).toContainText("You're off the clock");
    await tapAndWaitForClose("Clock in");
    await expect(page.locator("[data-time-clock-row]:visible").first()).toContainText("On the clock", {
      timeout: 20_000,
    });
    card = await clockSheet();
    await expect(card).toContainText("On the clock since");

    let rows = await entriesOf(a.staffId!);
    expect(rows, "one shift, opened by the tap").toHaveLength(1);
    expect(rows[0].clock_out).toBeNull();
    expect(rows[0].clock_in_source).toBe("tech_live");

    await tapAndWaitForClose("Clock out");
    await expect(page.getByText("Clocked out", { exact: true })).toBeVisible({ timeout: 20_000 });
    card = await clockSheet();
    await expect(card).toContainText("You're off the clock");
    rows = await entriesOf(a.staffId!);
    expect(rows[0].clock_out, "the tap closed the shift").not.toBeNull();
    expect(rows[0].clock_out_source).toBe("tech_live");

    // ── The RPCs, as the tech. ────────────────────────────────────────────
    const techA = await signedIn(a.email, a.password);
    const lastOut = Date.parse(rows[0].clock_out!);

    // A replay of a tap made before the last shift ended cannot reach back
    // into it; a replay of a later one keeps its own time.
    const replayAt = new Date(Date.now() - 60_000).toISOString();
    const first = await techA.rpc("clock_in", { _at: replayAt });
    expect(first.error?.message ?? null).toBeNull();
    const again = await techA.rpc("clock_in");
    expect(again.data, "a double tap returns the same shift").toBe(first.data);
    const replayed = await techA.rpc("clock_in", { _at: new Date(Date.now() - 30_000).toISOString() });
    expect(replayed.data, "a replay while a shift is open returns it").toBe(first.data);

    rows = await entriesOf(a.staffId!);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.clock_out == null), "one open shift").toHaveLength(1);
    const open = rows.find((r) => r.id === first.data)!;
    expect(open.clock_in_source).toBe("tech_offline_replay");
    expect(Date.parse(open.clock_in)).toBeGreaterThanOrEqual(Math.max(lastOut, Date.parse(replayAt)) - 1);

    // The tech cannot write their own hours.
    const forged = await techA
      .from("time_entries")
      .insert({ organization_id: orgId, staff_id: a.staffId!, clock_in: new Date().toISOString() });
    expect(forged.error, "a direct insert by the tech").not.toBeNull();
    await techA.from("time_entries").update({ clock_in: "2020-01-01T00:00:00Z" }).eq("id", open.id);
    expect((await entriesOf(a.staffId!)).find((r) => r.id === open.id)?.clock_in).toBe(open.clock_in);

    // ── A second tech sees nothing of the first. ──────────────────────────
    const techB = await signedIn(b.email, b.password);
    const peek = await techB.from("time_entries").select("id").eq("staff_id", a.staffId!);
    expect(peek.error).toBeNull();
    expect(peek.data, "tech B reading tech A's hours").toEqual([]);
    const bOwn = await techB.rpc("clock_in");
    expect(bOwn.error).toBeNull();
    const bRead = await techB.from("time_entries").select("id");
    expect(bRead.data?.map((r) => r.id), "tech B reads exactly their own").toEqual([bOwn.data]);
    const bEdit = await techB.rpc("office_edit_time_entry", {
      _id: open.id,
      _clock_in: open.clock_in,
      _clock_out: new Date().toISOString(),
    });
    expect(bEdit.error?.message ?? "", "tech B correcting tech A").toMatch(/not authorized/i);
    const bOut = await techB.rpc("clock_out");
    expect(bOut.data).toBe(bOwn.data);
    const bOutAgain = await techB.rpc("clock_out");
    expect(bOutAgain.error).toBeNull();
    expect(bOutAgain.data, "clock_out with nothing open is a no-op").toBeNull();

    // ── The owner. ────────────────────────────────────────────────────────
    const owner = await signedIn(OWNER.email, OWNER.password);
    const ownerRead = await owner.from("time_entries").select("id").eq("staff_id", a.staffId!);
    expect(ownerRead.data?.length, "the owner reads the tech's hours").toBe(2);

    // The forgotten clock-out.
    const outAt = new Date().toISOString();
    const fix = await owner.rpc("office_edit_time_entry", {
      _id: open.id,
      _clock_in: open.clock_in,
      _clock_out: outAt,
      _note: "Forgot to clock out",
    });
    expect(fix.error?.message ?? null).toBeNull();
    const fixed = (await entriesOf(a.staffId!)).find((r) => r.id === open.id)!;
    expect(fixed.clock_out).not.toBeNull();
    expect(fixed.clock_out_source).toBe("office");
    expect(fixed.clock_in_source, "an unchanged end keeps its source").toBe("tech_offline_replay");
    expect(fixed.note).toBe("Forgot to clock out");
    expect(fixed.edited_by).toBeTruthy();

    // The forgotten day, and an overlap refused.
    const yIn = new Date(Date.now() - 30 * 3600_000).toISOString();
    const yOut = new Date(Date.now() - 22 * 3600_000).toISOString();
    const added = await owner.rpc("office_add_time_entry", {
      _staff_id: a.staffId!,
      _clock_in: yIn,
      _clock_out: yOut,
      _note: "Phone died",
    });
    expect(added.error?.message ?? null).toBeNull();
    const overlap = await owner.rpc("office_add_time_entry", {
      _staff_id: a.staffId!,
      _clock_in: new Date(Date.now() - 26 * 3600_000).toISOString(),
      _clock_out: new Date(Date.now() - 25 * 3600_000).toISOString(),
    });
    expect(overlap.error?.message ?? "", "an overlapping shift").toMatch(/overlaps/i);
    expect(await entriesOf(a.staffId!)).toHaveLength(3);

    // ── And the page the office reads it on. ──────────────────────────────
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const officePage = await ctx.newPage();
      await signIn(officePage, OWNER);
      await officePage.goto("/timesheets");
      await expect(officePage.getByRole("heading", { name: "Timesheets" })).toBeVisible({
        timeout: 30_000,
      });
      const tableRow = officePage.getByRole("row").filter({ hasText: a.name });
      await expect(tableRow, "tech A's row in the week grid").toBeVisible({ timeout: 20_000 });
      // Minutes of real time were worked this week, so the total is not zero.
      await expect(tableRow).not.toContainText(/^\s*0m\s*$/);
    } finally {
      await ctx.close();
    }
  } finally {
    for (const t of [a, b]) {
      if (t.staffId) {
        await db.from("time_entries").delete().eq("staff_id", t.staffId);
        await db.from("staff").delete().eq("id", t.staffId);
      }
      await db.from("user_roles").delete().eq("user_id", t.userId);
      await db.auth.admin.deleteUser(t.userId);
    }
  }
});
