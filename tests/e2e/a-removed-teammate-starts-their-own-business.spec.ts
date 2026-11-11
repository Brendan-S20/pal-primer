// A removed teammate signs up again with the same email and lands in a
// workspace of their own (#765).
//
// What Tester did on live 3a028504, end to end against real Postgres and real
// RLS: the owner removes a technician (Deactivate -- set_staff_active false,
// the only removal Settings -> Users offers), and the technician then goes to
// Get started with the same address. Before this change every door led back
// to /access-off, whose only buttons were Check again and Sign out.
//
// Now: Get started hands the taken address to sign-in (the password is the
// tech's own; the reset link is the other way to prove the address, and is
// covered by tests/a-taken-email-goes-to-sign-in.test.ts), sign-in lands on
// /access-off, "Start my own business" gives up the old membership
// (leave_business_i_was_turned_off_in), and /no-workspace builds the new one.
//
// Postgres is asked, not just the screen: one membership, as OWNER of a NEW
// business; the old business keeps the person's staff row, turned off.
//
// A throwaway tech login, made with the service role like the other
// tech-role specs, removed in `finally` with the business it made.

import { expect, test } from "@playwright/test";

import { e2eOrgId, serviceDb } from "./service-db";
import { OWNER, waitForHydration } from "./sign-in";
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

test("a removed teammate signs up again with the same email and lands in a new workspace", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);

  const email = `removed-probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.houndstack.test`;
  const password = `removed-probe-${Math.random().toString(36).slice(2)}-Aa1`;
  const businessName = `Removed Probe Pet Waste ${Date.now().toString(36)}`;
  const { data: created, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: "Removed Probe", tour_seen_at: new Date().toISOString() },
  });
  if (error || !created.user) throw new Error(`create tech user: ${error?.message}`);
  const userId = created.user.id;
  let newOrgId: string | null = null;

  try {
    // ── On the team, then removed by the owner. ───────────────────────────
    const { error: rErr } = await db
      .from("user_roles")
      .insert({ user_id: userId, organization_id: orgId, role: "tech" });
    if (rErr) throw new Error(`user_roles: ${rErr.message}`);
    const { data: staff, error: sErr } = await db
      .from("staff")
      .insert({
        organization_id: orgId,
        user_id: userId,
        display_name: "Removed Probe",
        role: "tech",
      })
      .select("id")
      .single();
    if (sErr || !staff) throw new Error(`staff: ${sErr?.message}`);

    const owner = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error: oErr } = await owner.auth.signInWithPassword(OWNER);
    if (oErr) throw new Error(`owner sign-in: ${oErr.message}`);
    const off = await owner.rpc("set_staff_active", { _staff_id: staff.id, _active: false });
    expect(off.error?.message ?? null, "the owner deactivates the tech").toBeNull();

    // ── The same email, on Get started. ───────────────────────────────────
    await page.goto("/get-started");
    await waitForHydration(page, "#gs-email");
    await page.locator("#gs-email").fill(email);
    await page.locator("#gs-pass").fill(password);
    await page.getByRole("button", { name: /^continue$/i }).click();

    // Handed to sign-in, address filled, a way forward named.
    await expect(page).toHaveURL(/\/auth/, { timeout: 20_000 });
    await expect(page.getByRole("status")).toContainText("you can start your own business", {
      timeout: 20_000,
    });
    const pw = page.getByLabel(/password/i);
    await expect(pw).toBeVisible();
    await pw.fill(password);
    await page.getByRole("button", { name: /^sign in$/i }).click();

    // ── Turned off: the screen now has a way out. ─────────────────────────
    await expect(page).toHaveURL(/\/access-off/, { timeout: 30_000 });
    await page.getByRole("button", { name: "Start my own business" }).click();
    await expect(page.getByTestId("start-own-confirm")).toContainText(
      "Their records stay with them",
    );
    await page.getByRole("button", { name: "Leave and start my own" }).click();

    // ── No workspace: name the business. ──────────────────────────────────
    await expect(page).toHaveURL(/\/no-workspace/, { timeout: 30_000 });
    await waitForHydration(page, "#nw-org");
    await page.locator("#nw-org").fill(businessName);
    await page.locator("#nw-name").fill("Removed Probe");
    await page.getByRole("button", { name: "Finish setup" }).click();
    await expect(page).not.toHaveURL(/\/(no-workspace|access-off|auth)/, { timeout: 30_000 });

    // ── What Postgres says. ───────────────────────────────────────────────
    const { data: roles } = await db
      .from("user_roles")
      .select("organization_id, role")
      .eq("user_id", userId);
    expect(roles, "exactly one membership").toHaveLength(1);
    expect(roles![0].organization_id, "in a NEW business").not.toBe(orgId);
    expect(roles![0].role).toBe("owner");
    newOrgId = roles![0].organization_id;
    const { data: org } = await db
      .from("organizations")
      .select("name")
      .eq("id", newOrgId!)
      .single();
    expect(org?.name).toBe(businessName);

    const { data: oldStaff } = await db
      .from("staff")
      .select("active, user_id")
      .eq("id", staff.id)
      .single();
    expect(oldStaff, "the old business keeps the staff row, turned off").toEqual({
      active: false,
      user_id: userId,
    });

    // ── No data crosses between the two businesses. ───────────────────────
    // As the person who left, through real RLS: nothing of the old business.
    const leaver = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error: lErr } = await leaver.auth.signInWithPassword({ email, password });
    if (lErr) throw new Error(`leaver sign-in: ${lErr.message}`);
    for (const table of ["clients", "visits", "invoices", "staff", "user_roles"] as const) {
      const { data: seen, error: readErr } = await leaver
        .from(table)
        .select("id")
        .eq("organization_id", orgId)
        .limit(1);
      expect(readErr?.message ?? null, `reading ${table}`).toBeNull();
      expect(seen, `the person who left reads the old business's ${table}`).toEqual([]);
    }
    const { data: oldOrg } = await leaver.from("organizations").select("id").eq("id", orgId);
    expect(oldOrg, "the old business's own row").toEqual([]);
    // And the old business's owner sees nothing of the new one.
    const { data: newOrgSeen } = await owner.from("organizations").select("id").eq("id", newOrgId!);
    expect(newOrgSeen, "the old owner reads the new business").toEqual([]);
  } finally {
    // Only what this spec made: its own throwaway business and login.
    if (newOrgId && newOrgId !== orgId) {
      await db.from("user_roles").delete().eq("organization_id", newOrgId);
      await db.from("staff").delete().eq("organization_id", newOrgId);
      await db.from("organizations").delete().eq("id", newOrgId);
    }
    await db.from("user_roles").delete().eq("user_id", userId);
    await db.from("staff").delete().eq("user_id", userId).eq("organization_id", orgId);
    await db.auth.admin.deleteUser(userId);
  }
});
