// Put a usable tenant into a local database, so the browser can be driven
// through flows that WRITE.
//
// ── WHY THIS EXISTS, AND WHAT IT IS NOT ───────────────────────────────────
//
// `tests/viewports/` measures twenty authenticated surfaces against
// `fixtures/stub-backend.ts`, and that file says plainly what it is:
//
//     // Writes. Nothing here writes anywhere; they exist so an accidental
//
// Which is correct for what it does. Geometry does not need a database, and a
// sweep that could write would be a sweep that could corrupt itself between
// cases. But it means the whole of `docs/owner-qa-checklist.md` is out of its
// reach, because nearly every item there is a ROUND TRIP: change a value,
// refresh, confirm it stuck. Take a payment, confirm the invoice flips to
// Paid. Work a queue, confirm it empties.
//
// Twenty-two items were sitting on that checklist marked "needs the owner's
// hands". Most of them do not. They need a database that remembers.
//
// ── WHY IT SEEDS SO LITTLE BY HAND ────────────────────────────────────────
//
// Only three rows: an auth user, an organization, and a role. Everything
// after that is `seed_demo_org(_org_id uuid)`, a SECURITY DEFINER function
// that already lives in the migrations and already creates clients, visits,
// invoices, line items and QC tickets.
//
// That split is deliberate. A hand-written seed is a second copy of the
// schema, and a second copy drifts -- this repo has spent a lot of today
// finding places where two copies of one fact disagreed. `seed_demo_org` is
// maintained beside the tables it fills, is exercised by the app's own reseed
// button, and has a migration asserting what it does and does not wipe. Three
// rows is the smallest thing that cannot drift far.
//
// It is called here through the service-role client rather than through
// `reseedDemoData`, which wraps it in `requirePermission` and a demo-org
// check. Those guards are correct for a button a tenant can press and beside
// the point for a fixture on a throwaway database.
//
// ── IT REFUSES TO RUN ANYWHERE THAT MATTERS ───────────────────────────────
//
// `seed_demo_org` MASS DELETES the target org's clients, visits, invoices,
// line items and QC tickets before it writes. On a local database that is the
// point. Against production it would be a catastrophe, and the only thing
// standing between those two is the URL in an environment variable. So the
// guard below is not politeness -- it is the whole safety story, and it
// allowlists localhost rather than denying a list of known-live hosts,
// because a denylist is wrong the first time somebody adds a host to it.

import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.SUPABASE_URL ?? "http://127.0.0.1:54421";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
if (!LOCAL.test(new URL(URL_).origin)) {
  console.error(
    `REFUSING to seed ${URL_}.\n` +
      `seed_demo_org deletes the target organization's clients, visits, invoices,\n` +
      `line items and QC tickets before it writes. This script only ever runs\n` +
      `against a local database, and the check is an allowlist on purpose: a list\n` +
      `of hosts to avoid is wrong the first time somebody adds one.`,
  );
  process.exit(2);
}
if (!KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is not set. `supabase status` prints it.");
  process.exit(2);
}

const ANON = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
if (!ANON) {
  console.error("SUPABASE_PUBLISHABLE_KEY (the anon key) is not set. `supabase status` prints it.");
  process.exit(2);
}

const db = createClient(URL_, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

/** Fixed rather than random, so a failing run can be re-run and inspected, and
 *  so the Playwright side can hardcode them without a handshake file.
 *  ORG_NAME has a second copy: tests/e2e/service-db.ts (E2E_ORG_NAME) — this
 *  file cannot be imported without running the seed, so the specs carry their
 *  own. Change one, change both. */
export const OWNER = { email: "owner@e2e.houndstack.test", password: "e2e-owner-password-1" };
const ORG_NAME = "E2E Demo Yard";

async function ensureUser() {
  // `createUser` is idempotent only by accident: a second call errors rather
  // than returning the existing row, so the existing row is looked up first.
  const { data: list, error: listErr } = await db.auth.admin.listUsers({ perPage: 200 });
  if (listErr) throw new Error(`listUsers: ${listErr.message}`);
  const found = list.users.find((u) => u.email === OWNER.email);
  if (found) return found.id;

  const { data, error } = await db.auth.admin.createUser({
    email: OWNER.email,
    password: OWNER.password,
    // Without this the account exists and cannot sign in, which presents as a
    // login failure and reads like a wrong password.
    email_confirm: true,
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  return data.user.id;
}

async function ensureOrg(userId) {
  const { data: existing } = await db
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing?.organization_id) return existing.organization_id;

  const { data: org, error: orgErr } = await db
    .from("organizations")
    .insert({ name: ORG_NAME })
    .select("id")
    .single();
  if (orgErr) throw new Error(`insert organization: ${orgErr.message}`);

  const { error: roleErr } = await db
    .from("user_roles")
    .insert({ user_id: userId, organization_id: org.id, role: "owner" });
  if (roleErr) throw new Error(`insert user_roles: ${roleErr.message}`);
  return org.id;
}

/**
 * `seed_demo_org` refuses an org with nobody who runs routes:
 *
 *     No active field technicians in this organization -- add someone who
 *     runs routes before seeding visits.
 *
 * Which is the right refusal. A visit belongs to a technician, and an org
 * with visits and no technicians is a state the product cannot reach, so
 * seeding one would build a fixture that is tidier than reality -- the exact
 * failure `docs/mobile-ux-audit.md` records the viewport fixtures making,
 * where every consumer rendered its empty branch and the sweep measured a
 * label production always draws and the fixture never did.
 *
 * So the owner is also the field tech, which is not a workaround: it is the
 * commonest shape of the business this product is for. A one-or-two-truck
 * operator does the office work in the evening and runs the route in the
 * morning.
 */
async function ensureFieldTech(userId, orgId) {
  // The OWNER's staff row, by user_id: the question is "is the owner set up
  // to run routes", not "is there exactly one field tech". The old lookup
  // asked the second with maybeSingle(), which errors the moment an org has
  // two techs -- a normal business -- and the seed then tried to insert the
  // owner again and died on staff_organization_id_user_id_key.
  const { data: existing, error: lookupErr } = await db
    .from("staff")
    .select("id")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (lookupErr) throw new Error(`look up owner staff: ${lookupErr.message}`);
  if (existing?.id) return existing.id;

  const { data, error } = await db
    .from("staff")
    .insert({
      organization_id: orgId,
      user_id: userId,
      role: "owner",
      display_name: "E2E Owner",
      active: true,
      is_field_tech: true,
      routing_available: true,
      // `true`, and the seed does not work without it. A trigger derives
      // `is_field_tech` from `role` unless this flag says a human decided
      // otherwise -- so an insert of role `owner` with `is_field_tech: true`
      // and this left `false` stores `is_field_tech = false`, silently, and
      // `seed_demo_org` then refuses an org that looks like it has a
      // technician in the insert and does not in the table.
      //
      // The flag is not a workaround for the trigger. It IS the product's
      // answer to "the owner also runs routes", which is the commonest shape
      // of the business this is for.
      is_field_tech_overridden: true,
    })
    .select("id")
    .single();
  if (error) throw new Error(`insert staff: ${error.message}`);
  return data.id;
}

const userId = await ensureUser();
const orgId = await ensureOrg(userId);
await ensureFieldTech(userId, orgId);

// The seeded owner has SEEN THE TOUR. A fresh account gets the full-screen
// onboarding overlay (OnboardingTour.tsx, z-[100], a dialog that intercepts
// every pointer event), which the render-only specs never noticed and the
// first behavioural spec hit immediately: every click on /invoices timed out
// against "Guided tour subtree intercepts pointer events". The tour keys off
// auth user_metadata.tour_seen_at, so stamping it here is the product's own
// "seen on another device" path rather than a test-side hack — and a spec
// that wants to test the tour itself should create its own fresh user.
// (2026-10-08: the tour is now the guided setup, src/lib/setup-guide.ts. Same
// record, and no overlay: its first-run prompt is a banner in the flow.)
{
  const { error } = await db.auth.admin.updateUserById(userId, {
    user_metadata: { tour_seen_at: new Date().toISOString() },
  });
  if (error) throw new Error(`stamping tour_seen_at: ${error.message}`);
}

// The owner is NOT a platform admin. the-platform-edits-a-plan.spec.ts grants
// that for its own run and removes it in a finally, because auth.tsx routes
// platform admins to /platform at every sign-in — but a run killed hard
// enough skips even a finally, and a leftover row would hijack every other
// spec's signIn(). The seed is the net under that wire.
{
  const { error } = await db.from("platform_admins").delete().eq("user_id", userId);
  if (error) throw new Error(`clearing platform_admins: ${error.message}`);
}

// ── CALLED AS THE OWNER, NOT AS service_role, AND THAT IS NOT A DETAIL ───
//
// The first version of this called `seed_demo_org` with the service-role
// client and got back:
//
//     Not authorized to reseed this organization
//
// The function checks `auth.uid()` against the caller's role in the target
// org, and a service-role request has no `auth.uid()` at all -- so the
// most-privileged key in the system is the one identity it refuses.
//
// That guard is right, and the fix is not to work around it. Signing in as
// the seeded owner means the fixture is built through the same path a real
// owner pressing Reseed would take, which is worth more than the two lines
// it costs: if that path breaks, the seed fails rather than quietly
// producing data no user could have produced.
const asOwner = createClient(URL_, ANON, { auth: { persistSession: false } });
const { error: signInErr } = await asOwner.auth.signInWithPassword(OWNER);
if (signInErr) throw new Error(`sign in as the seeded owner: ${signInErr.message}`);

const { data: seeded, error: seedErr } = await asOwner.rpc("seed_demo_org", { _org_id: orgId });
if (seedErr) throw new Error(`seed_demo_org: ${seedErr.message}`);

// Print what was actually created rather than "done". A seeder that silently
// produces an empty org is the same failure as a test harness that measures
// nothing, and it would present downstream as a dozen unrelated UI failures.
const counts = {};
for (const t of ["clients", "visits", "invoices"]) {
  const { count } = await db
    .from(t)
    .select("*", { count: "exact", head: true })
    .eq("organization_id", orgId);
  counts[t] = count ?? 0;
}
console.log(`org ${orgId}  user ${userId}`);
console.log(`seed_demo_org -> ${JSON.stringify(seeded)}`);
console.log(
  `rows: ${Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}`,
);

if (Object.values(counts).every((n) => n === 0)) {
  console.error("The seed produced no rows. Downstream this looks like a dozen broken pages.");
  process.exit(1);
}
