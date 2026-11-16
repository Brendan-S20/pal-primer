// A teammate who left is listed as "Left", is invited back from the Team
// page, and comes back as the same person with the same history (#938).
//
// The follow-up to a-removed-teammate-starts-their-own-business.spec.ts
// (#765), which drives the leaving half through /access-off. This one is the
// OWNER's half, against real Postgres and real RLS:
//
//   1. a throwaway tech is on the E2E business, with a visit attributed to
//      their staff row;
//   2. the owner turns them off, and they leave
//      (leave_business_i_was_turned_off_in, as themselves);
//   3. Settings -> Users shows them as "Left" with the date — before this
//      change they were not on the page at all;
//   4. the owner presses Invite again, then Send invite, and an org_invites
//      row exists for that address;
//   5. the tech accepts with the link's token, and is Active again on the
//      SAME staff row, which still carries the visit.
//
// No email leaves: RESEND_API_KEY is unset for the local dev server, so the
// invite reports "did not go out" and offers the link, which is what step 5
// uses. Only the E2E test business is touched; everything this spec made is
// removed in `finally`, and the one seeded visit it borrowed is put back.

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { e2eOrgId, serviceDb } from "./service-db";
import { OWNER, signIn } from "./sign-in";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

test("a teammate who left is listed as Left, invited back, and comes back with their history", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `left-probe-${stamp}@e2e.houndstack.test`;
  const password = `left-probe-${Math.random().toString(36).slice(2)}-Aa1`;
  const name = `Left Probe ${stamp.slice(-4)}`;
  const { data: created, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: name, tour_seen_at: new Date().toISOString() },
  });
  if (error || !created.user) throw new Error(`create tech user: ${error?.message}`);
  const userId = created.user.id;

  let borrowed: { id: string; assigned_staff_id: string | null } | null = null;
  try {
    // ── On the team, with a visit to their name. ──────────────────────────
    const { error: rErr } = await db
      .from("user_roles")
      .insert({ user_id: userId, organization_id: orgId, role: "tech" });
    if (rErr) throw new Error(`user_roles: ${rErr.message}`);
    const { data: staff, error: sErr } = await db
      .from("staff")
      .insert({ organization_id: orgId, user_id: userId, display_name: name, role: "tech", email })
      .select("id")
      .single();
    if (sErr || !staff) throw new Error(`staff: ${sErr?.message}`);
    const { data: visit } = await db
      .from("visits")
      .select("id, assigned_staff_id")
      .eq("organization_id", orgId)
      .limit(1)
      .single();
    if (!visit) throw new Error("the seeded business has no visit to attribute");
    borrowed = visit as { id: string; assigned_staff_id: string | null };
    const { error: vErr } = await db
      .from("visits")
      .update({ assigned_staff_id: staff.id })
      .eq("id", visit.id);
    if (vErr) throw new Error(`visit: ${vErr.message}`);

    // ── Turned off by the owner, then they leave. ─────────────────────────
    const owner = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error: oErr } = await owner.auth.signInWithPassword(OWNER);
    if (oErr) throw new Error(`owner sign-in: ${oErr.message}`);
    const off = await owner.rpc("set_staff_active", { _staff_id: staff.id, _active: false });
    expect(off.error?.message ?? null, "the owner turns the tech off").toBeNull();

    const tech = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error: tErr } = await tech.auth.signInWithPassword({ email, password });
    if (tErr) throw new Error(`tech sign-in: ${tErr.message}`);
    const left = await tech.rpc("leave_business_i_was_turned_off_in");
    expect(left.error?.message ?? null, "the tech leaves").toBeNull();
    const { data: roles } = await db.from("user_roles").select("id").eq("user_id", userId);
    expect(roles, "no membership left").toEqual([]);

    // ── The owner's Team page: Left, with the date. ───────────────────────
    await signIn(page);
    await page.goto("/settings/users");
    await expect(page.getByRole("heading", { name: "Users & roles" })).toBeVisible({
      timeout: 30_000,
    });
    const row = page.locator(`[data-left-teammate="${userId}"]`);
    await expect(row, "the person who left is still on the page").toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(name);
    await expect(row).toContainText(email);
    const today = new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    await expect(row).toContainText(`Left ${today}`);

    // ── Invite again: fills the form; Send invite sends it. ───────────────
    await row.getByRole("button", { name: "Invite again" }).click();
    await expect(page.getByPlaceholder("teammate@example.com")).toHaveValue(email);
    await page.getByRole("button", { name: "Send invite" }).click();
    await expect(row.getByText("Invited back")).toBeVisible({ timeout: 30_000 });
    await expect(row.getByRole("button", { name: "Invite again" })).toHaveCount(0);

    const { data: invite } = await db
      .from("org_invites")
      .select("token, role, status")
      .eq("organization_id", orgId)
      .eq("email", email)
      .eq("status", "pending")
      .single();
    expect(invite?.role, "invited back as what they were").toBe("tech");

    // ── They accept, and are the same person again. ───────────────────────
    const accepted = await tech.rpc("accept_org_invite_for_current_user", {
      _token: invite!.token,
    });
    expect(accepted.error?.message ?? null, "accepting the invitation").toBeNull();
    expect(accepted.data).toBe(orgId);

    const { data: back } = await db
      .from("user_roles")
      .select("organization_id, role")
      .eq("user_id", userId);
    expect(back).toEqual([{ organization_id: orgId, role: "tech" }]);
    const { data: rows } = await db
      .from("staff")
      .select("id, active")
      .eq("organization_id", orgId)
      .eq("user_id", userId);
    expect(rows, "one staff row, the original, turned back on").toEqual([
      { id: staff.id, active: true },
    ]);
    const { data: still } = await db
      .from("visits")
      .select("assigned_staff_id")
      .eq("id", visit.id)
      .single();
    expect(still?.assigned_staff_id, "the earlier visit is still theirs").toBe(staff.id);

    // ── And the Team page says so. ────────────────────────────────────────
    await page.reload();
    await expect(page.getByRole("heading", { name: "Users & roles" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator(`[data-left-teammate="${userId}"]`)).toHaveCount(0);
    const member = page.locator("tr", { hasText: email });
    await expect(member.getByText("Active", { exact: true })).toBeVisible({ timeout: 30_000 });
  } finally {
    // Only what this spec made, and the one visit it borrowed.
    if (borrowed) {
      await db
        .from("visits")
        .update({ assigned_staff_id: borrowed.assigned_staff_id })
        .eq("id", borrowed.id);
    }
    await db.from("org_invites").delete().eq("organization_id", orgId).eq("email", email);
    await db
      .from("activity_log")
      .delete()
      .eq("organization_id", orgId)
      .eq("kind", "staff.left")
      .contains("meta", { user_id: userId });
    await db.from("user_roles").delete().eq("user_id", userId);
    await db.from("staff").delete().eq("user_id", userId).eq("organization_id", orgId);
    await db.auth.admin.deleteUser(userId);
  }
});
