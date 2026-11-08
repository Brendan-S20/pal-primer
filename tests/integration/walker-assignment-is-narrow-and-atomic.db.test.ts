/** #731, after review of #733: walker assignment is narrow and atomic.
 *
 *  Two faults, proved here against the real stack the database job builds:
 *
 *  1. A dispatcher could not save a plan's walker. The subscriptions UPDATE
 *     policy is manage_pricing, so the signed-in client's UPDATE matched no
 *     row. set_plan_walker (20261108150200) writes only the walker, for
 *     can_write_org, and the policy stays manage_pricing. Proved with real
 *     sign-ins through the API: a dispatcher saves; their plain UPDATE still
 *     matches nothing and cannot reprice; a tech, another business's
 *     dispatcher and anon are refused; the owner's own UPDATE still works.
 *
 *  2. Assign by capacity could replace a hand assignment made between its read
 *     and its write. assign_walk_group_if_open locks the group and every walk
 *     in it before deciding. Proved with TWO real Postgres sessions whose
 *     interleaving is forced, not slept into: one waits, in SQL, until
 *     pg_stat_activity shows the other blocked on a lock, and only then
 *     commits.
 *       - hand first, capacity during: the old write (a plain group UPDATE)
 *         replaces the hand assignment, the mutation that shows the race is
 *         real; the new function sees it and leaves the group alone;
 *       - capacity first, hand during: the hand assignment waits, lands
 *         after, and is what stands.
 *
 *  Runs where tests/run-db-tests.sh runs it: the database job, on the stack
 *  it has just replayed from every migration. Skipped without TEST_SUPABASE_*
 *  env, like every file in this directory; with that env but without
 *  TEST_SUPABASE_DB_URL or psql it FAILS rather than skip the race. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  DB_ANON,
  DB_URL,
  WALK_ORG_TZ,
  dbEnabled,
  insertRow,
  makeWalkOrg,
  makeWalkVisit,
  type WalkOrg,
} from "../support/walk-db";
import { orgDay } from "../support/org-day";

const PG_URL = process.env.TEST_SUPABASE_DB_URL;
const password = "walker-narrow-password-123!";

let org: WalkOrg;
let other: WalkOrg;
let dispatcher: { userId: string; client: SupabaseClient };
let otherDispatcher: { userId: string; client: SupabaseClient };
let groupServiceId: string;
const extraUsers: string[] = [];

async function signIn(o: WalkOrg, role: "dispatcher") {
  const email = `${role}-${Math.random().toString(36).slice(2, 10)}@walkernarrow.local`;
  const { data, error } = await o.admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  const userId = data.user!.id;
  extraUsers.push(userId);
  await insertRow(o.admin, "user_roles", { user_id: userId, organization_id: o.orgId, role });
  const client = createClient(DB_URL!, DB_ANON!, { auth: { persistSession: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new Error(signedIn.error.message);
  return { userId, client };
}

/** A walk today for a new client, in a new group with nobody on it. */
async function groupWithOneWalk() {
  const { admin, orgId } = org;
  const n = Math.random().toString(36).slice(2, 8);
  const today = orgDay(WALK_ORG_TZ);
  const clientId = await insertRow(admin, "clients", {
    organization_id: orgId,
    display_name: `Narrow client ${n}`,
    account_type: "residential",
    active: true,
  });
  const propertyId = await insertRow(admin, "properties", {
    organization_id: orgId,
    client_id: clientId,
    street: `${n} Narrow St`,
    city: "Austin",
    postal_code: "78701",
  });
  const subscriptionId = await insertRow(admin, "subscriptions", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    account_type: "residential",
    dog_count: 1,
    frequency: "one_time",
    price_cents: 2500,
    service_id: groupServiceId,
    status: "active",
    started_on: today,
  });
  const visitId = await insertRow(admin, "visits", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    subscription_id: subscriptionId,
    service_id: groupServiceId,
    scheduled_on: today,
    status: "scheduled",
  });
  const groupId = await insertRow(admin, "walk_groups", {
    organization_id: orgId,
    service_id: groupServiceId,
    scheduled_on: today,
  });
  const joined = await admin.from("visits").update({ walk_group_id: groupId }).eq("id", visitId);
  if (joined.error) throw new Error(joined.error.message);
  return { groupId, visitId };
}

async function visitRow(id: string) {
  const { data, error } = await org.admin
    .from("visits")
    .select("assigned_staff_id, route_pinned")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data as { assigned_staff_id: string | null; route_pinned: boolean };
}

// ── Two real sessions ─────────────────────────────────────────────────────

type Session = Promise<{ code: number | null; stdout: string; stderr: string }>;

/** A psql session running `script`, named so pg_stat_activity can find it. */
function session(name: string, script: string): Session {
  return new Promise((resolve) => {
    const child = spawn("psql", [PG_URL!, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], {
      env: { ...process.env, PGAPPNAME: name },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(script);
  });
}

function ask(sql: string): string {
  const r = spawnSync("psql", [PG_URL!, "-X", "-A", "-t", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** Polls until `sql` answers t, up to about 20s. Returns whether it ever did. */
async function eventually(sql: string): Promise<boolean> {
  for (let i = 0; i < 400; i++) {
    if (ask(sql) === "t") return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const holding = (name: string) =>
  `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${name}'
     AND state = 'active' AND query LIKE '%walker-race-hold%')`;
const blocked = (name: string) =>
  `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = '${name}'
     AND wait_event_type = 'Lock')`;

/** SQL that waits, inside the holder's open transaction, until `name` is
 *  blocked on a lock, and RAISES if it never is (20s), so the session exits
 *  non-zero and rolls back rather than the test hanging.
 *
 *  pg_stat_clear_snapshot() on every pass is what makes this work: a backend
 *  reads pg_stat_activity once per transaction and then answers from that
 *  snapshot, so without it the loop never sees the other session change. */
const holdUntilBlocked = (name: string) => `
DO $hold$
DECLARE _seen boolean := false;
BEGIN /* walker-race-hold */
  FOR i IN 1..400 LOOP
    PERFORM pg_stat_clear_snapshot();
    IF EXISTS (SELECT 1 FROM pg_stat_activity
                WHERE application_name = '${name}' AND wait_event_type = 'Lock') THEN
      _seen := true;
      EXIT;
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
  IF NOT _seen THEN
    RAISE EXCEPTION 'walker race: never saw % blocked on a lock', '${name}';
  END IF;
END $hold$;`;

/** Session names unique to one test, so a session from another test (one
 *  still finishing after a failure, say) can never be mistaken for this one. */
const names = () => {
  const run = Math.random().toString(36).slice(2, 8);
  return { A: `walker-race-A-${run}`, B: `walker-race-B-${run}` };
};

const RACE_TIMEOUT = 120_000;

const asDispatcher = () => `
SET ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"${dispatcher.userId}","role":"authenticated","aal":"aal1"}', false) \\g /dev/null
`;

const handAssign = (visitId: string, staffId: string) =>
  `UPDATE public.visits SET assigned_staff_id = '${staffId}', route_pinned = true WHERE id = '${visitId}';`;

describe.skipIf(!dbEnabled)("walker assignment is narrow and atomic", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Walker narrow");
    other = await makeWalkOrg("Walker narrow other");
    dispatcher = await signIn(org, "dispatcher");
    otherDispatcher = await signIn(other, "dispatcher");
    groupServiceId = await insertRow(org.admin, "services", {
      organization_id: org.orgId,
      name: "Narrow pack walk",
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: 2500,
      default_duration_min: 60,
      max_dogs: 6,
    });
  });

  afterAll(async () => {
    await org?.cleanup();
    await other?.cleanup();
    for (const uid of extraUsers) await org?.admin.auth.admin.deleteUser(uid);
  });

  describe("a plan's walker", () => {
    it("is saved by a dispatcher through set_plan_walker, and only the walker", async () => {
      const { subscriptionId } = await makeWalkVisit(org);
      // The fault, still there for a plain UPDATE: manage_pricing.
      const plain = await dispatcher.client
        .from("subscriptions")
        .update({ assigned_staff_id: org.walker.staffId })
        .eq("id", subscriptionId)
        .select("id");
      expect(plain.error).toBeNull();
      expect(plain.data).toEqual([]);
      const reprice = await dispatcher.client
        .from("subscriptions")
        .update({ price_cents: 1 })
        .eq("id", subscriptionId)
        .select("id");
      expect(reprice.data).toEqual([]);

      const saved = await dispatcher.client.rpc("set_plan_walker", {
        _subscription_id: subscriptionId,
        _walker_id: org.walker.staffId,
      });
      expect(saved.error).toBeNull();
      const row = await org.admin
        .from("subscriptions")
        .select("assigned_staff_id, price_cents")
        .eq("id", subscriptionId)
        .single();
      expect(row.data).toEqual({ assigned_staff_id: org.walker.staffId, price_cents: 2500 });

      const cleared = await dispatcher.client.rpc("set_plan_walker", {
        _subscription_id: subscriptionId,
        _walker_id: null,
      });
      expect(cleared.error).toBeNull();
      const after = await org.admin
        .from("subscriptions")
        .select("assigned_staff_id")
        .eq("id", subscriptionId)
        .single();
      expect(after.data?.assigned_staff_id).toBeNull();
    });

    it("is refused to a tech, another business, anon, and a walker from elsewhere", async () => {
      const { subscriptionId } = await makeWalkVisit(org);
      const call = (c: SupabaseClient, walker: string | null) =>
        c.rpc("set_plan_walker", { _subscription_id: subscriptionId, _walker_id: walker });

      const tech = await call(org.walker.client, org.walker.staffId);
      expect(tech.error?.message).toBe("Not authorized");
      const stranger = await call(otherDispatcher.client, other.walker.staffId);
      expect(stranger.error?.message).toBe("Not authorized");
      const anonymous = await call(org.anon, org.walker.staffId);
      expect(anonymous.error).not.toBeNull();
      const foreign = await call(dispatcher.client, other.walker.staffId);
      expect(foreign.error?.message).toBe("Choose a walker from this business.");

      const row = await org.admin
        .from("subscriptions")
        .select("assigned_staff_id")
        .eq("id", subscriptionId)
        .single();
      expect(row.data?.assigned_staff_id).toBeNull();
    });

    it("leaves the owner's own plan write as it was", async () => {
      const { subscriptionId } = await makeWalkVisit(org);
      const owner = await org.owner.client
        .from("subscriptions")
        .update({ assigned_staff_id: org.walker.staffId })
        .eq("id", subscriptionId)
        .select("id");
      expect(owner.error).toBeNull();
      expect(owner.data).toHaveLength(1);
    });
  });

  describe("assign by capacity, one call at a time", () => {
    it("assigns an open group, keeps a held one, and refuses a tech and a stranger", async () => {
      const open = await groupWithOneWalk();
      const held = await groupWithOneWalk();
      await org.admin
        .from("visits")
        .update({ assigned_staff_id: org.walker.staffId })
        .eq("id", held.visitId);
      const assign = (c: SupabaseClient, groupId: string) =>
        c.rpc("assign_walk_group_if_open", {
          _group_id: groupId,
          _walker_id: org.otherWalker.staffId,
        });

      expect((await assign(dispatcher.client, open.groupId)).data).toBe("assigned");
      expect((await visitRow(open.visitId)).assigned_staff_id).toBe(org.otherWalker.staffId);
      expect((await assign(dispatcher.client, held.groupId)).data).toBe("members_assigned");
      expect((await visitRow(held.visitId)).assigned_staff_id).toBe(org.walker.staffId);

      expect((await assign(org.walker.client, held.groupId)).error?.message).toBe("Not authorized");
      expect((await assign(otherDispatcher.client, held.groupId)).error?.message).toBe(
        "Not authorized",
      );
    });
  });

  describe("assign by capacity, interleaved with a hand assignment", () => {
    it("has the two sessions it needs", () => {
      expect(PG_URL, "TEST_SUPABASE_DB_URL (tests/run-db-tests.sh exports it)").toBeTruthy();
      expect(spawnSync("psql", ["--version"]).status, "psql").toBe(0);
    });

    /** Hand assignment first and held open; the capacity write arrives during
     *  it, blocks on the walk's row, and runs on after the hand commit. */
    async function handThenCapacity(capacitySql: string) {
      const g = await groupWithOneWalk();
      const n = names();
      const a = session(
        n.A,
        `BEGIN;\n${handAssign(g.visitId, org.walker.staffId!)}\n${holdUntilBlocked(n.B)}\nCOMMIT;\n`,
      );
      expect(await eventually(holding(n.A)), "A holds the hand assignment").toBe(true);
      const b = session(n.B, `${asDispatcher()}\n${capacitySql.replace("%G", g.groupId)}\n`);
      const sawBlock = await eventually(blocked(n.B));
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.code, ra.stderr).toBe(0);
      expect(rb.code, rb.stderr).toBe(0);
      expect(sawBlock, "the capacity write was seen waiting on the hand assignment").toBe(true);
      return { g, out: rb.stdout.trim(), row: await visitRow(g.visitId) };
    }

    it(
      "mutation: the old write replaces a hand assignment committed during it",
      async () => {
        const { row } = await handThenCapacity(
          `UPDATE public.walk_groups SET assigned_staff_id = '${org.otherWalker.staffId}'
          WHERE id = '%G' AND assigned_staff_id IS NULL;`,
        );
        // If this ever stops reproducing, the test below proves nothing.
        expect(row.assigned_staff_id).toBe(org.otherWalker.staffId);
      },
      RACE_TIMEOUT,
    );

    it(
      "assign_walk_group_if_open sees that hand assignment and leaves the group alone",
      async () => {
        const { g, out, row } = await handThenCapacity(
          `SELECT public.assign_walk_group_if_open('%G', '${org.otherWalker.staffId}');`,
        );
        expect(out).toBe("members_assigned");
        expect(row).toEqual({ assigned_staff_id: org.walker.staffId, route_pinned: true });
        const group = await org.admin
          .from("walk_groups")
          .select("assigned_staff_id")
          .eq("id", g.groupId)
          .single();
        expect(group.data?.assigned_staff_id).toBeNull();
      },
      RACE_TIMEOUT,
    );

    it(
      "a hand assignment arriving during a capacity assignment waits and stands",
      async () => {
        const g = await groupWithOneWalk();
        const n = names();
        const b = session(
          n.B,
          `BEGIN;\n${asDispatcher()}\nSELECT public.assign_walk_group_if_open('${g.groupId}', '${org.otherWalker.staffId}');\nRESET ROLE;\n${holdUntilBlocked(n.A)}\nCOMMIT;\n`,
        );
        expect(await eventually(holding(n.B)), "B holds the capacity write").toBe(true);
        const a = session(n.A, `${handAssign(g.visitId, org.walker.staffId!)}\n`);
        const sawBlock = await eventually(blocked(n.A));
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra.code, ra.stderr).toBe(0);
        expect(rb.code, rb.stderr).toBe(0);
        expect(sawBlock, "the hand assignment was seen waiting on the capacity write").toBe(true);
        expect(rb.stdout.trim()).toBe("assigned");
        expect(await visitRow(g.visitId)).toEqual({
          assigned_staff_id: org.walker.staffId,
          route_pinned: true,
        });
      },
      RACE_TIMEOUT,
    );
  });
});
