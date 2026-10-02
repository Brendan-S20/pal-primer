// An owner could not see the portal.
//
// "Open portal" on a client opened the customer's link, which asks for a
// one-time code sent to the CUSTOMER. The owner landed on somebody else's
// sign-in screen, and the only way past was to reveal an office-read code
// and sign in as the customer with every button live.
//
// "Preview portal" mints a session on the owner's own browser, marked with
// who opened it, an hour long, and read-only in the server. The property
// that matters is the direction of the default: requirePortalSession
// REFUSES a preview unless the caller says it only reads. This file runs
// that function for real against a fake session table, then pins which
// handlers are allowed to say so.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ── requirePortalSession, run for real ──────────────────────────────────────

const TOKEN = "11111111-1111-4111-8111-111111111111";
const state: {
  cookie: string | null;
  session: Record<string, unknown> | null;
  cookiesSet: Array<{ name: string; maxAge: number }>;
  inserted: Array<Record<string, unknown>>;
} = { cookie: null, session: null, cookiesSet: [], inserted: [] };

vi.mock("@tanstack/react-start/server", () => ({
  getCookie: () => state.cookie,
  setCookie: (name: string, _v: string, o: { maxAge: number }) =>
    state.cookiesSet.push({ name, maxAge: o.maxAge }),
  getRequestHeader: () => "vitest",
  getRequestIP: () => "127.0.0.1",
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain = (table: string) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      update: () => q,
      insert: (row: Record<string, unknown>) => {
        state.inserted.push({ table, ...row });
        return Promise.resolve({ error: null });
      },
      maybeSingle: () => {
        if (table === "clients")
          return Promise.resolve({
            data: {
              id: "client-1",
              organization_id: "org-1",
              display_name: "Pat",
              primary_phone: null,
              primary_email: null,
              active: true,
              portal_token: TOKEN,
              organizations: { name: "Org", portal_slug: "org", timezone: "America/Chicago" },
            },
            error: null,
          });
        if (table === "portal_sessions")
          return Promise.resolve({ data: state.session, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (res: (v: unknown) => void) => res({ error: null }),
    };
    return q;
  };
  return { supabaseAdmin: { from: chain } };
});

function session(previewBy: string | null) {
  return {
    id: "s1",
    client_id: "client-1",
    organization_id: "org-1",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    revoked_at: null,
    preview_by: previewBy,
  };
}

describe("a preview session", () => {
  beforeEach(() => {
    state.cookie = "secret";
    state.session = null;
    state.cookiesSet = [];
    state.inserted = [];
  });

  it("is refused for an action that did not say it only reads", async () => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    state.session = session("staff-user-1");
    await expect(requirePortalSession(TOKEN)).rejects.toThrow(/preview/i);
    await expect(requirePortalSession(TOKEN, { readOnly: false })).rejects.toThrow(/preview/i);
  });

  it("is allowed to read, and says it is a preview", async () => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    state.session = session("staff-user-1");
    await expect(requirePortalSession(TOKEN, { readOnly: true })).resolves.toMatchObject({
      clientId: "client-1",
      preview: true,
    });
  });

  it("changes nothing for the customer's own session", async () => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    state.session = session(null);
    await expect(requirePortalSession(TOKEN)).resolves.toMatchObject({ preview: false });
    await expect(requirePortalSession(TOKEN, { readOnly: true })).resolves.toMatchObject({
      preview: false,
    });
  });

  it("is minted marked with who opened it, and lasts an hour, not thirty days", async () => {
    const { startPortalPreview } = await import("@/lib/portal-auth.server");
    await startPortalPreview("client-1", "staff-user-1");
    const row = state.inserted.find((r) => r.table === "portal_sessions")!;
    expect(row.preview_by).toBe("staff-user-1");
    const ttl = (new Date(String(row.expires_at)).getTime() - Date.now()) / 60_000;
    expect(ttl).toBeGreaterThan(55);
    expect(ttl).toBeLessThanOrEqual(60);
    expect(state.cookiesSet[0].maxAge).toBe(3600);
  });
});

// ── Which handlers may say they only read ───────────────────────────────────

const ROOT = join(import.meta.dirname, "..");

function* walk(dir: string): Generator<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(f)) yield p;
  }
}

/** Every server function in src/ that asks for a portal session. */
function portalHandlers() {
  const out: Array<{ file: string; name: string; method: string; body: string }> = [];
  for (const file of walk(join(ROOT, "src"))) {
    if (file.endsWith("portal-auth.server.ts")) continue;
    const src = readFileSync(file, "utf8");
    if (!src.includes("requirePortalSession(")) continue;
    const parts = src.split(/\nexport const /).slice(1);
    for (const part of parts) {
      const m = /^(\w+) = createServerFn\(\{ method: "(GET|POST)" \}\)/.exec(part);
      if (!m || !part.includes("requirePortalSession(")) continue;
      out.push({ file: file.slice(ROOT.length + 1), name: m[1], method: m[2], body: part });
    }
  }
  return out;
}

/** POST handlers that only read. Each one here was checked by hand: it
 *  signs photo URLs and writes nothing. Adding a name is a decision that
 *  the owner's preview may call it. */
const POSTS_THAT_ONLY_READ = ["portalSignPhotoUrls"];

describe("the handlers that may run in a preview", () => {
  const all = portalHandlers();

  it("are found at all", () => {
    expect(all.length).toBeGreaterThan(30);
    expect(all.filter((h) => h.method === "POST").length).toBeGreaterThan(15);
  });

  for (const h of all) {
    const readOnly = /requirePortalSession\([^)]*readOnly:\s*true/.test(h.body);
    if (h.method === "POST" && !POSTS_THAT_ONLY_READ.includes(h.name)) {
      it(`${h.name} (${h.file}) refuses a preview`, () => {
        expect(
          readOnly,
          `${h.name} is a POST that passes readOnly: true. A staff preview could run it ` +
            `as the customer. If it genuinely writes nothing, add it to POSTS_THAT_ONLY_READ.`,
        ).toBe(false);
      });
    } else {
      it(`${h.name} (${h.file}) lets a preview read`, () => {
        expect(readOnly, `${h.name} only reads but does not say so; the preview breaks.`).toBe(
          true,
        );
      });
    }
  }

  it("includes the ones a preview must never reach", () => {
    const refused = all.filter((h) => !/readOnly:\s*true/.test(h.body)).map((h) => h.name);
    for (const name of [
      "portalPayInvoiceWithSavedCard",
      "portalSetAutopay",
      "portalRemoveCard",
      "portalRequestSkip",
      "portalRescheduleVisit",
      "portalCreateInvoicePaymentIntent",
      "portalSetSmsConsent",
    ]) {
      expect(refused, name).toContain(name);
    }
  });
});

// ── The staff side ──────────────────────────────────────────────────────────

describe("opening a preview", () => {
  const fns = readFileSync(join(ROOT, "src/lib/clients.functions.ts"), "utf8");
  const body = fns
    .slice(fns.indexOf("export const previewClientPortal"))
    .split("\nexport const")[0];

  it("is for the people who handle the client's money, in their own organization", () => {
    expect(body).toMatch(/requirePermission\([\s\S]*?"manage_client_billing"/);
    expect(body).toMatch(/\.eq\("organization_id", orgId\)/);
  });

  it("is written to the client's Activity before the session exists", () => {
    const audit = body.indexOf('kind: "portal.previewed"');
    const mint = body.indexOf("startPortalPreview(");
    expect(audit).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(audit);
    expect(body).toMatch(/if \(auditErr\) throw/);
  });

  it("is labelled in the portal, so a refused tap is not a mystery", () => {
    const shell = readFileSync(join(ROOT, "src/routes/portal.$slug.$token.tsx"), "utf8");
    expect(shell).toMatch(/ctx\.preview &&/);
    const ctx = readFileSync(join(ROOT, "src/lib/portal.functions.ts"), "utf8");
    expect(ctx).toMatch(/preview: session\.preview/);
  });

  it("adds a column no existing session can pick up", () => {
    const sql = readFileSync(
      join(ROOT, "supabase/migrations/20260929150000_an-owner-could-not-see-the-portal.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS preview_by uuid;/);
    expect(sql).not.toMatch(/preview_by uuid[^;]*DEFAULT/);
    expect(sql).not.toMatch(/UPDATE public\.portal_sessions/);
  });
});
