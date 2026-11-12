/** #769 acceptance 4, on a real database: "e2e: walking signup asserts
 *  walksDone true without a manual detour that the owner can miss."
 *
 *  #797 and #875 both said there was no real-database proof of it:
 *  tests/a-walker-prices-both-walks-before-setup-moves-on.test.tsx drives the
 *  form against a FAKE setSetupWalkPrices and hands in-memory services to
 *  loadOnboardingStatus, and the Playwright e2e seed is a pet-waste business.
 *  This runs the chain against the local stack the CI database job builds
 *  from every migration:
 *
 *    signup      bootstrapOrganization({ serviceLine: "dog_walking" }), the
 *                real server function, as a brand-new signed-in user. It
 *                calls bootstrap_organization and then
 *                startNewOrgOnRequestedLine, which seeds the walks from
 *                DEFAULT_SERVICE_SEEDS with blank prices.
 *    /setup      the payload WalkPricesForm builds (setupWalkFields and
 *                setupWalkPricesProblem, the form's own rules) sent to the
 *                real setSetupWalkPrices, which writes
 *                services.base_price_cents under the owner's RLS.
 *    "done"      the real loadOnboardingStatus, reading services back the
 *                way the server does (walksPricedForSetup).
 *
 *  Nothing here opens Settings: the only write between signup and "done" is
 *  the /setup save. A business that scoops AND walks (setup step 1's
 *  setServiceLines) is covered the same way.
 *
 *  Only the framework wrapper is stood in for: each handler runs with the
 *  signed-in user's own client, the context the auth middleware builds, and
 *  the service-role client is the real one on the local stack. Each business
 *  is a labelled TEST org made here and deleted after.
 *
 *  Skipped without TEST_SUPABASE_* env, like every file here. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DB_ANON, DB_SERVICE, DB_URL, dbEnabled } from "../support/walk-db";

const caller = vi.hoisted(() => ({ supabase: null as unknown, userId: "" }));

vi.mock("@tanstack/react-start", () => {
  const createServerFn = () => {
    let validate: (d: unknown) => unknown = (d) => d;
    type Builder = {
      middleware: () => Builder;
      inputValidator: (v: (d: unknown) => unknown) => Builder;
      handler: (
        h: (ctx: { data: unknown; context: unknown }) => unknown,
      ) => (opts?: { data?: unknown }) => unknown;
    };
    const b: Builder = {
      middleware: () => b,
      inputValidator: (v) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({
            data: validate(opts.data ?? {}),
            context: { supabase: caller.supabase, userId: caller.userId },
          }),
    };
    return b;
  };
  return { createServerFn, createServerOnlyFn: <T>(fn: T) => fn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  return {
    supabaseAdmin: createClient(
      process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:1",
      process.env.TEST_SUPABASE_SERVICE_KEY ?? "unset",
      { auth: { persistSession: false } },
    ),
  };
});

/** A server function, as the stand-in wrapper above returns it. */
type Handler = (opts?: unknown) => Promise<unknown>;

const password = "walker-signup-password-123!";

type Owner = { userId: string; client: SupabaseClient; orgId: string };
type Walk = {
  id: string;
  name: string;
  default_duration_min: number | null;
  base_price_cents: number | null;
};

let admin: SupabaseClient;
const made: Owner[] = [];

function as(owner: Owner) {
  caller.supabase = owner.client;
  caller.userId = owner.userId;
}

/** A brand-new person signs up, as Get-started does. */
async function signUp(label: string, serviceLine?: string): Promise<Owner> {
  const runId = Math.random().toString(36).slice(2, 10);
  const email = `${label}-${runId}@walkersignup.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  const userId = data.user!.id;
  const client = createClient(DB_URL!, DB_ANON!, { auth: { persistSession: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new Error(signedIn.error.message);
  caller.supabase = client;
  caller.userId = userId;
  const { bootstrapOrganization } = await import("@/lib/org.functions");
  const r = (await (bootstrapOrganization as unknown as Handler)({
    data: {
      orgName: `TEST ${label} ${runId}`,
      displayName: "Test Owner",
      timezone: "UTC",
      ...(serviceLine ? { serviceLine } : {}),
    },
  })) as { organizationId: string };
  expect(r.organizationId).toBeTruthy();
  const owner = { userId, client, orgId: r.organizationId };
  made.push(owner);
  return owner;
}

/** The business's active walks, read as the service role. */
async function walks(owner: Owner): Promise<Walk[]> {
  const { data, error } = await admin
    .from("services")
    .select("id, name, default_duration_min, base_price_cents")
    .eq("organization_id", owner.orgId)
    .eq("service_line", "dog_walking")
    .eq("active", true)
    .order("default_duration_min");
  if (error) throw new Error(error.message);
  return (data ?? []) as Walk[];
}

const byLength = (ws: Walk[], min: number) => ws.find((w) => w.default_duration_min === min)!;

/** What the server says about setup: the real loadOnboardingStatus. */
async function setupStatus(owner: Owner) {
  as(owner);
  const { loadOnboardingStatus } = await import("@/lib/onboarding.functions");
  const status = (await (loadOnboardingStatus as unknown as Handler)({
    supabase: owner.client,
    userId: owner.userId,
  })) as {
    steps: Array<{
      id: string;
      label: string;
      done: boolean;
      to: string;
      parts?: Array<{ id: string; done: boolean }>;
    }>;
  };
  const step = status.steps.find((s) => s.id === "zones");
  expect(step, "the price step").toBeTruthy();
  return step!;
}

/** /setup's Save: WalkPricesForm's payload from what the owner typed (blank
 *  is ""), refused by the form's own rule before anything is sent, exactly
 *  as the form does. Returns the refusal, or null when it was saved. */
async function saveOnSetup(owner: Owner, typed: Record<number, string>): Promise<string | null> {
  const { setupWalkFields, setupWalkPricesProblem, walkPriceCents } =
    await import("@/lib/setup-walk-prices");
  const rows = setupWalkFields(await walks(owner)).map(({ walk, required }) => ({
    id: walk.id,
    name: walk.name,
    required,
    cents: walkPriceCents(typed[walk.default_duration_min ?? -1] ?? ""),
  }));
  const problem = setupWalkPricesProblem(rows);
  if (problem) return problem;
  as(owner);
  const { setSetupWalkPrices } = await import("@/lib/setup-walk-prices.functions");
  await (setSetupWalkPrices as unknown as Handler)({
    data: { prices: rows.map(({ id, cents }) => ({ id, cents })) },
  });
  return null;
}

/** A write straight to setSetupWalkPrices, as a caller that skipped the
 *  form would make it. */
async function writePrices(owner: Owner, prices: Array<{ id: string; cents: number | null }>) {
  as(owner);
  const { setSetupWalkPrices } = await import("@/lib/setup-walk-prices.functions");
  await (setSetupWalkPrices as unknown as Handler)({ data: { prices } });
}

describe.skipIf(!dbEnabled)(
  "#769 acceptance 4: a walking signup reaches walksDone on /setup",
  () => {
    beforeAll(() => {
      admin = createClient(DB_URL!, DB_SERVICE!, { auth: { persistSession: false } });
    });
    afterAll(async () => {
      for (const o of made) {
        await admin.from("organizations").delete().eq("id", o.orgId);
        await admin.auth.admin.deleteUser(o.userId);
      }
    });

    describe("a walker-only business", () => {
      let owner: Owner;

      beforeAll(async () => {
        owner = await signUp("769-walker", "dog_walking");
      });

      it("signup stores the walking line and seeds 30-, 60-minute walks and a drop-in, all unpriced", async () => {
        const org = await admin
          .from("organizations")
          .select("service_lines")
          .eq("id", owner.orgId)
          .single();
        expect(org.data?.service_lines).toEqual(["dog_walking"]);
        const ws = await walks(owner);
        expect(ws.map((w) => [w.default_duration_min, w.base_price_cents])).toEqual([
          [20, null],
          [30, null],
          [60, null],
        ]);
      });

      it("before any price is saved, the step asks for walk prices on /setup and is not done", async () => {
        const step = await setupStatus(owner);
        expect(step).toMatchObject({ label: "Price your walks", to: "/setup", done: false });
      });

      it("the form refuses only the 30, only the 60, or only the drop-in, and nothing is written", async () => {
        for (const typed of [{ 30: "25" }, { 60: "40" }, { 20: "15" }, { 30: "25", 20: "15" }]) {
          expect(await saveOnSetup(owner, typed), JSON.stringify(typed)).toMatch(/Enter what a/);
          expect((await walks(owner)).every((w) => w.base_price_cents === null)).toBe(true);
          expect((await setupStatus(owner)).done).toBe(false);
        }
      });

      it("a single price that does reach the database does not mark the step done either", async () => {
        // setSetupWalkPrices writes what it is sent; the form is what refuses a
        // partial save. So the persisted state is the proof: one price on one
        // walk, whichever one, is not "done".
        for (const min of [30, 60, 20]) {
          const w = byLength(await walks(owner), min);
          await writePrices(owner, [{ id: w.id, cents: 2500 }]);
          expect(byLength(await walks(owner), min).base_price_cents).toBe(2500);
          expect((await setupStatus(owner)).done, `only the ${min}`).toBe(false);
          await writePrices(owner, [{ id: w.id, cents: null }]);
        }
        expect((await walks(owner)).every((w) => w.base_price_cents === null)).toBe(true);
      });

      it("saving the 30 and the 60 on /setup, drop-in blank, finishes the step with no Settings detour", async () => {
        expect(await saveOnSetup(owner, { 30: "25", 60: "$40.50", 20: "" })).toBeNull();
        // The rows hold exactly the cents the save wrote; the drop-in stays
        // blank, and is never quoted.
        const ws = await walks(owner);
        expect(byLength(ws, 30).base_price_cents).toBe(2500);
        expect(byLength(ws, 60).base_price_cents).toBe(4050);
        expect(byLength(ws, 20).base_price_cents).toBeNull();
        const { walksPricedForSetup } = await import("@/lib/setup-walk-prices");
        expect(walksPricedForSetup(ws)).toBe(true);
        // Read back the way the server reads it: done, and still on /setup.
        const step = await setupStatus(owner);
        expect(step).toMatchObject({ label: "Price your walks", to: "/setup", done: true });
      });
    });

    describe("a business that scoops and walks", () => {
      let owner: Owner;

      beforeAll(async () => {
        owner = await signUp("769-scoop-walk");
        // Setup step 1: the owner ticks Dog walking beside pet waste.
        as(owner);
        const { setServiceLines } = await import("@/lib/org-features.functions");
        await (setServiceLines as unknown as Handler)({
          data: { lines: ["pet_waste", "dog_walking"] },
        });
      });

      it("gets the same three unpriced walks, and a walks part on /setup that is not done", async () => {
        const ws = await walks(owner);
        expect(ws.map((w) => [w.default_duration_min, w.base_price_cents])).toEqual([
          [20, null],
          [30, null],
          [60, null],
        ]);
        const step = await setupStatus(owner);
        expect(step.to).toBe("/setup");
        expect(step.parts?.find((p) => p.id === "walks")?.done).toBe(false);
      });

      it("only the 30 does not finish the walks part", async () => {
        expect(await saveOnSetup(owner, { 30: "25" })).toMatch(/Enter what a/);
        const w30 = byLength(await walks(owner), 30);
        await writePrices(owner, [{ id: w30.id, cents: 2500 }]);
        expect((await setupStatus(owner)).parts?.find((p) => p.id === "walks")?.done).toBe(false);
        await writePrices(owner, [{ id: w30.id, cents: null }]);
      });

      it("saving the 30 and the 60 on /setup finishes the walks part, and the step waits only on the rest", async () => {
        expect(await saveOnSetup(owner, { 30: "30", 60: "50" })).toBeNull();
        const ws = await walks(owner);
        expect(byLength(ws, 30).base_price_cents).toBe(3000);
        expect(byLength(ws, 60).base_price_cents).toBe(5000);
        expect(byLength(ws, 20).base_price_cents).toBeNull();
        const step = await setupStatus(owner);
        expect(step.to).toBe("/setup");
        const walksPart = step.parts?.find((p) => p.id === "walks");
        expect(walksPart?.done).toBe(true);
        // The step is done when every part is; the pet-waste area is its own
        // part and has not been set here.
        expect(step.done).toBe(step.parts!.every((p) => p.done));
      });
    });
  },
);
