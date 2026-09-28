// A customer asks for the re-clean the business guarantees, and the office
// books it.
//
// Until 20260928110000 a customer could only "report a concern", and the
// office decided by hand whether the guarantee applied and booked a free
// visit with nothing linking it to the complaint. This spec proves both
// halves against a database built from the migrations:
//
//   the customer's half, through portal_request_reclean as the portal calls
//   it (service_role, after the session check): accepted inside the window,
//   the same ticket on a second tap, refused outside the window, refused when
//   the owner has switched the guarantee off — and refused to a signed-in
//   owner calling it directly, because it is granted to service_role only;
//
//   the office's half, through the real /concerns page as the owner:
//   "Schedule re-clean" books a $0 one-off visit at the same property with the
//   same tech (createOneOffVisit, the server function behind "Book a one-off
//   visit"), links it to the ticket, and moves the ticket to acknowledged.
//
// Everything created is deleted in `finally`, and the visit's completion time
// and the org's window are put back as they were.

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { e2eOrgId, serviceDb } from "./service-db";
import { OWNER, signIn } from "./sign-in";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
const HOUR = 3_600_000;

/** YYYY-MM-DD for `instant` on the org's clock. */
function orgDay(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

test("a customer's re-clean request is accepted once, inside the window only, and the office books it for $0", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const db = serviceDb();
  const orgId = await e2eOrgId(db);
  const startedAt = new Date().toISOString();

  const { data: org, error: oErr } = await db
    .from("organizations")
    .select("reclean_window_hours, timezone, work_days")
    .eq("id", orgId)
    .single();
  if (oErr || !org) throw new Error(`org: ${oErr?.message}`);
  const windowBefore = org.reclean_window_hours;
  const tz = org.timezone || "America/Chicago";

  // A completed visit of an active client with a portal link, and no ticket
  // of any kind yet, so this spec cannot collide with another one's rows.
  const { data: candidates, error: cErr } = await db
    .from("visits")
    .select(
      "id, client_id, property_id, assigned_staff_id, completed_at, scheduled_on, clients!inner(portal_token, active, display_name)",
    )
    .eq("organization_id", orgId)
    .eq("status", "completed")
    .eq("clients.active", true)
    .not("clients.portal_token", "is", null)
    .not("assigned_staff_id", "is", null)
    .order("scheduled_on", { ascending: false })
    .limit(40);
  if (cErr) throw new Error(`visits: ${cErr.message}`);
  let visit: (typeof candidates)[number] | null = null;
  for (const v of candidates ?? []) {
    const { count } = await db
      .from("qc_tickets")
      .select("id", { count: "exact", head: true })
      .eq("visit_id", v.id);
    if (!count) {
      visit = v;
      break;
    }
  }
  if (!visit) throw new Error("no completed visit without a ticket to request a re-clean for");
  const client = Array.isArray(visit.clients) ? visit.clients[0] : visit.clients;
  const token = client.portal_token as string;
  const completedBefore = visit.completed_at;
  const message = `Re-clean probe ${Date.now()}: the strip behind the shed`;

  const ticketIds = new Set<string>();
  let recleanVisitId: string | null = null;
  let recleanSubscriptionId: string | null = null;

  try {
    // ── The customer's half ───────────────────────────────────────────────
    await db.from("organizations").update({ reclean_window_hours: 48 }).eq("id", orgId);
    await db
      .from("visits")
      .update({ completed_at: new Date(Date.now() - 2 * HOUR).toISOString() })
      .eq("id", visit.id);

    const first = await db.rpc("portal_request_reclean", {
      _token: token,
      _visit_id: visit.id,
      _message: message,
    });
    expect(first.error?.message ?? null, "a request two hours after the visit").toBeNull();
    expect(first.data).toBeTruthy();
    ticketIds.add(first.data as string);

    const again = await db.rpc("portal_request_reclean", {
      _token: token,
      _visit_id: visit.id,
      _message: "tapped twice",
    });
    expect(again.error?.message ?? null).toBeNull();
    expect(again.data, "a second tap is the same ticket").toBe(first.data);

    const { data: ticket } = await db
      .from("qc_tickets")
      .select("category, status, message, client_id, organization_id")
      .eq("id", first.data as string)
      .single();
    expect(ticket).toMatchObject({
      category: "reclean_request",
      status: "open",
      message,
      client_id: visit.client_id,
      organization_id: orgId,
    });

    await db
      .from("visits")
      .update({ completed_at: new Date(Date.now() - 49 * HOUR).toISOString() })
      .eq("id", visit.id);
    const late = await db.rpc("portal_request_reclean", {
      _token: token,
      _visit_id: visit.id,
      _message: "",
    });
    expect(late.error?.message ?? "", "49 hours after, on a 48-hour guarantee").toMatch(
      /reclean_window_closed/,
    );

    await db
      .from("visits")
      .update({ completed_at: new Date(Date.now() - 2 * HOUR).toISOString() })
      .eq("id", visit.id);
    await db.from("organizations").update({ reclean_window_hours: 0 }).eq("id", orgId);
    const off = await db.rpc("portal_request_reclean", {
      _token: token,
      _visit_id: visit.id,
      _message: "",
    });
    expect(off.error?.message ?? "", "with the guarantee switched off").toMatch(/reclean_off/);
    await db.from("organizations").update({ reclean_window_hours: 48 }).eq("id", orgId);

    // Granted to service_role only, like portal_report_concern: a signed-in
    // owner is not the portal and cannot file a request as a customer.
    const owner = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error: signInErr } = await owner.auth.signInWithPassword(OWNER);
    if (signInErr) throw new Error(`owner sign-in: ${signInErr.message}`);
    const direct = await owner.rpc("portal_request_reclean", {
      _token: token,
      _visit_id: visit.id,
      _message: "",
    });
    expect(direct.error?.message ?? "", "the RPC called by an authenticated user").toMatch(
      /permission denied/i,
    );
    // ...but the owner reads the ticket through RLS, which is how /concerns
    // gets it.
    const { data: seen } = await owner
      .from("qc_tickets")
      .select("id, category")
      .eq("id", first.data as string)
      .maybeSingle();
    expect(seen?.category).toBe("reclean_request");

    // ── The office's half, through the page ───────────────────────────────
    //
    // The dialog opens on the org's tomorrow. A work day is picked explicitly
    // so a spec that edits work days cannot turn this into a refusal.
    const workDays: number[] = (org.work_days as number[] | null) ?? [0, 1, 2, 3, 4, 5, 6];
    let bookOn = "";
    for (let i = 1; i <= 7 && !bookOn; i++) {
      const d = orgDay(new Date(Date.now() + i * 24 * HOUR), tz);
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (workDays.includes(dow)) bookOn = d;
    }
    if (!bookOn) throw new Error("the org has no work day in the next week");

    await signIn(page);
    await page.goto("/concerns");
    const card = page.locator("li", { hasText: message });
    await expect(card, "the re-clean request on /concerns").toBeVisible({ timeout: 30_000 });
    await expect(card.getByText("Re-clean request", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Schedule re-clean" }).click();

    const dialog = page.getByRole("dialog");
    const date = dialog.getByLabel("Date");
    await expect(date, "defaults to the org's tomorrow").toHaveValue(
      orgDay(new Date(Date.now() + 24 * HOUR), tz),
    );
    await date.fill(bookOn);
    await dialog.getByRole("button", { name: "Book the re-clean" }).click();
    await expect(page.getByText(/^Re-clean booked for/).first(), "the success toast").toBeVisible({
      timeout: 30_000,
    });
    // Booked means acknowledged, which the inbox calls "In progress", so the
    // card leaves "Received" and is found under that filter. Until this
    // change that filter could never match a row: the inbox asked for
    // 'in_progress' and the table's CHECK only allows 'acknowledged'.
    await expect(card).toHaveCount(0);
    await page.getByRole("button", { name: "In progress", exact: true }).click();
    await expect(card.getByText(/Re-clean booked for/)).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole("button", { name: "Schedule re-clean" })).toHaveCount(0);

    // ── And Postgres agrees ───────────────────────────────────────────────
    const { data: linked } = await db
      .from("qc_tickets")
      .select("status, reclean_visit_id")
      .eq("id", first.data as string)
      .single();
    expect(linked?.status, "booked means acknowledged").toBe("acknowledged");
    expect(linked?.reclean_visit_id).toBeTruthy();
    recleanVisitId = linked!.reclean_visit_id;

    const { data: free } = await db
      .from("visits")
      .select(
        "scheduled_on, status, client_id, property_id, assigned_staff_id, subscription_id, subscriptions(price_cents, frequency)",
      )
      .eq("id", recleanVisitId!)
      .single();
    recleanSubscriptionId = free?.subscription_id ?? null;
    const sub = Array.isArray(free?.subscriptions) ? free?.subscriptions[0] : free?.subscriptions;
    expect(free).toMatchObject({
      scheduled_on: bookOn,
      status: "scheduled",
      client_id: visit.client_id,
      property_id: visit.property_id,
      assigned_staff_id: visit.assigned_staff_id,
    });
    expect(sub, "a one-off at no charge").toMatchObject({ price_cents: 0, frequency: "one_time" });

    // Now it IS a re-clean, and the guarantee covers the paid visit, not the
    // free return.
    await db
      .from("visits")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", recleanVisitId!);
    const ofTheReclean = await db.rpc("portal_request_reclean", {
      _token: token,
      _visit_id: recleanVisitId!,
      _message: "",
    });
    expect(ofTheReclean.error?.message ?? "").toMatch(/visit_is_a_reclean/);
  } finally {
    // Read the link BEFORE the tickets go: a run that fails between the
    // booking and the assertions has a booked visit it never recorded, and
    // the ticket is the only thing that knows its id.
    const { data: stray } = await db
      .from("qc_tickets")
      .select("id, reclean_visit_id")
      .in("visit_id", [visit.id, ...(recleanVisitId ? [recleanVisitId] : [])])
      .eq("category", "reclean_request");
    for (const t of stray ?? []) {
      ticketIds.add(t.id);
      if (!recleanVisitId && t.reclean_visit_id) recleanVisitId = t.reclean_visit_id;
    }
    if (recleanVisitId && !recleanSubscriptionId) {
      const { data: v } = await db
        .from("visits")
        .select("subscription_id")
        .eq("id", recleanVisitId)
        .maybeSingle();
      recleanSubscriptionId = v?.subscription_id ?? null;
    }
    if (ticketIds.size)
      await db
        .from("qc_tickets")
        .delete()
        .in("id", [...ticketIds]);
    if (recleanVisitId) await db.from("visits").delete().eq("id", recleanVisitId);
    if (recleanSubscriptionId) {
      await db.from("visits").delete().eq("subscription_id", recleanSubscriptionId);
      await db.from("subscriptions").delete().eq("id", recleanSubscriptionId);
    }
    await db
      .from("activity_log")
      .delete()
      .eq("client_id", visit.client_id)
      .eq("kind", "visit.created")
      .gte("created_at", startedAt);
    await db.from("visits").update({ completed_at: completedBefore }).eq("id", visit.id);
    await db.from("organizations").update({ reclean_window_hours: windowBefore }).eq("id", orgId);
  }
});
