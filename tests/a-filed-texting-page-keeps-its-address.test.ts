// #969 review, must-fix 1: once a texting registration files the business's
// hosted page, Settings > Directory keeps that page's address and keeps it
// listed. The filed Website, Privacy and Terms, and the links inside every
// stored client consent, are that listing's /{slug}, /{slug}/privacy and
// /{slug}/terms; a new slug or an unpublish would turn all of them into 404s.
//
// Pinned here: the rule (which statuses lock, what is refused), the server
// (the real save handler refuses before any write, and fails closed when the
// registration cannot be read), and the screen (the address is read-only,
// the switch is held, and the reason is said). TEST businesses only.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a builder stand-in
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (fn: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown; context?: unknown } = {}) =>
          fn({ data: validate(opts.data), context: opts.context ?? {} }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: ORG, role: "owner" }),
  requirePermission: async () => ({ orgId: ORG, role: "owner" }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return h.admin;
  },
}));
vi.mock("@/lib/mypets-revalidate.server", () => ({
  revalidateEventForSave: () => null,
  revalidateMypetsListing: async () => {},
}));

const ORG = "96900000-0000-4000-8000-0000000000aa";
const SLUG = "qa-test-969";
const h = vi.hoisted(() => ({ admin: null as unknown }));

type Row = Record<string, unknown>;

/** Answers `.maybeSingle()` by table, records rpcs. `failRead` makes the
 *  registration read come back with an error. */
function fakeDb(tables: Record<string, Row | null>, opts: { failRead?: boolean } = {}) {
  const rpcs: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a query-builder stand-in
  const chain = (table: string): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a query-builder stand-in
    const c: any = {
      select: () => c,
      eq: () => c,
      update: () => c,
      maybeSingle: async () =>
        opts.failRead && table === "org_texting_registrations"
          ? { data: null, error: { message: "boom" } }
          : { data: tables[table] ?? null, error: null },
      then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(ok),
    };
    return c;
  };
  return {
    rpcs,
    from: (table: string) => chain(table),
    rpc: async (name: string) => (rpcs.push(name), { data: null, error: null }),
  };
}

import {
  DIRECTORY_LOCKED_BY_TEXTING,
  directoryChangeRefusal,
  directoryLockFrom,
  hostedSiteUrls,
} from "@/lib/texting-hosted-site";
import { saveMyDirectoryProfile as saveFn } from "@/lib/directory.functions";

type Handler = (opts: { data: unknown; context: unknown }) => Promise<unknown>;
const saveMyDirectoryProfile = saveFn as unknown as Handler;

const SERVICE = "96900000-0000-4000-8000-0000000000b1";
const PROFILE = {
  slug: SLUG,
  displayName: "QA TEST 969 Walks",
  bio: null,
  showLogo: false,
  coverageZips: ["48236"],
  coverageCities: [],
  services: [{ serviceId: SERVICE, priceFromCents: 2400 }],
  published: true,
  tagline: null,
  highlights: [],
  areas: [],
};
const HOSTED = hostedSiteUrls(SLUG);

async function save(
  reg: Row | null,
  change: Partial<typeof PROFILE>,
  opts: { failRead?: boolean } = {},
) {
  h.admin = fakeDb({ org_texting_registrations: reg }, opts);
  const sb = fakeDb({ directory_profiles: { slug: SLUG, published: true } });
  const run = saveMyDirectoryProfile({
    data: { ...PROFILE, ...change },
    context: { supabase: sb, userId: "owner-qa-test-969" },
  });
  return { run, sb };
}

afterEach(() => {
  h.admin = null;
});

describe("which registrations lock the hosted page", () => {
  it("every status except rejected locks it; no registration does not", () => {
    for (const status of ["draft", "submitting", "submitted", "in_review", "approved", "failed"]) {
      expect(directoryLockFrom({ status, website_url: HOSTED.website_url }), status).toEqual({
        slug: SLUG,
      });
    }
    expect(directoryLockFrom({ status: "rejected", website_url: HOSTED.website_url })).toBeNull();
    expect(directoryLockFrom(null)).toBeNull();
  });

  it("an owner's own website never locks the directory", () => {
    expect(
      directoryLockFrom({ status: "approved", website_url: "https://qa-test-969.example" }),
    ).toBeNull();
  });

  it("refuses a new address and an unpublish, allows any other edit", () => {
    const lock = { slug: SLUG };
    expect(directoryChangeRefusal(lock, { slug: "qa-test-969-new", published: true })).toBe(
      DIRECTORY_LOCKED_BY_TEXTING,
    );
    expect(directoryChangeRefusal(lock, { slug: SLUG, published: false })).toBe(
      DIRECTORY_LOCKED_BY_TEXTING,
    );
    expect(directoryChangeRefusal(lock, { slug: SLUG, published: true })).toBeNull();
    expect(directoryChangeRefusal(null, { slug: "anything", published: false })).toBeNull();
    expect(DIRECTORY_LOCKED_BY_TEXTING).toMatch(/^Your texting registration uses this page/);
  });
});

describe("the server refuses, before any write", () => {
  const filed = { status: "in_review", website_url: HOSTED.website_url };

  it("a slug change while the hosted page is filed", async () => {
    const { run, sb } = await save(filed, { slug: "qa-test-969-new" });
    await expect(run).rejects.toThrow(DIRECTORY_LOCKED_BY_TEXTING);
    expect(sb.rpcs).not.toContain("set_directory_profile");
  });

  it("an unpublish while the hosted page is filed", async () => {
    const { run, sb } = await save(filed, { published: false });
    await expect(run).rejects.toThrow(DIRECTORY_LOCKED_BY_TEXTING);
    expect(sb.rpcs).not.toContain("set_directory_profile");
  });

  it("but saves any other edit, and everything once the filing was rejected", async () => {
    const edit = await save(filed, { tagline: "TEST listing, small-group walks" });
    await expect(edit.run).resolves.toEqual({ ok: true });
    expect(edit.sb.rpcs).toContain("set_directory_profile");
    const rejected = await save(
      { ...filed, status: "rejected" },
      { slug: "qa-test-969-new", published: false },
    );
    await expect(rejected.run).resolves.toEqual({ ok: true });
  });

  it("fails closed when the registration cannot be read", async () => {
    const { run, sb } = await save(null, { slug: "qa-test-969-new" }, { failRead: true });
    await expect(run).rejects.toThrow(/Could not check your texting registration/);
    expect(sb.rpcs).not.toContain("set_directory_profile");
  });
});

describe("Settings > Directory says so", () => {
  const page = readFileSync(
    join(import.meta.dirname, "..", "src/routes/_authenticated/settings.directory.tsx"),
    "utf8",
  );

  it("holds the address and the listing switch, and gives the reason", () => {
    expect(page).toContain("readOnly={!!lockedSlug}");
    expect(page).toContain("disabled={!canEdit || (!!lockedSlug && published)}");
    expect(page).toContain("{DIRECTORY_LOCKED_BY_TEXTING}");
    expect(page).toContain("Your texting registration uses this page.");
  });
});
