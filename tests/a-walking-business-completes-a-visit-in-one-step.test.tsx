// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any -- a hand-built Supabase double */
//
// A new business's first office Complete took two dialogs (#915).
//
// ── WHAT HAPPENED ─────────────────────────────────────────────────────────
//
// Onboarding QA, 2026-11-12 and again 2026-11-16. A brand-new business, with
// no settings changed, added a client and a visit and clicked Mark completed
// on the client's Visits tab. "Mark this visit completed?" -> Mark completed,
// then a SECOND dialog, "Complete without the tech's proof?", with a required
// Why and Complete anyway. Read as a failed complete.
//
// The second dialog was the #658 gate doing its job: office_complete_visit
// refuses without a reason when the business requires a completion photo and
// the visit has none. What was wrong was who it applied to:
// organizations.require_completion_photo is `NOT NULL DEFAULT true`
// (20260928050000), so every new business required a photo, whatever it ran.
//
// ── THE SPEC (locked 2026-11-16, issue #915) ──────────────────────────────
//
//   1. ON for pet-waste businesses, existing ones included, no change for
//      anyone live. OFF for NEW businesses whose only services are walking,
//      sitting, grooming or training. Owners can still change it.
//   2. No photo required for that visit: an office Complete is ONE
//      confirmation. A photo required: the current flow.
//   3. No migration changes an existing org's setting. A new-org default by
//      segment at setup is fine.
//
// ── WHAT IS PINNED HERE ──────────────────────────────────────────────────
//
//   1. the rule by segment: scooper-only and mixed (with pet waste) ON;
//      walking / sitting / grooming / training only OFF;
//   2. a new business is moved to it at signup (?service=) and at setup
//      step 1, by the real bootstrapOrganization and setServiceLines;
//   3. an existing business is never moved: one that is set up, one with
//      visits, one whose owner already chose, Settings (no atSetup), a re-run
//      of bootstrap, and no migration touching the column;
//   4. office Complete, through the real server function and the real
//      dialog: rule off is one call and no second dialog; rule on is the
//      proof dialog, with a reason, as before;
//   5. My Day reads the same setting as before.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const ORG = "0a000000-0000-4000-8000-000000000915";
const VISIT = "11111111-1111-4111-8111-111111110915";
const PHOTO_REFUSAL =
  "This visit has no completion photo. Say why you are completing it from the office.";

type Org = {
  service_lines: string[];
  require_completion_photo: boolean;
  contact_address: string | null;
};

const h = vi.hoisted(() => ({
  org: null as unknown as Org,
  visitCount: 0,
  /** user_roles rows the caller already has: empty is a new signup. */
  memberships: [] as Array<{ organization_id: string }>,
  /** What startNewOrgOnRequestedLine stores (null: left the org alone). */
  requestedLineResult: null as string[] | null,
  orgUpdates: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<[string, Record<string, unknown> | undefined]>,
  activity: [] as Array<Record<string, unknown>>,
}));

const freshOrg = (): Org => ({
  // The column defaults: what bootstrap_organization creates.
  service_lines: ["pet_waste"],
  require_completion_photo: true,
  contact_address: null,
});

/** A Supabase client over one organization. Records and applies updates to
 *  it, and plays office_complete_visit by the SQL's rule (photo missing AND
 *  required AND no reason -> refuse). */
function db() {
  return {
    from(table: string) {
      const q: any = {};
      let patch: Record<string, unknown> | null = null;
      for (const m of ["select", "in", "not", "order", "limit", "is", "ilike", "gt"])
        q[m] = () => q;
      q.eq = () => {
        if (patch && table === "organizations" && !h.orgUpdates.includes(patch)) {
          h.orgUpdates.push(patch);
          Object.assign(h.org, patch);
        }
        return q;
      };
      q.update = (p: Record<string, unknown>) => ((patch = p), q);
      q.insert = async () => ({ error: null });
      const one = () =>
        table === "organizations"
          ? { ...h.org }
          : table === "visits"
            ? {
                id: VISIT,
                organization_id: ORG,
                client_id: "c1",
                property_id: null,
                scheduled_on: "2000-01-01",
                status: "scheduled",
                updated_at: null,
              }
            : null;
      q.single = async () => ({ data: one(), error: null });
      q.maybeSingle = async () => ({ data: one(), error: null });
      q.then = (res: any, rej: any) => {
        const data =
          table === "user_roles"
            ? h.memberships
            : table === "visits"
              ? Array.from({ length: h.visitCount }, (_, i) => ({ id: `v${i}` }))
              : patch
                ? [{ id: ORG }]
                : [];
        return Promise.resolve({ data, error: null }).then(res, rej);
      };
      return q;
    },
    async rpc(name: string, args?: Record<string, unknown>) {
      h.rpcCalls.push([name, args]);
      if (name === "bootstrap_organization") return { data: ORG, error: null };
      if (name === "office_complete_visit") {
        const why = String(args?._override_reason ?? "").trim();
        if (h.org.require_completion_photo && !why)
          return { data: null, error: { message: PHOTO_REFUSAL } };
      }
      return { data: null, error: null };
    },
    auth: {
      admin: { getUserById: async () => ({ data: { user: { email: "new@example.com" } } }) },
    },
  };
}

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (f: unknown) => f,
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (fn: (a: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({ data: validate(args?.data), context: { supabase: db(), userId: "owner-1" } }),
    };
    return b;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => null }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return db();
  },
}));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: ORG, role: "owner" }),
  requirePermission: async () => ({ orgId: ORG, role: "owner" }),
  accessTurnedOff: async () => null,
}));
vi.mock("@/lib/signup-codes.server", () => ({
  lookupSignupCode: async () => ({ kind: "invalid" }),
}));
vi.mock("@/lib/signup-marker", () => ({ clearSignupMarker: async () => {} }));
vi.mock("@/lib/signup-contact.server", () => ({
  applySignupEmail: async () => {},
  applySignupPhone: async () => {},
}));
vi.mock("@/lib/org-features.functions", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    // What the real one does to the row, without its seeding.
    startNewOrgOnRequestedLine: async () => {
      if (h.requestedLineResult) h.org.service_lines = [...h.requestedLineResult];
      return h.requestedLineResult;
    },
  };
});
vi.mock("@/lib/service-line-availability.server", () => ({
  loadServiceLineAvailability: async () => ({
    bookable: ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "training"],
    customerRequestable: [],
  }),
}));
vi.mock("@/lib/training-package-seed.server", () => ({
  seedTrainingPackage: async () => {},
  seedTrainingSkills: async () => {},
}));
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
  afterStopResolved: async () => {},
}));
vi.mock("@/lib/push-liveactivity.server", () => ({
  watchRouteLiveActivities: async () => async () => {},
}));
vi.mock("@/lib/completion-block.server", () => ({ completionBlockWarning: async () => null }));
vi.mock("@/lib/activity.server", () => ({
  logActivity: async (_db: unknown, entry: Record<string, unknown>) => {
    h.activity.push(entry);
  },
}));
vi.mock("@/lib/training-portal.server", () => ({ afterLessonSessionChange: async () => {} }));
vi.mock("@/lib/visit-completion-invoice.server", () => ({
  invoiceAtCompletionSafely: async () => {},
}));

const { newBusinessRequiresCompletionPhoto } = await import("@/lib/new-business-defaults");
const { bootstrapOrganization } = await import("@/lib/org.functions");
const { setServiceLines } = await import("@/lib/org-features.functions");
const { completeVisitFromOffice } = await import("@/lib/visits.functions");
const { completeFromOffice, useOfficeCompleteOverride } =
  await import("@/components/OfficeCompleteOverride");

beforeEach(() => {
  h.org = freshOrg();
  h.visitCount = 0;
  h.memberships = [];
  h.requestedLineResult = null;
  h.orgUpdates = [];
  h.rpcCalls = [];
  h.activity = [];
});

const photoWrites = () => h.orgUpdates.filter((p) => "require_completion_photo" in p);

// ── 1. The rule ──────────────────────────────────────────────────────────
describe("1. a new business requires a completion photo by what it runs", () => {
  it.each([
    [["pet_waste"]],
    [["pet_waste", "dog_walking"]],
    [["pet_waste", "pet_sitting", "mobile_grooming", "training"]],
    [["dog_walking", "pet_waste"]],
  ])("ON for a scooper, alone or mixed: %j", (lines) => {
    expect(newBusinessRequiresCompletionPhoto(lines)).toBe(true);
  });

  it.each([
    [["dog_walking"]],
    [["pet_sitting"]],
    [["mobile_grooming"]],
    [["training"]],
    [["dog_walking", "pet_sitting", "mobile_grooming", "training"]],
  ])("OFF when it only walks, sits, grooms or trains: %j", (lines) => {
    expect(newBusinessRequiresCompletionPhoto(lines)).toBe(false);
  });

  it("ON for an answer that says nothing it knows (the column default)", () => {
    expect(newBusinessRequiresCompletionPhoto([])).toBe(true);
    expect(newBusinessRequiresCompletionPhoto(["other"])).toBe(true);
  });
});

// ── 2. A new business is moved to it ─────────────────────────────────────
const signup = (serviceLine?: string) =>
  (bootstrapOrganization as any)({
    data: { orgName: "Northside Pets", displayName: "Owner", serviceLine },
  });
const setupStep1 = (lines: string[]) =>
  (setServiceLines as any)({ data: { lines, atSetup: true } });
const settingsSave = (lines: string[]) => (setServiceLines as any)({ data: { lines } });

describe("2. a new business starts with its segment's default", () => {
  it("a signup with no service named is a scooper until it says otherwise: ON", async () => {
    await signup();
    expect(photoWrites()).toEqual([]);
    expect(h.org.require_completion_photo).toBe(true);
  });

  it.each(["dog_walking", "pet_sitting", "mobile_grooming", "training"])(
    "a signup that came for %s starts OFF",
    async (line) => {
      h.requestedLineResult = [line];
      const r = await signup(line);
      expect(r.organizationId).toBe(ORG);
      expect(h.org.require_completion_photo).toBe(false);
    },
  );

  it("a signup whose requested line was not applied stays ON", async () => {
    h.requestedLineResult = null;
    await signup("dog_walking");
    expect(photoWrites()).toEqual([]);
    expect(h.org.require_completion_photo).toBe(true);
  });

  it.each([[["dog_walking"]], [["pet_sitting"]], [["mobile_grooming"]], [["training"]]])(
    "setup step 1, only %j ticked: OFF",
    async (lines) => {
      await setupStep1(lines);
      expect(h.org.service_lines).toEqual(lines);
      expect(h.org.require_completion_photo).toBe(false);
    },
  );

  it("setup step 1, walking and sitting: OFF", async () => {
    await setupStep1(["dog_walking", "pet_sitting"]);
    expect(h.org.require_completion_photo).toBe(false);
  });

  it("setup step 1, scooping only or scooping with walking: ON, nothing written", async () => {
    await setupStep1(["pet_waste"]);
    await setupStep1(["pet_waste", "dog_walking"]);
    expect(photoWrites()).toEqual([]);
    expect(h.org.require_completion_photo).toBe(true);
  });

  it("a walker who then ticks pet waste in setup goes back ON", async () => {
    await setupStep1(["dog_walking"]);
    expect(h.org.require_completion_photo).toBe(false);
    await setupStep1(["dog_walking", "pet_waste"]);
    expect(h.org.require_completion_photo).toBe(true);
  });

  it("setup sends atSetup only while step 1 is not done; Settings never sends it", () => {
    const setup = codeOnly(read("src/routes/_authenticated/setup.tsx"));
    expect(setup).toMatch(
      /saveLinesFn\(\{ data: \{ lines: linesVal, atSetup: !alreadyDone \} \}\)/,
    );
    const settings = codeOnly(read("src/routes/_authenticated/settings.business.tsx"));
    expect(settings).not.toMatch(/atSetup/);
  });
});

// ── 3. An existing business is never moved ───────────────────────────────
describe("3. no existing business changes", () => {
  it("a business that is set up (has an address) keeps ON when it drops pet waste", async () => {
    h.org.contact_address = "1 Main St, Detroit, MI";
    await setupStep1(["dog_walking"]);
    expect(photoWrites()).toEqual([]);
    expect(h.org.require_completion_photo).toBe(true);
  });

  it("a business with visits keeps ON, address or not", async () => {
    h.visitCount = 3;
    await setupStep1(["dog_walking"]);
    expect(photoWrites()).toEqual([]);
    expect(h.org.require_completion_photo).toBe(true);
  });

  it.each([
    [false, ["pet_waste"], ["dog_walking"]],
    [true, ["dog_walking"], ["pet_sitting"]],
    [true, ["dog_walking"], ["training", "mobile_grooming"]],
  ])(
    "an owner who already chose (%s while running %j) keeps it on ticking %j",
    async (chosen, running, ticked) => {
      h.org.require_completion_photo = chosen;
      h.org.service_lines = running;
      await setupStep1(ticked);
      expect(photoWrites()).toEqual([]);
      expect(h.org.require_completion_photo).toBe(chosen);
    },
  );

  it("a Settings save never moves it, even for a business with nothing set up", async () => {
    await settingsSave(["dog_walking"]);
    expect(h.org.service_lines).toEqual(["dog_walking"]);
    expect(photoWrites()).toEqual([]);
    expect(h.org.require_completion_photo).toBe(true);
  });

  it("a re-run of bootstrap for a business that exists writes nothing", async () => {
    h.memberships = [{ organization_id: ORG }];
    h.requestedLineResult = ["dog_walking"];
    await signup("dog_walking");
    expect(photoWrites()).toEqual([]);
  });

  it("no migration changes the column's default or writes it onto existing rows", () => {
    const dir = join(ROOT, "supabase/migrations");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) =>
        /require_completion_photo\s+SET\s+DEFAULT|SET\s+require_completion_photo\s*=/i.test(
          readFileSync(join(dir, f), "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
    const added = read("supabase/migrations/20260928050000_a-tech-could-not-leave-a-note.sql");
    expect(added).toMatch(/require_completion_photo boolean NOT NULL DEFAULT true/);
  });
});

// ── 4. The office's Complete, through the real dialog ────────────────────
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let api: ReturnType<typeof useOfficeCompleteOverride> | null = null;

function Harness() {
  api = useOfficeCompleteOverride();
  return api.dialog;
}
const dialog = () => document.querySelector('[role="alertdialog"]');
async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}
function button(label: string) {
  return [...document.querySelectorAll("button")].find((x) => x.textContent === label) as
    | HTMLButtonElement
    | undefined;
}

/** One office Complete, as VisitsTab / VisitDetailDrawer / routes run it once
 *  the person has said yes to "Mark this visit completed?". */
const officeComplete = () =>
  completeFromOffice(
    (overrideReason) =>
      (completeVisitFromOffice as any)({ data: { visitId: VISIT, overrideReason } }),
    api!.askWhy,
  );
const officeCompletes = () => h.rpcCalls.filter((c) => c[0] === "office_complete_visit");

describe("4. completing a visit from the office", () => {
  beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(createElement(Harness));
    });
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("a new walking business: one call, no second dialog", async () => {
    h.requestedLineResult = ["dog_walking"];
    await signup("dog_walking");
    const done = officeComplete();
    await settle();
    await expect(done).resolves.toBe(true);
    expect(dialog(), "a second dialog opened with no photo required").toBeNull();
    expect(officeCompletes()).toHaveLength(1);
    expect(officeCompletes()[0][1]).toEqual({ _visit_id: VISIT });
    expect(h.activity[0]?.summary).toMatch(/completed from the office$/);
  });

  it("a scooper, photo required: the proof dialog, as before, and it says why", async () => {
    await signup();
    const done = officeComplete();
    await settle();
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Complete without the required proof?");
    expect(text).toContain("This visit has no completion photo.");
    expect(text).toContain("Your business requires this");
    expect(text).toContain("Settings → Business defaults");
    expect(button("Complete with this reason")?.disabled).toBe(true);
    expect(officeCompletes()).toHaveLength(1);

    const field = document.querySelector("textarea")!;
    const label = document.querySelector(`label[for="${field.id}"]`);
    expect(label?.textContent).toBe("Why is it missing?");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(field, "Client confirmed by phone");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Complete with this reason")?.disabled).toBe(false);
    await act(async () => button("Complete with this reason")!.click());
    await settle();
    await expect(done).resolves.toBe(true);
    expect(officeCompletes()).toHaveLength(2);
    expect(officeCompletes()[1][1]).toEqual({
      _visit_id: VISIT,
      _override_reason: "Client confirmed by phone",
    });
    expect(h.activity[0]?.summary).toContain("without its photo or checklist");
  });

  it("photo required, Cancel leaves the visit open", async () => {
    const done = officeComplete();
    await settle();
    await act(async () => button("Cancel")!.click());
    await settle();
    await expect(done).resolves.toBe(false);
    expect(officeCompletes()).toHaveLength(1);
    expect(h.activity).toEqual([]);
  });

  it("office_complete_visit still asks only when the business requires the photo", () => {
    const dir = join(ROOT, "supabase/migrations");
    const all = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    const at = all.lastIndexOf("CREATE OR REPLACE FUNCTION public.office_complete_visit(");
    const fn = all.slice(at, all.indexOf("$function$;", at));
    expect(fn).toMatch(/COALESCE\(o\.require_completion_photo, true\)/);
    expect(fn).toMatch(/_photo_missing := _required AND NOT _has_photo;/);
    expect(fn).toMatch(/IF \(_photo_missing OR _missing IS NOT NULL\) AND _why IS NULL THEN/);
  });

  it("the client Visits tab asks once before it completes", () => {
    const tab = codeOnly(read("src/components/client-detail/VisitsTab.tsx"));
    const click = tab.slice(tab.indexOf('title: "Mark this visit completed?"') - 600);
    const body = click.slice(0, click.indexOf("completeMut.mutate(early)"));
    expect(body.match(/await confirm\(/g)).toHaveLength(1);
  });
});

// ── 5. The tech's side ───────────────────────────────────────────────────
describe("5. My Day reads the same setting it did", () => {
  it("and asks for a photo exactly when the business requires one", () => {
    const myDay = codeOnly(read("src/routes/_authenticated/my-day.tsx"));
    expect(myDay).toMatch(
      /const \{ requireCompletionPhoto, checklist: orgChecklist \} = useOrgFieldRules\(\)/,
    );
    expect(myDay).toMatch(
      /photoOnFile \|\| !requireCompletionPhoto \|\| noPhotoReason\.trim\(\)\.length >= 3/,
    );
  });
});
