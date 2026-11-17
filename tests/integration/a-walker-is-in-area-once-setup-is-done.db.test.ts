/** #958 acceptance 4, on a real database: "walker-only signup with prices,
 *  then a ZIP inside vs outside." And the same for a sitter, a groomer and a
 *  trainer, whose setup also had no area to ask for.
 *
 *  public_quote (newest body 20261024100900, spliced since) answers only for
 *  a ZIP some zone lists, and with no zone it says nothing: the public
 *  booking link reads that as `branch.reason === "no-zone"`, out of area.
 *  Setup asked a pet-waste business for its area and nobody else, so a
 *  walker could finish setup, price every walk, share the link, and be out
 *  of area to every client. Product lock (#958 acceptance 5): the zone check
 *  stays. The fix is that setup makes the zone.
 *
 *  The chain, against the local stack the CI database job builds from every
 *  migration (the Census ZIP centers included):
 *
 *    signup      bootstrapOrganization, the real server function, as a
 *                brand-new signed-in user; the line is set as the service
 *                role, the way a platform switch would leave it.
 *    prices      for the walker, the real setSetupWalkPrices, as /setup.
 *    area        the payload /setup's service-area form builds
 *                (setupServiceAreaZone) sent to the real createZone under the
 *                owner's RLS, which lists the ZIPs inside the circle.
 *    "done"      the real loadOnboardingStatus.
 *    the quote   public.public_quote as anon, inside and outside the area.
 *
 *  Fixture data only: a made-up business per line, a Lansing, MI ZIP as the
 *  middle of the area and a Beverly Hills one as the far-away ZIP. Each
 *  business is a labelled TEST org made here and deleted after.
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

type Handler = (opts?: unknown) => Promise<unknown>;

const password = "area-setup-password-123!";

/** The middle of the area: ZIP 48933's Census center (reference.zip_centroids,
 *  20261001120100). */
const INSIDE_ZIP = "48933";
const CENTER = { lat: 42.7294, lng: -84.5562 };
/** Two thousand miles away. */
const OUTSIDE_ZIP = "90210";

type Owner = { userId: string; client: SupabaseClient; orgId: string; slug: string };
type Part = { id: string; done: boolean };
type Step = { id: string; label: string; done: boolean; to: string; parts?: Part[] };
type QuoteRow = { zone_id: string | null; base_price_cents: number | null };

let admin: SupabaseClient;
let anon: SupabaseClient;
const made: Owner[] = [];

function as(owner: Owner) {
  caller.supabase = owner.client;
  caller.userId = owner.userId;
}

/** A brand-new person signs up, and runs `line` alone. */
async function signUp(line: string): Promise<Owner> {
  const runId = Math.random().toString(36).slice(2, 10);
  const email = `958-${line}-${runId}@areasetup.local`;
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
      orgName: `TEST 958 ${line} ${runId}`,
      displayName: "Test Owner",
      timezone: "UTC",
      ...(line === "dog_walking" ? { serviceLine: line } : {}),
    },
  })) as { organizationId: string };
  const orgId = r.organizationId;
  const slug = `test-958-${line.replace(/_/g, "-")}-${runId}`;
  // The line, and a public booking link: as the service role, the way a
  // platform switch and Settings, Signup & quote form would leave them.
  const { error: upd } = await admin
    .from("organizations")
    .update({ service_lines: [line], public_signup_enabled: true, portal_slug: slug })
    .eq("id", orgId);
  if (upd) throw new Error(upd.message);
  const owner = { userId, client, orgId, slug };
  made.push(owner);
  return owner;
}

async function priceStep(owner: Owner): Promise<Step> {
  as(owner);
  const { loadOnboardingStatus } = await import("@/lib/onboarding.functions");
  const status = (await (loadOnboardingStatus as unknown as Handler)({
    supabase: owner.client,
    userId: owner.userId,
  })) as { steps: Step[] };
  const step = status.steps.find((s) => s.id === "zones");
  expect(step, "the price step").toBeTruthy();
  return step!;
}

const areaPart = (step: Step) => step.parts?.find((p) => p.id === "area");

/** /setup's service-area Save, as ServiceAreaOnlyForm sends it. */
async function saveArea(owner: Owner): Promise<string> {
  const { setupServiceAreaZone } = await import("@/lib/setup-service-area");
  as(owner);
  const { createZone } = await import("@/lib/zones.functions");
  const zone = (await (createZone as unknown as Handler)({
    data: setupServiceAreaZone({ name: "Main service area", center: CENTER, miles: 10 }),
  })) as { id: string };
  return zone.id;
}

/** What the public booking link asks, as a stranger. */
async function quote(owner: Owner, zip: string, serviceId?: string): Promise<QuoteRow[]> {
  const { data, error } = await anon.rpc("public_quote", {
    _slug: owner.slug,
    _postal_code: zip,
    _dog_count: 1,
    _frequency: "weekly",
    ...(serviceId ? { _service_id: serviceId } : {}),
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as QuoteRow[];
}

describe.skipIf(!dbEnabled)(
  "#958: a business that finishes setup is in area inside its area",
  () => {
    beforeAll(() => {
      admin = createClient(DB_URL!, DB_SERVICE!, { auth: { persistSession: false } });
      anon = createClient(DB_URL!, DB_ANON!, { auth: { persistSession: false } });
    });
    afterAll(async () => {
      for (const o of made) {
        await admin.from("organizations").delete().eq("id", o.orgId);
        await admin.auth.admin.deleteUser(o.userId);
      }
    });

    describe("a walker-only business, with prices", () => {
      let owner: Owner;
      let walk30: string;

      beforeAll(async () => {
        owner = await signUp("dog_walking");
        const { data } = await admin
          .from("services")
          .select("id, default_duration_min")
          .eq("organization_id", owner.orgId)
          .eq("service_line", "dog_walking")
          .eq("active", true);
        const ws = (data ?? []) as Array<{ id: string; default_duration_min: number }>;
        walk30 = ws.find((w) => w.default_duration_min === 30)!.id;
        const walk60 = ws.find((w) => w.default_duration_min === 60)!.id;
        as(owner);
        const { setSetupWalkPrices } = await import("@/lib/setup-walk-prices.functions");
        await (setSetupWalkPrices as unknown as Handler)({
          data: {
            prices: [
              { id: walk30, cents: 2500 },
              { id: walk60, cents: 4000 },
            ],
          },
        });
      });

      it("with its walks priced and no area, setup's price step is not finished", async () => {
        const step = await priceStep(owner);
        expect(step.parts?.map((p) => [p.id, p.done])).toEqual([
          ["area", false],
          ["walks", true],
        ]);
        expect(step.done).toBe(false);
      });

      it("and that is the business the bug left behind: out of area everywhere", async () => {
        expect(await quote(owner, INSIDE_ZIP, walk30)).toEqual([]);
      });

      it("saving the area finishes the step, and lists the ZIP at its middle", async () => {
        const zoneId = await saveArea(owner);
        const { data: zone } = await admin
          .from("zones")
          .select("zip_codes, base_price_cents, per_dog_addl_cents")
          .eq("id", zoneId)
          .single();
        expect(zone?.zip_codes).toContain(INSIDE_ZIP);
        expect(zone?.zip_codes).not.toContain(OUTSIDE_ZIP);
        // No price of its own: a walk is priced by the walk.
        expect(zone?.base_price_cents).toBeNull();
        const step = await priceStep(owner);
        expect(areaPart(step)?.done).toBe(true);
        expect(step.done).toBe(true);
      });

      it("the booking link quotes the priced walk inside the area", async () => {
        const rows = await quote(owner, INSIDE_ZIP, walk30);
        expect(rows).toHaveLength(1);
        expect(rows[0].zone_id).toBeTruthy();
        expect(rows[0].base_price_cents).toBe(2500);
      });

      it("and gives the out-of-area answer outside it", async () => {
        expect(await quote(owner, OUTSIDE_ZIP, walk30)).toEqual([]);
      });
    });

    // A stay, a groom and a lesson are taken as requests, not priced here
    // (decideFormBranch), and their lines are not sold to strangers yet; the
    // zone check public_quote makes for them is the one with no service named.
    for (const line of ["pet_sitting", "mobile_grooming", "training"]) {
      describe(`a ${line}-only business`, () => {
        let owner: Owner;

        beforeAll(async () => {
          owner = await signUp(line);
        });

        it("is asked for a service area, and the step waits for it", async () => {
          const step = await priceStep(owner);
          expect(step.to).toBe("/setup");
          expect(step.parts?.[0]).toMatchObject({ id: "area", done: false });
          expect(step.done).toBe(false);
          expect(await quote(owner, INSIDE_ZIP)).toEqual([]);
        });

        it("once the area is saved, a ZIP inside it is in area and one outside is not", async () => {
          await saveArea(owner);
          expect(areaPart(await priceStep(owner))?.done).toBe(true);
          const inside = await quote(owner, INSIDE_ZIP);
          expect(inside).toHaveLength(1);
          expect(inside[0].zone_id).toBeTruthy();
          expect(await quote(owner, OUTSIDE_ZIP)).toEqual([]);
        });
      });
    }
  },
);
