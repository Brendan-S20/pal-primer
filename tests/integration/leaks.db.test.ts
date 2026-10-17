/**
 * DB-layer backstop tests for QA finding #1 (+#47): each confirmed leak must
 * be rejected by the database itself (RLS policy, SECURITY DEFINER RPC, or
 * trigger), independent of any server-function or UI gating.
 *
 * Runs against a LOCAL Supabase stack only (`supabase start` + the
 * permission-model migration applied). Never point this at production —
 * setup writes rows. Run via: tests/run-db-tests.sh
 *
 * Required env: TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY, TEST_SUPABASE_SERVICE_KEY.
 * The suite is skipped when they are absent so `vitest` stays green locally.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
import { orgDay } from "../support/org-day";

// The org below takes the column default, so its today is today in that zone.
const today = orgDay(DEFAULT_ORG_TIMEZONE);

const URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && ANON && SERVICE);

const PASSWORD = "test-password-123!";
const runId = Math.random().toString(36).slice(2, 8);

let admin: SupabaseClient;
let owner: SupabaseClient;
let dispatcher: SupabaseClient;
let tech: SupabaseClient;

let orgId: string;
let zoneId: string;
let clientId: string;
let addonServiceId: string;
let bigAddonServiceId: string;
let techVisitId: string;
let otherVisitId: string;
let dnaMatchId: string;

async function makeUser(email: string): Promise<{ id: string; client: SupabaseClient }> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  const client = createClient(URL!, ANON!, { auth: { persistSession: false } });
  const { error: sErr } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (sErr) throw new Error(`signIn ${email}: ${sErr.message}`);
  return { id: data.user!.id, client };
}

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as any).id as string;
}

describe.skipIf(!enabled)("DB backstop for finding #1 / #47 leaks", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });

    const o = await makeUser(`owner-${runId}@leaktest.local`);
    const d = await makeUser(`dispatcher-${runId}@leaktest.local`);
    const t = await makeUser(`tech-${runId}@leaktest.local`);
    owner = o.client;
    dispatcher = d.client;
    tech = t.client;

    orgId = await ins("organizations", { name: `Leak Test Org ${runId}` });
    for (const [uid, role] of [
      [o.id, "owner"],
      [d.id, "dispatcher"],
      [t.id, "tech"],
    ] as const) {
      await ins("user_roles", { user_id: uid, organization_id: orgId, role });
    }
    const techStaffId = await ins("staff", {
      organization_id: orgId,
      user_id: t.id,
      role: "tech",
      display_name: "Test Tech",
    });
    const ownerStaffId = await ins("staff", {
      organization_id: orgId,
      user_id: o.id,
      role: "owner",
      display_name: "Test Owner",
    });

    zoneId = await ins("zones", {
      organization_id: orgId,
      name: "Test Zone",
      base_price_cents: 2500,
    });
    clientId = await ins("clients", {
      organization_id: orgId,
      display_name: "Leak Test Client",
      account_type: "residential",
      active: true,
      // Defaults false. log_dna_sample_from_field refuses a client who never
      // opted into the DNA programme — deliberately, per 20260801023000 — so
      // without this the field-RPC test below would fail for a correct reason
      // and read like a broken RPC.
      dna_compliance_enabled: true,
    });
    const propertyId = await ins("properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "123 Test St",
      city: "Austin",
      postal_code: "78701",
    });
    const dogId = await ins("dogs", {
      organization_id: orgId,
      property_id: propertyId,
      name: "Rex",
      dna_registered: true,
    });
    const subscriptionId = await ins("subscriptions", {
      organization_id: orgId,
      client_id: clientId,
      property_id: propertyId,
      zone_id: zoneId,
      account_type: "residential",
      dog_count: 2,
      frequency: "weekly",
      price_cents: 2000,
      status: "active",
      started_on: "2026-01-01",
    });
    techVisitId = await ins("visits", {
      organization_id: orgId,
      subscription_id: subscriptionId,
      client_id: clientId,
      property_id: propertyId,
      zone_id: zoneId,
      assigned_staff_id: techStaffId,
      scheduled_on: today,
    });
    const sub2 = await ins("subscriptions", {
      organization_id: orgId,
      client_id: clientId,
      property_id: propertyId,
      zone_id: zoneId,
      account_type: "residential",
      dog_count: 2,
      frequency: "biweekly",
      price_cents: 2000,
      status: "active",
      started_on: "2026-01-01",
    });
    otherVisitId = await ins("visits", {
      organization_id: orgId,
      subscription_id: sub2,
      client_id: clientId,
      property_id: propertyId,
      zone_id: zoneId,
      assigned_staff_id: ownerStaffId,
      scheduled_on: today,
    });
    addonServiceId = await ins("addon_services", {
      organization_id: orgId,
      code: `SMALL-${runId}`,
      name: "Small add-on",
      kind: "one_time",
      unit_price_cents: 2500,
      active: true,
    });
    bigAddonServiceId = await ins("addon_services", {
      organization_id: orgId,
      code: `BIG-${runId}`,
      name: "Big add-on",
      kind: "one_time",
      unit_price_cents: 50000, // $500 — over the $200 field cap
      active: true,
    });
    dnaMatchId = await ins("dna_matches", {
      organization_id: orgId,
      sample_kind: "pile_sample",
      status: "matched",
      matched_dog_id: dogId,
      client_id: clientId,
      fine_cents: 0,
    });
  });

  // ── Leak 1: Dispatcher had full create/edit/delete on pricing Zones ──────
  describe("dispatcher vs zones (leak 1)", () => {
    it("cannot update zone pricing", async () => {
      const { data } = await dispatcher
        .from("zones")
        .update({ base_price_cents: 1 })
        .eq("id", zoneId)
        .select("id");
      expect(data ?? []).toHaveLength(0); // RLS: zero rows updated
      const { data: check } = await admin
        .from("zones")
        .select("base_price_cents")
        .eq("id", zoneId)
        .single();
      expect(check!.base_price_cents).toBe(2500);
    });

    it("cannot insert or delete zones", async () => {
      const { error: insErr } = await dispatcher
        .from("zones")
        .insert({ organization_id: orgId, name: "Rogue zone", base_price_cents: 1 });
      expect(insErr).not.toBeNull();

      const { data: delData } = await dispatcher.from("zones").delete().eq("id", zoneId).select("id");
      expect(delData ?? []).toHaveLength(0);
    });

    it("can still read zones (read-only for routing)", async () => {
      const { data, error } = await dispatcher.from("zones").select("id").eq("id", zoneId);
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });
  });

  // ── Leak 2: Dispatcher had full client-billing control ───────────────────
  describe("dispatcher vs client billing (leak 2)", () => {
    it("cannot insert invoices", async () => {
      const { error } = await dispatcher.from("invoices").insert({
        organization_id: orgId,
        client_id: clientId,
        kind: "postpaid",
        status: "open",
        subtotal_cents: 1000,
        total_cents: 1000,
        period_start: today,
        period_end: today,
      });
      expect(error).not.toBeNull();
    });

    it("cannot void an invoice via the RPC", async () => {
      const invId = await ins("invoices", {
        organization_id: orgId,
        client_id: clientId,
        kind: "postpaid",
        status: "open",
        subtotal_cents: 1000,
        total_cents: 1000,
        period_start: today,
        period_end: today,
      });
      const { error } = await dispatcher.rpc("void_invoice", { _invoice_id: invId });
      expect(error).not.toBeNull();
      const { data: check } = await admin.from("invoices").select("status").eq("id", invId).single();
      expect(check!.status).toBe("open");
    });

    it("cannot create office add-on charges via the RPC", async () => {
      const { error } = await dispatcher.rpc("create_addon_charge", {
        _client_id: clientId,
        _addon_service_id: addonServiceId,
        _quantity: 1,
        _source: "office",
      });
      expect(error).not.toBeNull();
    });
  });

  // ── Leak 3: Technician could set DNA fines and mark samples billed ───────
  describe("tech vs DNA billing (leak 3)", () => {
    // ── WHAT THE FIRST EVER RUN OF THIS BLOCK ACTUALLY SHOWED ────────────
    //
    // These tests ran for the first time on 2026-08-15, when the Sandboxes
    // replay finally built a database for them. Both forbidden-write tests
    // failed on `expect(error).not.toBeNull()`, so an assertion was added
    // above them to read the row back first and say which situation it was.
    // The answer came back on the next run:
    //
    //     the fine was refused, but silently — no error reached the caller
    //
    // The fine was 0 and the status was not 'billed', so nothing leaked. But
    // "refused silently" turned out to be the wrong description too, and the
    // right one is worse for this block than for the product:
    //
    //   1. tg_dna_matches_guard_billing RAISES — it does not quietly revert:
    //        IF NOT has_permission(auth.uid(), OLD.organization_id,
    //                              'manage_dna_billing') THEN
    //          RAISE EXCEPTION 'Setting fines or billing DNA samples requires
    //                           office permissions';
    //      So no error means the trigger NEVER FIRED.
    //   2. It never fired because the UPDATE matched no row. The only UPDATE
    //      policy on dna_matches is `can_write_org(auth.uid(), organization_id)`
    //      — office only. A technician cannot update the row at all, so
    //      PostgREST updates nothing and returns success.
    //
    // The tenant is safe, by RLS rather than by the guard, which is defence in
    // depth working as intended. What is NOT fine is that this whole block was
    // vacuous: four tests that read like a proof of a cross-role protection,
    // none of which reached the protection.
    //
    // So the mechanism is asserted directly now. `expect(error).not.toBeNull()`
    // is gone from these two, not to make them pass, but because it was never
    // testing what it claimed: a technician gets no error here and never will,
    // and an expectation that can only be met by a code path RLS makes
    // unreachable is a false statement about the system.
    it("cannot even see the row to update it — RLS refuses before the guard", async () => {
      // The non-vacuity check for everything below. If a technician CAN read a
      // dna_matches row, this fails and the two tests after it become real
      // tests of the trigger instead of assertions about an empty result set.
      const { data: visible } = await tech
        .from("dna_matches")
        .select("id")
        .eq("id", dnaMatchId);
      expect(visible, "a technician can now read DNA matches — re-read this block").toEqual([]);
    });

    it("cannot set a fine amount", async () => {
      await tech
        .from("dna_matches")
        .update({ fine_cents: 99900 })
        .eq("id", dnaMatchId);
      const { data: check } = await admin
        .from("dna_matches")
        .select("fine_cents")
        .eq("id", dnaMatchId)
        .single();
      expect(check, "the fixture row is gone — nothing was under test").not.toBeNull();
      expect(check!.fine_cents, "a technician set a fine on a DNA violation").toBe(0);
    });

    it("cannot mark a sample billed", async () => {
      await tech
        .from("dna_matches")
        .update({ status: "billed" })
        .eq("id", dnaMatchId);
      const { data: check } = await admin
        .from("dna_matches")
        .select("status")
        .eq("id", dnaMatchId)
        .single();
      expect(check, "the fixture row is gone — nothing was under test").not.toBeNull();
      expect(check!.status, "a technician marked a DNA sample billed").not.toBe("billed");
    });

    // ── THIS TEST USED TO CLAIM THE OPPOSITE, AND PASSED ON NOTHING ──────
    //
    // It read:
    //
    //   it("can still perform field status moves (sent_to_lab)", ...)
    //     const { error } = await tech.from("dna_matches")
    //       .update({ status: "sent_to_lab" }).eq("id", dnaMatchId);
    //     expect(error).toBeNull();
    //
    // which a technician satisfies by updating nothing at all: PostgREST
    // returns no error when RLS leaves no row to change. It was green from the
    // day it was written and had never once exercised the capability it named.
    //
    // That capability was removed on purpose, and the file that removed it says
    // so in as many words. 20260801021000 closed a hole where every policy on
    // dna_matches was `is_org_member` — a tech could re-point a $250 violation
    // onto another client's dog. 20260801023000 then gave techs back the ONE
    // thing they legitimately need, deliberately as an RPC rather than a
    // policy: "Matching it to a dog, pricing it, and billing it stay office
    // actions behind can_write_org and manage_dna_billing, exactly as before.
    // This adds a way to START the trail, not to decide its outcome."
    //
    // So the field capability is log_dna_sample_from_field, which takes a
    // VISIT the tech is assigned to and derives everything else from it. That
    // is what this now tests, against the visit the fixture already assigns to
    // this technician — a real call with a real outcome, rather than an absent
    // error.
    it("logs a sample through the field RPC, which is the route techs have", async () => {
      const { data, error } = await tech.rpc("log_dna_sample_from_field", {
        _visit_id: techVisitId,
      });
      expect(error, "a technician cannot log a DNA sample from their own visit").toBeNull();
      expect(data, "the RPC returned no sample id").toBeTruthy();

      // Derived, never accepted from the caller: it lands unprocessed and
      // unbilled no matter what the tech would have liked.
      const { data: row } = await admin
        .from("dna_matches")
        .select("status, fine_cents, organization_id")
        .eq("id", data as string)
        .single();
      expect(row!.status).toBe("new");
      expect(row!.fine_cents ?? 0).toBe(0);
      expect(row!.organization_id).toBe(orgId);
    });

    it("owner CAN set a fine and bill (regression)", async () => {
      const { error } = await owner
        .from("dna_matches")
        .update({ fine_cents: 5000 })
        .eq("id", dnaMatchId);
      expect(error).toBeNull();
      await admin.from("dna_matches").update({ fine_cents: 0 }).eq("id", dnaMatchId);
    });
  });

  // ── Leak 5: Technician add-on billing had no cap / no ownership check ─────
  describe("tech vs field add-ons (leak 5)", () => {
    it("rejects a field charge above the org cap", async () => {
      const { error } = await tech.rpc("create_addon_charge", {
        _client_id: clientId,
        _addon_service_id: bigAddonServiceId,
        _quantity: 1,
        _source: "field",
        _visit_id: techVisitId,
      });
      expect(error).not.toBeNull();
      expect(String(error!.message)).toMatch(/cap/i);
    });

    it("rejects a small charge multiplied over the cap", async () => {
      const { error } = await tech.rpc("create_addon_charge", {
        _client_id: clientId,
        _addon_service_id: addonServiceId,
        _quantity: 99,
        _source: "field",
        _visit_id: techVisitId,
      });
      expect(error).not.toBeNull();
    });

    it("rejects a field charge without a visit, or on someone else's visit", async () => {
      const { error: noVisit } = await tech.rpc("create_addon_charge", {
        _client_id: clientId,
        _addon_service_id: addonServiceId,
        _quantity: 1,
        _source: "field",
      });
      expect(noVisit).not.toBeNull();

      const { error: wrongVisit } = await tech.rpc("create_addon_charge", {
        _client_id: clientId,
        _addon_service_id: addonServiceId,
        _quantity: 1,
        _source: "field",
        _visit_id: otherVisitId,
      });
      expect(wrongVisit).not.toBeNull();
    });

    it("rejects a tech billing with source=office", async () => {
      const { error } = await tech.rpc("create_addon_charge", {
        _client_id: clientId,
        _addon_service_id: addonServiceId,
        _quantity: 1,
        _source: "office",
      });
      expect(error).not.toBeNull();
    });

    it("accepts a capped, own-visit field charge (the legitimate flow)", async () => {
      const { data, error } = await tech.rpc("create_addon_charge", {
        _client_id: clientId,
        _addon_service_id: addonServiceId,
        _quantity: 1,
        _source: "field",
        _visit_id: techVisitId,
      });
      expect(error).toBeNull();
      expect(data).toBeTruthy();
      const { data: charge } = await admin
        .from("addon_charges")
        .select("source, amount_cents")
        .eq("id", data as string)
        .single();
      expect(charge!.source).toBe("field");
      expect(charge!.amount_cents).toBe(2500);
    });

    it("cannot void a charge (office capability)", async () => {
      const { data: charges } = await admin
        .from("addon_charges")
        .select("id")
        .eq("client_id", clientId)
        .limit(1);
      const { error } = await tech.rpc("void_addon_charge", { _charge_id: charges![0].id });
      expect(error).not.toBeNull();
    });
  });

  // ── Leaks 4 & 6 (tech client-directory redaction, dispatcher dashboard
  // KPIs) are enforced in the server-function layer — asserted by
  // tests/authz.server.test.ts + tests/permissions.test.ts. At the DB tier we
  // pin the financial-read backstop introduced by the migration: ─────────────
  describe("financial reads (leak 6 backstop)", () => {
    it("dispatcher cannot read invoices directly", async () => {
      const { data } = await dispatcher.from("invoices").select("id").eq("organization_id", orgId);
      expect(data ?? []).toHaveLength(0);
    });

    it("tech cannot read invoices directly", async () => {
      const { data } = await tech.from("invoices").select("id").eq("organization_id", orgId);
      expect(data ?? []).toHaveLength(0);
    });

    it("owner still reads invoices (regression)", async () => {
      const { data, error } = await owner.from("invoices").select("id").eq("organization_id", orgId);
      expect(error).toBeNull();
      expect((data ?? []).length).toBeGreaterThan(0);
    });
  });

  // ── Office Manager spot-check: retains billing/pricing (regression) ───────
  describe("owner/office_manager positive paths", () => {
    it("owner can update zone pricing", async () => {
      const { data, error } = await owner
        .from("zones")
        .update({ base_price_cents: 2600 })
        .eq("id", zoneId)
        .select("id");
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      await admin.from("zones").update({ base_price_cents: 2500 }).eq("id", zoneId);
    });

    it("owner can create an office add-on charge with a price override", async () => {
      const { error } = await owner.rpc("create_addon_charge", {
        _client_id: clientId,
        _addon_service_id: addonServiceId,
        _quantity: 1,
        _unit_price_cents: 1234,
        _source: "office",
      });
      expect(error).toBeNull();
    });
  });
});
