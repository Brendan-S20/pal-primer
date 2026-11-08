/** #731, after review of #733: walker assignment is narrow and atomic.
 *
 *  Two faults, proved here against the real stack the database job builds:
 *
 *  1. A dispatcher could not save a plan's walker. The subscriptions UPDATE
 *     policy is manage_pricing, so the signed-in client's UPDATE matched no
 *     row. set_plan_walker (20261108170200) writes only the walker, for
 *     can_write_org, and the policy stays manage_pricing. Proved with real
 *     sign-ins through the API: a dispatcher saves; their plain UPDATE still
 *     matches nothing and cannot reprice; a tech, another business's
 *     dispatcher and anon are refused; the owner's own UPDATE still works.
 *
 *  2. Assign by capacity could replace a hand assignment made between its read
 *     and its write. assign_walk_group_if_open locks the group, then every
 *     walk in it WITHOUT WAITING, and only then decides. Proved with real
 *     Postgres sessions whose interleaving is forced, never slept into: a
 *     session holds its transaction open and waits, in SQL, until
 *     pg_stat_activity shows the other session in the state the case needs.
 *       - hand assignment in flight, capacity during: the old write (a plain
 *         group UPDATE) waits and then replaces it (the mutation that shows
 *         the race is real); the new function answers 'busy' and writes
 *         nothing;
 *       - capacity first, hand assignment during: the hand assignment waits,
 *         lands after, and is what stands.
 *
 *  3. Lock order (#733 review). A member whose plan changes, or that rejoins
 *     its group, takes its own row and then the group; this function takes
 *     the group and then the rows. A version that WAITED for the rows would
 *     deadlock against such a writer, and does here (the second mutation).
 *     The real function never waits on a row while holding the group, so the
 *     same interleavings finish: it answers 'busy', the writer completes.
 *
 *  Every session runs with lock_timeout (20s) and statement_timeout (30s),
 *  every hold loop gives up and raises after 10s, deliberately shorter than
 *  the lock timeout: a lock wait that hits lock_timeout raises
 *  lock_not_available, the very error NOWAIT raises, so a version that WAITED
 *  would otherwise turn into 'busy' at 20s and pass by timing. With 10s it
 *  fails instead. every child is killed and every
 *  backend terminated after each test whatever happened, and each test names
 *  its sessions uniquely, so one case can never leak into the next.
 *
 *  Runs where tests/run-db-tests.sh runs it: the database job, on the stack
 *  it has just replayed from every migration. Skipped without TEST_SUPABASE_*
 *  env, like every file in this directory; with that env but without
 *  TEST_SUPABASE_DB_URL or psql it FAILS rather than skip the race. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
  return { groupId, visitId, clientId, propertyId, subscriptionId };
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

// ── Real sessions, with every wait bounded and every child reaped ────────

type Result = { code: number | null; stdout: string; stderr: string };

/** Every psql child still running, so afterEach can kill it whatever a test
 *  did; and the prefix every race session's name carries, so afterEach can
 *  terminate its backend too. */
const live = new Set<ChildProcess>();
const RACE_PREFIX = "walker-race-";

/** A psql session running `script` in one connection, named for
 *  pg_stat_activity. The database bounds its waits (lock_timeout,
 *  statement_timeout); the child is killed outright at 45s regardless. */
function session(name: string, script: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn("psql", [PG_URL!, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"], {
      env: {
        ...process.env,
        PGAPPNAME: name,
        PGOPTIONS: "-c lock_timeout=20s -c statement_timeout=30s",
      },
    });
    live.add(child);
    const killer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(killer);
      live.delete(child);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

function ask(sql: string): string {
  const r = spawnSync("psql", [PG_URL!, "-X", "-A", "-t", "-c", sql], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `psql exited ${r.status}`);
  return r.stdout.trim();
}

/** Polls (each poll its own connection, so its own fresh view of
 *  pg_stat_activity) until `cond` holds, for at most 10s of wall clock. */
async function eventually(cond: string): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (ask(`SELECT ${cond}`) === "t") return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Session `name` is waiting on a lock. */
const isBlocked = (name: string) =>
  `EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE application_name = '${name}' AND wait_event_type = 'Lock')`;
/** Session `name` is inside its own hold loop (so it holds what it took). */
const isHolding = (name: string) =>
  `EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE application_name = '${name}' AND state = 'active'
              AND query LIKE '%walker-race-hold%')`;

/** SQL that waits, inside the holder's open transaction, until `cond` holds,
 *  and RAISES after ~10s (under lock_timeout, see the header) if it never does, so the session exits non-zero and
 *  rolls back instead of hanging. pg_stat_clear_snapshot() on every pass is
 *  what lets it see anything: a backend answers pg_stat_activity from a
 *  snapshot taken once per transaction. */
const holdUntil = (cond: string, label: string) => `
DO $hold$
DECLARE _seen boolean := false;
BEGIN /* walker-race-hold */
  FOR i IN 1..200 LOOP
    PERFORM pg_stat_clear_snapshot();
    IF ${cond} THEN
      _seen := true;
      EXIT;
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
  IF NOT _seen THEN
    RAISE EXCEPTION 'walker race: gave up waiting until %', '${label}';
  END IF;
END $hold$;`;

/** Session names unique to one test. */
const names = () => {
  const run = Math.random().toString(36).slice(2, 8);
  return { A: `${RACE_PREFIX}A-${run}`, B: `${RACE_PREFIX}B-${run}` };
};

/** Each race case's budget. Every wait inside it is bounded well below. */
const RACE_TIMEOUT = 60_000;

const asDispatcher = () => `
SET ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"${dispatcher.userId}","role":"authenticated","aal":"aal1"}', false) \\g /dev/null
`;

const handAssign = (visitId: string, staffId: string) =>
  `UPDATE public.visits SET assigned_staff_id = '${staffId}', route_pinned = true WHERE id = '${visitId}';`;

/** Runs the two sessions to the end. A holding session commits only after
 *  its hold loop has SEEN the state it waits for, and raises otherwise, so its
 *  exit code 0 is the proof that the interleaving happened. (Polling for that
 *  state from here as well would race the holder, which moves on within one
 *  50ms pass of seeing it.) */
async function both(a: Promise<Result>, b: Promise<Result>) {
  const [ra, rb] = await Promise.all([a, b]);
  return { ra, rb };
}

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

  describe("assign by capacity, interleaved", () => {
    afterEach(async () => {
      // Whatever the test did: kill every child, end every race backend.
      const waiting = [...live].map(
        (c) => new Promise<void>((r) => (c.exitCode !== null ? r() : c.once("close", () => r()))),
      );
      for (const c of live) c.kill("SIGKILL");
      await Promise.all(waiting);
      ask(
        `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity
          WHERE application_name LIKE '${RACE_PREFIX}%'`,
      );
    });

    it("has the sessions it needs", () => {
      expect(PG_URL, "TEST_SUPABASE_DB_URL (tests/run-db-tests.sh exports it)").toBeTruthy();
      expect(spawnSync("psql", ["--version"]).status, "psql").toBe(0);
    });

    it(
      "mutation: the old write waits for an in-flight hand assignment and then replaces it",
      async () => {
        const g = await groupWithOneWalk();
        const n = names();
        const a = session(
          n.A,
          `BEGIN;\n${handAssign(g.visitId, org.walker.staffId!)}\n${holdUntil(isBlocked(n.B), "B blocked")}\nCOMMIT;\n`,
        );
        expect(await eventually(isHolding(n.A)), "A holds the hand assignment").toBe(true);
        const b = session(
          n.B,
          `${asDispatcher()}\nUPDATE public.walk_groups SET assigned_staff_id = '${org.otherWalker.staffId}'
            WHERE id = '${g.groupId}' AND assigned_staff_id IS NULL;\n`,
        );
        const { ra, rb } = await both(a, b);
        expect(ra.code, ra.stderr).toBe(0);
        expect(rb.code, rb.stderr).toBe(0);
        // If this ever stops reproducing, the next case proves nothing.
        expect((await visitRow(g.visitId)).assigned_staff_id).toBe(org.otherWalker.staffId);
      },
      RACE_TIMEOUT,
    );

    it(
      "assign_walk_group_if_open refuses while a hand assignment is in flight, and writes nothing",
      async () => {
        const g = await groupWithOneWalk();
        const n = names();
        const a = session(
          n.A,
          `BEGIN;\n${handAssign(g.visitId, org.walker.staffId!)}\nSELECT pg_advisory_xact_lock(hashtext('${n.B}')) \\g /dev/null\n${holdUntil(isBlocked(n.B), "B, past its call, waits on A's advisory lock")}\nCOMMIT;\n`,
        );
        expect(await eventually(isHolding(n.A)), "A holds the hand assignment").toBe(true);
        const b = session(
          n.B,
          // The call, then a wait on A's advisory lock: B can only block there
          // once the call has returned, and A commits only once it sees B
          // blocked, so the call ran while the hand assignment was open.
          `${asDispatcher()}\nSELECT public.assign_walk_group_if_open('${g.groupId}', '${org.otherWalker.staffId}');\nRESET ROLE;\nSELECT pg_advisory_lock(hashtext('${n.B}')) \\g /dev/null\n`,
        );
        const { ra, rb } = await both(a, b);
        expect(ra.code, ra.stderr).toBe(0);
        expect(rb.code, rb.stderr).toBe(0);
        expect(rb.stdout.trim()).toBe("busy");
        expect(await visitRow(g.visitId)).toEqual({
          assigned_staff_id: org.walker.staffId,
          route_pinned: true,
        });
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
          `BEGIN;\n${asDispatcher()}\nSELECT public.assign_walk_group_if_open('${g.groupId}', '${org.otherWalker.staffId}');\nRESET ROLE;\n${holdUntil(isBlocked(n.A), "A blocked")}\nCOMMIT;\n`,
        );
        expect(await eventually(isHolding(n.B)), "B holds the capacity write").toBe(true);
        const a = session(n.A, `${handAssign(g.visitId, org.walker.staffId!)}\n`);
        const { ra, rb } = await both(a, b);
        expect(ra.code, ra.stderr).toBe(0);
        expect(rb.code, rb.stderr).toBe(0);
        expect(rb.stdout.trim()).toBe("assigned");
        expect(await visitRow(g.visitId)).toEqual({
          assigned_staff_id: org.walker.staffId,
          route_pinned: true,
        });
      },
      RACE_TIMEOUT,
    );

    /** A second plan for the same client, home and group service, so moving
     *  the walk onto it keeps the walk in the group (validate_walk_group_member
     *  then takes the group lock rather than detaching it). */
    async function secondPlan(g: Awaited<ReturnType<typeof groupWithOneWalk>>) {
      return insertRow(org.admin, "subscriptions", {
        organization_id: org.orgId,
        client_id: g.clientId,
        property_id: g.propertyId,
        account_type: "residential",
        dog_count: 1,
        frequency: "one_time",
        price_cents: 2500,
        service_id: groupServiceId,
        status: "active",
        started_on: orgDay(WALK_ORG_TZ),
      });
    }

    /** The plan-change writer: takes the walk's row, waits until `when` holds
     *  for the other session, then changes the walk's plan, which asks for
     *  the group. */
    const planChange = (visitId: string, sub2: string, when: string, label: string) =>
      `BEGIN;
SELECT 1 FROM public.visits WHERE id = '${visitId}' FOR NO KEY UPDATE \\g /dev/null
${holdUntil(when, label)}
UPDATE public.visits SET subscription_id = '${sub2}' WHERE id = '${visitId}';
COMMIT;
`;

    it(
      "mutation: a version that waits for the walks deadlocks against a plan change",
      async () => {
        const g = await groupWithOneWalk();
        const sub2 = await secondPlan(g);
        const n = names();
        // The old lock order, as a committed function in this throwaway
        // database (another session cannot see an uncommitted one): the group,
        // then the walks, waiting. Dropped in `finally`.
        const fn = `public.zz_walker_race_waiting_${n.A.slice(-6)}`;
        ask(`CREATE FUNCTION ${fn}(_g uuid) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM 1 FROM public.walk_groups WHERE id = _g FOR UPDATE;
  PERFORM 1 FROM public.visits WHERE walk_group_id = _g ORDER BY id FOR NO KEY UPDATE;
  RETURN 'locked';
END $f$`);
        try {
          // A asks for the group only once B is seen waiting on the walk,
          // i.e. once B already holds the group.
          const a = session(
            n.A,
            planChange(g.visitId, sub2, isBlocked(n.B), "B holds the group and waits on the walk"),
          );
          expect(await eventually(isHolding(n.A)), "A holds the walk's row").toBe(true);
          const b = session(n.B, `BEGIN;\nSELECT ${fn}('${g.groupId}');\nCOMMIT;\n`);
          const { ra, rb } = await both(a, b);
          // B takes the group and waits on the walk; A, holding the walk,
          // asks for the group. Postgres finds the cycle and kills one.
          const out = `${ra.stderr}\n${rb.stderr}`;
          expect(out, "the waiting version deadlocks").toMatch(/deadlock detected/);
        } finally {
          ask(`DROP FUNCTION IF EXISTS ${fn}(uuid)`);
        }
      },
      RACE_TIMEOUT,
    );

    it(
      "assign_walk_group_if_open and a plan change on one of its walks both finish",
      async () => {
        const g = await groupWithOneWalk();
        const sub2 = await secondPlan(g);
        const n = names();
        // A holds the walk's row and, once B holds the group, asks for it.
        const a = session(n.A, planChange(g.visitId, sub2, isHolding(n.B), "B holds the group"));
        expect(await eventually(isHolding(n.A)), "A holds the walk's row").toBe(true);
        // B takes the group, finds the walk locked, answers busy, and holds
        // the group until A is seen waiting for it.
        const b = session(
          n.B,
          `BEGIN;\n${asDispatcher()}\nSELECT public.assign_walk_group_if_open('${g.groupId}', '${org.otherWalker.staffId}');\nRESET ROLE;\n${holdUntil(isBlocked(n.A), "A blocked on the group")}\nCOMMIT;\n`,
        );
        const { ra, rb } = await both(a, b);
        expect(`${ra.stderr}${rb.stderr}`).not.toMatch(/deadlock/);
        expect(ra.code, ra.stderr).toBe(0);
        expect(rb.code, rb.stderr).toBe(0);
        expect(rb.stdout.trim()).toBe("busy");
        const row = await org.admin
          .from("visits")
          .select("subscription_id, walk_group_id, assigned_staff_id")
          .eq("id", g.visitId)
          .single();
        expect(row.data).toEqual({
          subscription_id: sub2,
          walk_group_id: g.groupId,
          assigned_staff_id: null,
        });
      },
      RACE_TIMEOUT,
    );

    it(
      "assign_walk_group_if_open and a walk rejoining its group both finish",
      async () => {
        const g = await groupWithOneWalk();
        const n = names();
        // A takes the walk out of the group (its row, no group lock), waits
        // until B holds the group, then puts it back (which asks for it).
        const a = session(
          n.A,
          `BEGIN;
UPDATE public.visits SET walk_group_id = NULL WHERE id = '${g.visitId}';
${holdUntil(isHolding(n.B), "B holds the group")}
UPDATE public.visits SET walk_group_id = '${g.groupId}' WHERE id = '${g.visitId}';
COMMIT;
`,
        );
        expect(await eventually(isHolding(n.A)), "A holds the walk's row").toBe(true);
        const b = session(
          n.B,
          `BEGIN;\n${asDispatcher()}\nSELECT public.assign_walk_group_if_open('${g.groupId}', '${org.otherWalker.staffId}');\nRESET ROLE;\n${holdUntil(isBlocked(n.A), "A blocked on the group")}\nCOMMIT;\n`,
        );
        const { ra, rb } = await both(a, b);
        expect(`${ra.stderr}${rb.stderr}`).not.toMatch(/deadlock/);
        expect(ra.code, ra.stderr).toBe(0);
        expect(rb.code, rb.stderr).toBe(0);
        expect(rb.stdout.trim()).toBe("busy");
        const row = await org.admin
          .from("visits")
          .select("walk_group_id, assigned_staff_id")
          .eq("id", g.visitId)
          .single();
        expect(row.data).toEqual({ walk_group_id: g.groupId, assigned_staff_id: null });
      },
      RACE_TIMEOUT,
    );
  });
});
