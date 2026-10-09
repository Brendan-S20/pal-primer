// A tech's note reaches the visit, and the photo rule is one rule.
//
// Until 20260928050000, complete_visit took no note and refused every visit
// without a completion photo, with no way through, while the end-of-day
// close-out completed a visit with no photo and recorded nothing. This spec
// drives the database as a real tech-role login (the seed has none; see
// a-tech-can-skip-for-a-reason-that-charges) and proves the rule both ways:
//
//   * required, no photo, no reason   -> refused, and nothing changes
//   * required, no photo, a reason    -> completed; note and reason stored
//   * not required, no photo          -> completed; nothing marked waived

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { businessToday, e2eOrgId, serviceDb } from "./service-db";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

test("a note is kept, and a missing photo needs a reason only when required", async () => {
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  // The business's today, not UTC's: from 19:00 in Chicago UTC is already
  // tomorrow, and "a future visit" would skip the org's real tomorrow.
  const today = await businessToday(db, orgId);

  const { data: visits, error: vErr } = await db
    .from("visits")
    .select("id, assigned_staff_id, status, tech_note, completion_photo_waived_reason")
    .eq("organization_id", orgId)
    .eq("status", "scheduled")
    .gt("scheduled_on", today)
    .order("scheduled_on")
    .limit(2);
  if (vErr || !visits || visits.length < 2) throw new Error(`need two future visits: ${vErr?.message}`);
  const [a, b] = visits;

  const { data: org } = await db
    .from("organizations")
    .select("require_completion_photo")
    .eq("id", orgId)
    .single();
  const ruleBefore = org?.require_completion_photo ?? true;

  const email = `photo-probe-${Date.now()}@e2e.houndstack.test`;
  const password = `photo-probe-${Math.random().toString(36).slice(2)}-Aa1`;
  const { data: created, error: uErr } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (uErr || !created.user) throw new Error(`create tech user: ${uErr?.message}`);
  const userId = created.user.id;
  let staffId: string | null = null;

  try {
    await db.from("user_roles").insert({ user_id: userId, organization_id: orgId, role: "tech" });
    const { data: staff } = await db
      .from("staff")
      .insert({ organization_id: orgId, user_id: userId, display_name: "Photo Probe", role: "tech" })
      .select("id")
      .single();
    staffId = staff!.id;
    await db.from("visits").update({ assigned_staff_id: staffId }).in("id", [a.id, b.id]);
    await db.from("organizations").update({ require_completion_photo: true }).eq("id", orgId);

    const tech = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error: signInErr } = await tech.auth.signInWithPassword({ email, password });
    if (signInErr) throw new Error(`tech sign-in: ${signInErr.message}`);

    // Required, no photo, no reason: refused.
    const refused = await tech.rpc("complete_visit", { _visit_id: a.id, _note: "Gate latched" });
    expect(refused.error?.message ?? "").toMatch(/completion photo is required/);
    const { data: stillOpen } = await db.from("visits").select("status").eq("id", a.id).single();
    expect(stillOpen?.status).toBe("scheduled");

    // Required, no photo, a reason: completed, and both words are kept.
    const waived = await tech.rpc("complete_visit", {
      _visit_id: a.id,
      _note: "Gate latched, bags by the shed",
      _no_photo_reason: "Camera would not open",
    });
    expect(waived.error?.message ?? null).toBeNull();
    const { data: aAfter } = await db
      .from("visits")
      .select("status, tech_note, completion_photo_waived_reason")
      .eq("id", a.id)
      .single();
    expect(aAfter).toEqual({
      status: "completed",
      tech_note: "Gate latched, bags by the shed",
      completion_photo_waived_reason: "Camera would not open",
    });

    // Not required: no photo, no reason, completes, nothing marked waived.
    await db.from("organizations").update({ require_completion_photo: false }).eq("id", orgId);
    const optional = await tech.rpc("complete_visit", { _visit_id: b.id });
    expect(optional.error?.message ?? null).toBeNull();
    const { data: bAfter } = await db
      .from("visits")
      .select("status, completion_photo_waived_reason")
      .eq("id", b.id)
      .single();
    expect(bAfter).toEqual({ status: "completed", completion_photo_waived_reason: null });
  } finally {
    await db.from("organizations").update({ require_completion_photo: ruleBefore }).eq("id", orgId);
    for (const v of [a, b]) {
      await db
        .from("visits")
        .update({
          status: "scheduled",
          completed_at: null,
          completion_source: null,
          tech_note: v.tech_note,
          completion_photo_waived_reason: v.completion_photo_waived_reason,
          assigned_staff_id: v.assigned_staff_id,
        })
        .eq("id", v.id);
    }
    if (staffId) await db.from("staff").delete().eq("id", staffId);
    await db.from("user_roles").delete().eq("user_id", userId);
    await db.auth.admin.deleteUser(userId);
  }
});
