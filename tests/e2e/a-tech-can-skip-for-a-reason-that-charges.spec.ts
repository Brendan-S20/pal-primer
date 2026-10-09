// A technician skips a visit for a reason that charges, and the charge lands.
//
// Until 20260928020000 they could not. skip_visit computes the charge from
// the org's skip rules and writes skip_billable / skip_charge_cents, and
// visits_guard_privileged_columns refuses a non-writer who changes those
// columns. SECURITY DEFINER changes the role, not auth.uid(), so the guard saw
// the tech and refused the product's own computed charge: "Not authorized to
// change skip_billable, skip_charge_cents on a visit." Every reason a tech
// meets in a driveway (gate locked, dog outside, access blocked) charges by
// default, so every one of them failed. Only the owner had ever been tested,
// and the owner passes the guard on its first line.
//
// So this spec makes a real tech-role login -- the seed has none, because the
// owner is the seeded org's field tech -- and proves both halves: the skip
// charges, and the tech still cannot write a charge of their own.

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { businessToday, e2eOrgId, serviceDb } from "./service-db";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

test("a tech's billable skip records the charge, and a forged one is refused", async () => {
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  // The business's today, not UTC's: from 19:00 in Chicago UTC is already
  // tomorrow, and "a future visit" would skip the org's real tomorrow.
  const today = await businessToday(db, orgId);

  const { data: visit, error: vErr } = await db
    .from("visits")
    .select("id, assigned_staff_id, skip_charge_cents")
    .eq("organization_id", orgId)
    .eq("status", "scheduled")
    .not("subscription_id", "is", null)
    .gt("scheduled_on", today)
    .order("scheduled_on")
    .limit(1)
    .single();
  if (vErr || !visit) throw new Error(`no future subscription visit to skip: ${vErr?.message}`);

  const email = `skip-probe-${Date.now()}@e2e.houndstack.test`;
  const password = `skip-probe-${Math.random().toString(36).slice(2)}-Aa1`;
  const { data: created, error: uErr } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (uErr || !created.user) throw new Error(`create tech user: ${uErr?.message}`);
  const userId = created.user.id;
  let staffId: string | null = null;

  try {
    const { error: rErr } = await db
      .from("user_roles")
      .insert({ user_id: userId, organization_id: orgId, role: "tech" });
    if (rErr) throw new Error(`user_roles: ${rErr.message}`);
    const { data: staff, error: sErr } = await db
      .from("staff")
      .insert({ organization_id: orgId, user_id: userId, display_name: "Skip Probe", role: "tech" })
      .select("id")
      .single();
    if (sErr || !staff) throw new Error(`staff: ${sErr?.message}`);
    staffId = staff.id;
    await db.from("visits").update({ assigned_staff_id: staffId }).eq("id", visit.id);

    const tech = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error: signInErr } = await tech.auth.signInWithPassword({ email, password });
    if (signInErr) throw new Error(`tech sign-in: ${signInErr.message}`);

    const skip = await tech.rpc("skip_visit", {
      _visit_id: visit.id,
      _reason: "Dog was outside",
      _code: "dog_outside",
    });
    expect(skip.error?.message ?? null, "skip_visit as the tech").toBeNull();

    const { data: after } = await db
      .from("visits")
      .select("status, skip_billable, skip_charge_cents")
      .eq("id", visit.id)
      .single();
    expect(after?.status).toBe("skipped");
    expect(after?.skip_billable).toBe(true);
    expect(after?.skip_charge_cents ?? 0).toBeGreaterThan(0);

    // The exception is for skip_visit's own computed charge, not for the tech.
    await tech.from("visits").update({ skip_charge_cents: 99999 }).eq("id", visit.id);
    const { data: forged } = await db
      .from("visits")
      .select("skip_charge_cents")
      .eq("id", visit.id)
      .single();
    expect(forged?.skip_charge_cents, "a direct charge write by the tech").toBe(
      after?.skip_charge_cents,
    );
  } finally {
    await db
      .from("visits")
      .update({
        status: "scheduled",
        skip_reason: null,
        skip_reason_code: null,
        skip_billable: false,
        skip_charge_cents: visit.skip_charge_cents,
        skipped_at: null,
        assigned_staff_id: visit.assigned_staff_id,
      })
      .eq("id", visit.id);
    if (staffId) await db.from("staff").delete().eq("id", staffId);
    await db.from("user_roles").delete().eq("user_id", userId);
    await db.auth.admin.deleteUser(userId);
  }
});
