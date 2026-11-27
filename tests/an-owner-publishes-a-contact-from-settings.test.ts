// Settings → Directory: an owner publishes a contact email and phone (#1002;
// columns from #990, mypets #18).
//
//  - the two validators: blank is null, a US number or E.164 is stored as
//    E.164, anything else is refused (and matches the database CHECKs);
//  - the real Save handler: a contact is written to its two columns only,
//    for the caller's own org, clearing writes null, omitting leaves it
//    alone, an invalid one is refused before anything is written;
//  - a save that changes only the contact on a live listing revalidates mypets;
//  - the form is wired to both fields and says the contact is public.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

vi.setConfig({ testTimeout: 300_000 });

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
const role = vi.hoisted(() => ({ value: "owner" }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "10020000-0000-4000-8000-0000000000aa", role: role.value }),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return h.admin;
  },
}));

const ORG = "10020000-0000-4000-8000-0000000000aa";
const SERVICE = "10020000-0000-4000-8000-0000000000b1";
const h = vi.hoisted(() => ({ admin: null as unknown }));

type Row = Record<string, unknown>;
function fakeDb(
  tables: Record<string, Row | null>,
  opts: {
    failUpdate?: string;
    failRpc?: string;
    rpcCode?: string;
    contactReadCode?: string;
  } = {},
) {
  const calls: Array<{ kind: string; name: string; args?: unknown; eq?: unknown[] }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a query-builder stand-in
  const chain = (table: string): any => {
    let last: { kind: string; name: string; args?: unknown; eq?: unknown[] } | null = null;
    let columns = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a query-builder stand-in
    const c: any = {
      select: (s: string) => ((columns = s), c),
      eq: (...a: unknown[]) => (last?.eq ? last.eq.push(a) : void 0, c),
      update: (v: unknown) => {
        last = { kind: "update", name: table, args: v, eq: [] };
        calls.push(last);
        return c;
      },
      maybeSingle: async () =>
        opts.contactReadCode && columns === "public_email, public_phone"
          ? { data: null, error: { message: "x", code: opts.contactReadCode } }
          : { data: tables[table] ?? null, error: null },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve({
          data: null,
          error: last && opts.failUpdate === table ? { message: "x", code: "XX000" } : null,
        }).then(ok, bad),
    };
    return c;
  };
  return {
    calls,
    from: (t: string) => chain(t),
    rpc: async (name: string, args: unknown) => {
      calls.push({ kind: "rpc", name, args });
      return {
        data: null,
        error: opts.failRpc === name ? { message: "x", code: opts.rpcCode ?? "XX000" } : null,
      };
    },
  };
}

import { normalizePublicEmail, normalizePublicPhone } from "@/lib/directory";
import { saveMyDirectoryProfile as saveFn } from "@/lib/directory.functions";
import { resetMypetsRevalidateWarningForTests } from "@/lib/mypets-revalidate.server";

type Handler = (opts: { data: unknown; context: unknown }) => Promise<unknown>;
const saveMyDirectoryProfile = saveFn as unknown as Handler;

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
beforeEach(() => {
  role.value = "owner";
  resetMypetsRevalidateWarningForTests();
  vi.stubEnv("MYPETS_REVALIDATE_SECRET", "test-secret-1002");
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function save(extra: Row, wasPublished = true, stored: Row = {}) {
  h.admin = fakeDb({ org_texting_registrations: null });
  const sb = fakeDb({
    directory_profiles: { slug: "acme-scoop", published: wasPublished, ...stored },
  });
  const admin = h.admin as ReturnType<typeof fakeDb>;
  const r = await saveMyDirectoryProfile({
    data: { ...PROFILE, ...extra },
    context: { supabase: sb, userId: "u" },
  });
  return { r, sb, admin };
}
const contactWrites = (db: ReturnType<typeof fakeDb>) =>
  db.calls.filter((c) => c.kind === "rpc" && c.name === "set_directory_public_contact");

describe("the contact validators", () => {
  it("email: blank is null, a plain address is kept, a bad one is refused", () => {
    expect(normalizePublicEmail("")).toBeNull();
    expect(normalizePublicEmail("   ")).toBeNull();
    expect(normalizePublicEmail(null)).toBeNull();
    expect(normalizePublicEmail("  hello@acme-scoop.com ")).toBe("hello@acme-scoop.com");
    for (const bad of [
      "nope",
      "a@b",
      "a b@c.com",
      "a@@c.com",
      "a@c..com",
      "a@.com",
      `${"a".repeat(250)}@b.co`,
    ]) {
      expect(normalizePublicEmail(bad), bad).toBeUndefined();
    }
  });
  it("phone: blank is null, US and E.164 become E.164, the rest is refused", () => {
    expect(normalizePublicPhone("")).toBeNull();
    expect(normalizePublicPhone("(313) 555-0142")).toBe("+13135550142");
    expect(normalizePublicPhone("313.555.0142")).toBe("+13135550142");
    expect(normalizePublicPhone("1 313 555 0142")).toBe("+13135550142");
    expect(normalizePublicPhone("+13135550142")).toBe("+13135550142");
    expect(normalizePublicPhone("+44 20 7946 0958")).toBe("+442079460958");
    for (const bad of [
      "555-0142",
      "013 555 0142",
      "1235550142",
      "+0123456789",
      "+123",
      "abc",
      "313-555-0142 ext 5",
      "+1 (313) 555-0142 x",
    ]) {
      expect(normalizePublicPhone(bad), bad).toBeUndefined();
    }
  });
  it("only returns what the database CHECK accepts", () => {
    for (const p of ["(313) 555-0142", "+44 20 7946 0958"]) {
      expect(normalizePublicPhone(p)).toMatch(/^\+[1-9][0-9]{7,14}$/);
    }
  });
});

describe("a Directory save with a contact", () => {
  it("writes the two columns, for the caller's own org, and nothing else", async () => {
    const { r, sb } = await save({
      publicEmail: " Hello@Acme.com ",
      publicPhone: "(313) 555-0142",
    });
    expect(r).toEqual({ ok: true });
    const w = contactWrites(sb);
    expect(w).toHaveLength(1);
    expect(w[0].args).toEqual({
      _org: ORG,
      _email: "Hello@Acme.com",
      _phone: "+13135550142",
      _change_email: true,
      _change_phone: true,
    });
    // Through the caller's own client, never the service role.
    expect(sb.calls.filter((c) => c.kind === "update")).toHaveLength(0);
  });

  it("clearing a stored field sets it to null", async () => {
    const { sb } = await save({ publicEmail: "", publicPhone: null }, true, {
      public_email: "old@acme.com",
      public_phone: "+13135550100",
    });
    expect(contactWrites(sb)[0].args).toMatchObject({
      _email: null,
      _phone: null,
      _change_email: true,
      _change_phone: true,
    });
  });

  it("leaves the contact alone when the caller sends neither", async () => {
    const { r, sb } = await save({});
    expect(r).toEqual({ ok: true });
    expect(contactWrites(sb)).toHaveLength(0);
  });

  it("one field sent changes only that column", async () => {
    const { sb } = await save({ publicPhone: "+13135550142" });
    expect(contactWrites(sb)[0].args).toMatchObject({
      _phone: "+13135550142",
      _change_email: false,
      _change_phone: true,
    });
  });

  it("refuses a bad email or phone before anything is written", async () => {
    for (const extra of [{ publicEmail: "not-an-email" }, { publicPhone: "12345" }]) {
      h.admin = fakeDb({ org_texting_registrations: null });
      const sb = fakeDb({ directory_profiles: null });
      await expect(async () =>
        saveMyDirectoryProfile({
          data: { ...PROFILE, ...extra },
          context: { supabase: sb, userId: "u" },
        }),
      ).rejects.toThrow(/Enter an email|Enter a US number/);
      expect(sb.calls).toEqual([]);
    }
  });

  it("is refused for anyone but the owner, with no write", async () => {
    role.value = "admin";
    h.admin = fakeDb({});
    const sb = fakeDb({});
    await expect(
      saveMyDirectoryProfile({
        data: { ...PROFILE, publicEmail: "a@b.co" },
        context: { supabase: sb, userId: "u" },
      }),
    ).rejects.toThrow();
    expect(sb.calls).toEqual([]);
  });

  it("revalidates mypets when a live listing changes only its contact", async () => {
    await save({ publicEmail: "hello@acme.com" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      event: "update",
      slug: "acme-scoop",
    });
  });

  it("still revalidates, and says so, when the contact write fails", async () => {
    h.admin = fakeDb({ org_texting_registrations: null });
    const sb = fakeDb(
      { directory_profiles: { slug: "acme-scoop", published: true } },
      { failRpc: "set_directory_public_contact" },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      saveMyDirectoryProfile({
        data: { ...PROFILE, publicEmail: "hello@acme.com" },
        context: { supabase: sb, userId: "u" },
      }),
    ).rejects.toThrow(/public contact can't be saved/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// The app can go live before the migration does: the writer is then missing
// (PGRST202), and the columns may be too (42703).
describe("a save on a database without the contact writer", () => {
  const WRITER = "set_directory_public_contact";
  async function saveBefore(extra: Row, opts: { stored?: Row; contactReadCode?: string } = {}) {
    h.admin = fakeDb({ org_texting_registrations: null });
    const sb = fakeDb(
      { directory_profiles: { slug: "acme-scoop", published: false, ...opts.stored } },
      { failRpc: WRITER, rpcCode: "PGRST202", contactReadCode: opts.contactReadCode },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await saveMyDirectoryProfile({
      data: { ...PROFILE, ...extra },
      context: { supabase: sb, userId: "u" },
    }).then(
      (r) => ({ ok: r, message: "" }),
      (e: Error) => ({ ok: null, message: e.message }),
    );
    return { ...result, sb };
  }
  const BLANK = { publicEmail: null, publicPhone: null };

  for (const published of [false, true]) {
    const button = published ? "Save and publish" : "Save, not listed";
    it(`${button} with both fields blank succeeds and calls no contact writer`, async () => {
      for (const contactReadCode of [undefined, "42703", "PGRST204"]) {
        const { ok, sb } = await saveBefore({ ...BLANK, published }, { contactReadCode });
        expect(ok, contactReadCode).toEqual({ ok: true });
        expect(contactWrites(sb)).toHaveLength(0);
      }
    });
  }

  it("Save and publish with a typed contact says the listing is live and what to do", async () => {
    const { message } = await saveBefore({
      publicEmail: "hello@acme.com",
      publicPhone: null,
      published: true,
    });
    expect(message).toBe(
      "Your profile is live in the directory. The public contact can't be saved yet: leave both fields empty, or try again later.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Save, not listed with a typed contact does not claim the listing is live", async () => {
    const { message } = await saveBefore({
      publicEmail: null,
      publicPhone: "+13135550142",
      published: false,
    });
    expect(message).toMatch(/^Your profile was saved\. The public contact can't be saved yet/);
  });

  it("never drops a clear: a stored value, or an unreadable one, still goes to the writer", async () => {
    for (const opts of [
      { stored: { public_email: "old@acme.com" } },
      { contactReadCode: "XX000" },
    ]) {
      const { sb, message } = await saveBefore({ ...BLANK, published: false }, opts);
      expect(contactWrites(sb)).toHaveLength(1);
      expect(message).toMatch(/can't be saved yet: try again later\./);
    }
  });

  it("an unchanged stored contact is not written again", async () => {
    const { ok, sb } = await saveBefore(
      { publicEmail: "a@b.co", publicPhone: null, published: true },
      { stored: { public_email: "a@b.co", public_phone: null } },
    );
    expect(ok).toEqual({ ok: true });
    expect(contactWrites(sb)).toHaveLength(0);
  });
});

describe("the Settings form", () => {
  const src = readFileSync(
    join(__dirname, "../src/routes/_authenticated/settings.directory.tsx"),
    "utf8",
  );
  it("has both fields, empty by default, and says they are public", () => {
    expect(src).toMatch(/id="dir-public-email"/);
    expect(src).toMatch(/id="dir-public-phone"/);
    expect(src).toMatch(
      /useState\(""\);\s*\n\s*const \[publicPhone, setPublicPhone\] = useState\(""\)/,
    );
    expect(src).toMatch(
      /shown publicly\s+on your \{DIRECTORY_BRAND\} page and on its Privacy and Terms pages/,
    );
  });
  it("sends blank as null, and blocks Save on an invalid value", () => {
    expect(src).toMatch(/publicEmail: publicEmail\.trim\(\) \|\| null/);
    expect(src).toMatch(/publicPhone: publicPhone\.trim\(\) \|\| null/);
    expect(src).toMatch(/emailProblem \|\| phoneProblem/);
  });
});

// ── The PROPOSED migration (applied to no live database; Helm decides) ──────
const ROOT = join(__dirname, "..");
const NAME = "a-directory-owner-publishes-a-contact";
const VERSION = "20261124130000";
const MIGRATION = join(ROOT, `supabase/migrations/${VERSION}_${NAME}.sql`);
// Spelled out: scripts/run-sql-proofs.mjs reads this path from the source text.
const PROOF = join(ROOT, "tests/sql/a-directory-owner-publishes-a-contact.proof.sql");
const PREREQ = join(
  ROOT,
  "supabase/migrations/20261118010000_a-directory-profile-can-publish-a-contact.sql",
);

describe("the proposed set_directory_public_contact migration, as a file", () => {
  const sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, "utf8") : "";
  it("has migration, rollback, proof and CI wrapper, sorted after every other", () => {
    for (const f of [
      MIGRATION,
      join(ROOT, `supabase/rollback/${VERSION}_${NAME}.down.sql`),
      PROOF,
      join(ROOT, `supabase/proofs/${VERSION}-${NAME}.sql`),
    ]) {
      expect(existsSync(f), f).toBe(true);
    }
    const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith(VERSION))).toEqual([`${VERSION}_${NAME}.sql`]);
    expect([...files].sort().at(-1)).toBe(`${VERSION}_${NAME}.sql`);
  });
  it("adds one owner-checked function, closed to anon, and changes nothing else", () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/has_role\(auth\.uid\(\), _org, 'owner'/);
    expect(sql).toMatch(/FROM PUBLIC, anon;/);
    expect(sql).toMatch(/TO authenticated, service_role;/);
    expect(sql).not.toMatch(/^(BEGIN|COMMIT);/m);
    expect(sql).not.toMatch(/ALTER TABLE|CREATE POLICY|DROP |GRANT (UPDATE|INSERT|ALL)/i);
  });
});

const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
  ]) {
    if (spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0) return p;
  }
  return null;
}
const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";
if (!reachable)
  console.warn(`\n  SKIPPED: the ${NAME} proof did NOT run (no database at ${DB_URL}).\n`);

describe.skipIf(!reachable)(
  "the proposed migration, in a real database (a scratch transaction)",
  () => {
    it("owner sets and clears; staff, another business and signed-out are refused", () => {
      const r = spawnSync(
        psql!,
        [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-v", `prereq=${PREREQ}`, "-f", PROOF],
        {
          encoding: "utf8",
          timeout: 300_000,
        },
      );
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, out).toBe(0);
      expect(out).not.toMatch(/PROOF FAILED/);
      expect((out.match(/ok:/g) ?? []).length).toBe(4);
    });
  },
);
