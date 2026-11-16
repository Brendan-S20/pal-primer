// A Directory listing change reaches mypets.services within 60 s (#939;
// Brendan-S20/mypets#15, mypets#16).
//
// mypets #16 added POST https://mypets.services/api/revalidate. This holds the
// HoundStack half to it: the real Save handler and the real moderation
// handler, driven with a fake Supabase client and a mocked fetch (no network):
//
//  - a save that publishes, unpublishes or edits a listed profile calls the
//    endpoint once, with the right event, the slug and the Bearer secret;
//  - approving or rejecting a photo calls it with "update" and the slug;
//  - an unset secret is no call, one warning, and a successful save;
//  - a failing or hanging endpoint is one retry, one warning, a successful save;
//  - the secret is read in one server-only file and never reaches client code;
//  - the public photo route is cached for 60 s or less.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./support/repo-paths";

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
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return h.admin;
  },
}));

const ORG = "93900000-0000-4000-8000-0000000000aa";
const PHOTO = "93900000-0000-4000-8000-000000000001";
const SECRET = "test-secret-939-do-not-ship";
const URL = "https://mypets.services/api/revalidate";

type Row = Record<string, unknown>;

/** A Supabase client that answers by table: `tables[name]` is the row a
 *  `.maybeSingle()` read returns; every write and rpc succeeds unless
 *  `failRpc` names it. */
function fakeDb(tables: Record<string, Row | null>, opts: { failRpc?: string } = {}) {
  const calls: Array<{ kind: string; name: string; args?: unknown }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a query-builder stand-in
  const chain = (table: string, kind: string): any => {
    const result = { data: kind === "delete" ? [{ path: `${ORG}/x.jpg` }] : null, error: null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a query-builder stand-in
    const c: any = {
      select: () => c,
      eq: () => c,
      update: (v: unknown) => (calls.push({ kind: "update", name: table, args: v }), c),
      delete: () => chain(table, "delete"),
      maybeSingle: async () => ({ data: tables[table] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(ok, bad),
    };
    return c;
  };
  return {
    calls,
    from: (table: string) => chain(table, "read"),
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: "rpc", name, args });
      if (name === "is_platform_admin") return { data: true, error: null };
      if (name === opts.failRpc) return { data: null, error: { message: "boom", code: "XX000" } };
      return { data: null, error: null };
    },
    storage: { from: () => ({ remove: async () => ({ error: null }) }) },
  };
}

const h = vi.hoisted(() => ({ admin: null as unknown }));

import { saveMyDirectoryProfile as saveFn } from "@/lib/directory.functions";
import {
  PUBLIC_PHOTO_MAX_AGE,
  moderateDirectoryPhoto as moderateFn,
  removeMyDirectoryPhoto as removeFn,
} from "@/lib/directory-photos.functions";
import {
  MYPETS_REVALIDATE_TIMEOUT_MS,
  resetMypetsRevalidateWarningForTests,
  revalidateMypetsListing,
} from "@/lib/mypets-revalidate.server";

/** The handler as the mocked createServerFn above returns it. */
type Handler = (opts: { data: unknown; context: unknown }) => Promise<unknown>;
const saveMyDirectoryProfile = saveFn as unknown as Handler;
const moderateDirectoryPhoto = moderateFn as unknown as Handler;
const removeMyDirectoryPhoto = removeFn as unknown as Handler;

const SERVICE = "93900000-0000-4000-8000-0000000000b1";
const PROFILE = {
  slug: "acme-scoop",
  displayName: "Acme",
  bio: null,
  showLogo: false,
  coverageZips: ["48201"],
  coverageCities: [],
  services: [{ serviceId: SERVICE, priceFromCents: 1500 }],
  published: true,
  tagline: null,
  highlights: [],
  areas: [],
};

let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetMypetsRevalidateWarningForTests();
  vi.stubEnv("MYPETS_REVALIDATE_SECRET", SECRET);
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  warn.mockRestore();
});

function sentBodies() {
  return fetchMock.mock.calls.map(([url, init]) => {
    const i = init as RequestInit;
    expect(url).toBe(URL);
    expect(i.method).toBe("POST");
    const headers = i.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(headers["Content-Type"]).toBe("application/json");
    return JSON.parse(String(i.body));
  });
}

async function save(before: Row | null, published: boolean, extra: Partial<typeof PROFILE> = {}) {
  const sb = fakeDb({ directory_profiles: before });
  const r = await saveMyDirectoryProfile({
    data: { ...PROFILE, ...extra, published },
    context: { supabase: sb, userId: "u" },
  });
  return { r, sb };
}

describe("a Directory listing save", () => {
  it("that publishes calls the endpoint once with publish and the slug", async () => {
    const { r, sb } = await save(null, true);
    expect(r).toEqual({ ok: true });
    expect(sb.calls.some((c) => c.name === "set_directory_profile")).toBe(true);
    expect(sentBodies()).toEqual([{ event: "publish", slug: "acme-scoop" }]);
  });

  it("that publishes a profile saved unlisted before is a publish too", async () => {
    await save({ slug: "acme-scoop", published: false }, true);
    expect(sentBodies()).toEqual([{ event: "publish", slug: "acme-scoop" }]);
  });

  it("that unpublishes calls it once with unpublish", async () => {
    await save({ slug: "acme-scoop", published: true }, false);
    expect(sentBodies()).toEqual([{ event: "unpublish", slug: "acme-scoop" }]);
  });

  it("that edits a listed profile (tagline, prices, areas) calls it once with update", async () => {
    await save({ slug: "acme-scoop", published: true }, true, {
      tagline: "Clean yards, weekly",
      services: [{ serviceId: SERVICE, priceFromCents: 1800 }],
    });
    expect(sentBodies()).toEqual([{ event: "update", slug: "acme-scoop" }]);
  });

  it("that moves a listed profile to a new address also expires the old one", async () => {
    await save({ slug: "old-name", published: true }, true, { slug: "acme-scoop" });
    expect(sentBodies()).toEqual([
      { event: "update", slug: "acme-scoop" },
      { event: "unpublish", slug: "old-name" },
    ]);
  });

  it("of an unlisted profile kept unlisted calls nothing: no visitor saw it", async () => {
    const { r } = await save({ slug: "acme-scoop", published: false }, false);
    expect(r).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("that fails in the database calls nothing", async () => {
    const sb = fakeDb({ directory_profiles: null }, { failRpc: "set_directory_profile" });
    await expect(
      saveMyDirectoryProfile({ data: PROFILE, context: { supabase: sb, userId: "u" } }),
    ).rejects.toThrow("boom");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still revalidates when the profile was written and Book online then failed", async () => {
    const sb = fakeDb({ directory_profiles: null }, { failRpc: "set_directory_booking" });
    await expect(
      saveMyDirectoryProfile({
        data: { ...PROFILE, bookOnline: false, bookingPolicyText: null },
        context: { supabase: sb, userId: "u" },
      }),
    ).rejects.toThrow("boom");
    expect(sentBodies()).toEqual([{ event: "publish", slug: "acme-scoop" }]);
  });
});

describe("photo moderation in /platform/directory-photos", () => {
  beforeEach(() => {
    h.admin = fakeDb({
      directory_profile_photos: { organization_id: ORG },
      directory_profiles: { slug: "acme-scoop" },
    });
  });

  for (const approve of [true, false]) {
    it(`${approve ? "approving" : "rejecting"} a photo calls the endpoint with update and the slug`, async () => {
      const sb = fakeDb({});
      const r = await moderateDirectoryPhoto({
        data: { id: PHOTO, approve },
        context: { supabase: sb, userId: "mod" },
      });
      expect(r).toEqual({ ok: true });
      expect(sb.calls.find((c) => c.name === "moderate_directory_photo")?.args).toEqual({
        _id: PHOTO,
        _approve: approve,
      });
      expect(sentBodies()).toEqual([{ event: "update", slug: "acme-scoop" }]);
    });
  }

  it("a moderation the database refused calls nothing", async () => {
    const sb = fakeDb({}, { failRpc: "moderate_directory_photo" });
    await expect(
      moderateDirectoryPhoto({
        data: { id: PHOTO, approve: true },
        context: { supabase: sb, userId: "mod" },
      }),
    ).rejects.toThrow("boom");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an owner removing a photo from a listed profile calls it with update", async () => {
    const sb = fakeDb({ directory_profiles: { slug: "acme-scoop", published: true } });
    await removeMyDirectoryPhoto({
      data: { id: PHOTO },
      context: { supabase: sb, userId: "u" },
    });
    expect(sentBodies()).toEqual([{ event: "update", slug: "acme-scoop" }]);
  });
});

describe("with MYPETS_REVALIDATE_SECRET unset", () => {
  it("a save makes no call, logs one warning without a secret, and succeeds", async () => {
    vi.stubEnv("MYPETS_REVALIDATE_SECRET", "");
    const { r } = await save(null, true);
    expect(r).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/MYPETS_REVALIDATE_SECRET is not set/);
  });

  it("moderation still succeeds with no call", async () => {
    vi.stubEnv("MYPETS_REVALIDATE_SECRET", "");
    h.admin = fakeDb({
      directory_profile_photos: { organization_id: ORG },
      directory_profiles: { slug: "acme-scoop" },
    });
    const r = await moderateDirectoryPhoto({
      data: { id: PHOTO, approve: false },
      context: { supabase: fakeDb({}), userId: "mod" },
    });
    expect(r).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a failing endpoint", () => {
  const noSecretLogged = () => {
    for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);
  };

  for (const [what, respond] of [
    ["a 500", async () => new Response("no", { status: 500 })],
    ["a 401", async () => new Response("no", { status: 401 })],
    [
      "a network error",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ] as const) {
    it(`(${what}) is retried once, then a warning, and the save succeeds`, async () => {
      fetchMock.mockImplementation(respond);
      const { r } = await save(null, true);
      expect(r).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/failed after a retry/);
      noSecretLogged();
    });
  }

  it("that succeeds on the retry logs nothing", async () => {
    fetchMock
      .mockImplementationOnce(async () => new Response("no", { status: 502 }))
      .mockImplementationOnce(async () => new Response("{}", { status: 200 }));
    const { r } = await save(null, true);
    expect(r).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("that hangs is aborted at the timeout, retried once, and the save succeeds", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_u: unknown, init: RequestInit) =>
        new Promise((_ok, bad) => {
          init.signal?.addEventListener("abort", () =>
            bad(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const done = save(null, true);
    await vi.advanceTimersByTimeAsync(MYPETS_REVALIDATE_TIMEOUT_MS * 2 + 10);
    const { r } = await done;
    expect(r).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0].join(" "))).toMatch(/timed out/);
    noSecretLogged();
  });

  it("bounds a Save: each attempt is a few seconds at most", () => {
    expect(MYPETS_REVALIDATE_TIMEOUT_MS).toBeLessThanOrEqual(3_000);
  });

  it("never rejects, whatever fetch does", async () => {
    fetchMock.mockImplementation(() => {
      throw new Error("sync throw");
    });
    await expect(revalidateMypetsListing("update", "acme-scoop")).resolves.toBe(false);
  });

  it("drops a slug mypets would refuse rather than sending a 400", async () => {
    await revalidateMypetsListing("update", "Not A Slug!");
    expect(sentBodies()).toEqual([{ event: "update" }]);
  });
});

// ── The secret stays on the server ───────────────────────────────────────────
const ROOT = join(import.meta.dirname, "..");
const HELPER = "src/lib/mypets-revalidate.server.ts";

function sourceFiles(dir = join(ROOT, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(e.name) ? [p] : [];
  });
}

describe("MYPETS_REVALIDATE_SECRET", () => {
  const files = sourceFiles().map((p) => ({
    rel: repoRelative(p, ROOT),
    src: readFileSync(p, "utf8"),
  }));

  it("is read in exactly one file, which is server-only", () => {
    expect(
      files.filter((f) => f.src.includes("MYPETS_REVALIDATE_SECRET")).map((f) => f.rel),
    ).toEqual([HELPER]);
    expect(readFileSync(join(ROOT, HELPER), "utf8")).toMatch(
      /process\.env\.MYPETS_REVALIDATE_SECRET/,
    );
  });

  it("is never given a name or a read that Vite would put in the browser bundle", () => {
    for (const f of files) {
      expect(f.src, f.rel).not.toMatch(
        /VITE_MYPETS|import\.meta\.env\.MYPETS|import\.meta\.env\[["']MYPETS/,
      );
    }
    for (const cfg of ["vite.config.ts"]) {
      expect(readFileSync(join(ROOT, cfg), "utf8")).not.toMatch(/MYPETS_REVALIDATE/);
    }
  });

  it("is loaded only by server code, and never statically from client-bundled files", () => {
    // A static import from a component, a page or a plain lib module would
    // put the helper in the client graph. Allowed: other .server files, API
    // routes, and a dynamic import inside a .functions.ts handler (which the
    // server-function compiler keeps on the server).
    const users = files.filter(
      (f) => f.src.includes("mypets-revalidate.server") && f.rel !== HELPER,
    );
    expect(users.length).toBeGreaterThan(0);
    for (const f of users) {
      const serverOnly = /\.server\.ts$/.test(f.rel) || f.rel.startsWith("src/routes/api/");
      if (serverOnly) continue;
      expect(f.rel, `${f.rel} uses mypets-revalidate.server`).toMatch(/\.functions\.ts$/);
      expect(f.src, `${f.rel} imports mypets-revalidate.server statically`).not.toMatch(
        /^import[^;]*from\s+["']@\/lib\/mypets-revalidate\.server["']/m,
      );
    }
  });

  it("is never logged: no console call in the helper passes it", () => {
    const src = readFileSync(join(ROOT, HELPER), "utf8");
    for (const m of src.matchAll(/console\.\w+\(([^;]*)\);/g)) {
      const args = m[1].replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "");
      expect(args, m[0]).not.toMatch(/secret|authorization|headers|body/i);
    }
  });

  it("is documented in .env.example with no value", () => {
    expect(readFileSync(join(ROOT, ".env.example"), "utf8")).toMatch(
      /^MYPETS_REVALIDATE_SECRET=$/m,
    );
  });
});

describe("the public photo route", () => {
  it("is cached for 60 seconds or less, browser and CDN alike", () => {
    expect(PUBLIC_PHOTO_MAX_AGE).toBeLessThanOrEqual(60);
    const src = readFileSync(join(ROOT, "src/lib/directory-photos.functions.ts"), "utf8");
    const serve = src.split("export async function servePublicDirectoryPhoto")[1];
    const cc = serve.match(/"Cache-Control": `([^`]*)`/)![1];
    expect(cc).toBe("public, max-age=${PUBLIC_PHOTO_MAX_AGE}, s-maxage=${PUBLIC_PHOTO_MAX_AGE}");
    expect(serve).not.toMatch(/stale-while-revalidate|immutable/);
  });
});

describe("the Save button in Settings → Directory", () => {
  it("refetches the listing after an error too, so a profile that was written reads as written", () => {
    // The profile, published flag included, is written before Book online.
    // When the second write failed, the page used to keep the old answer and
    // say "Not listed" over a live listing, and the owner saved again.
    const page = readFileSync(
      join(ROOT, "src/routes/_authenticated/settings.directory.tsx"),
      "utf8",
    );
    const save = page.split("const save = useMutation(")[1].split("});")[0];
    expect(save).toMatch(
      /onSettled: \(\) => qc\.invalidateQueries\(\{ queryKey: \["my-directory-profile"\] \}\)/,
    );
    expect(save.split("onSuccess")[1].split("onError")[0]).not.toMatch(/invalidateQueries/);
  });
});
