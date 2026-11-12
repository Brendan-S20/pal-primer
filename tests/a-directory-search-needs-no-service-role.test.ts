// A directory search needs no service role (#630; the standalone
// mypets.services app, approved 2026-11-11).
//
// This file:
//   * pins 20261112020000: the zone "outside" filter runs inside
//     directory_search; directory_public_listings is a read-only view granted
//     to anon with exactly the public fields; the base tables, the verdict and
//     the org-id functions stay shut to anon;
//   * pins searchDirectory: no service role, one anon RPC;
//   * pins the quote paths: /api/public/leads stays CORS `*` for tenant
//     websites; /api/public/directory/quotes answers only the directory app's
//     origins, takes directory quotes only, and a directory quote's location
//     is a clean five-digit ZIP or refused -- checked by calling the handlers;
//   * runs tests/sql/a-directory-search-needs-no-service-role.proof.sql
//     against a real database when one answers (skipped, loudly, when none
//     does). CI's database job runs the same proof through supabase/proofs/.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DIRECTORY_APP_ORIGINS,
  directoryQuoteCors,
  isDirectoryAppOrigin,
} from "@/lib/directory-quote-cors";
import type { DirectoryProfile, DirectoryService } from "@/lib/directory";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const STAMP = "20261112020000";
const MIGRATION = join(
  ROOT,
  `supabase/migrations/${STAMP}_a-directory-search-needs-no-service-role.sql`,
);
const PROOF = join(ROOT, "tests/sql/a-directory-search-needs-no-service-role.proof.sql");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
const sql = () => codeOnly(readFileSync(MIGRATION, "utf8"));

/** The public listing, field for field, as DirectoryProfile and
 *  DirectoryService in lib/directory.ts declare it. Typed so that a field
 *  added to either type without a decision here fails to compile. */
const PROFILE_FIELDS = [
  "slug",
  "display_name",
  "logo_url",
  "bio",
  "service_lines",
  "coverage_zips",
  "coverage_cities",
  "services",
  "published_at",
] as const satisfies ReadonlyArray<keyof DirectoryProfile>;
const SERVICE_FIELDS = [
  "label",
  "service_line",
  "price_from_cents",
  "price_unit",
] as const satisfies ReadonlyArray<keyof DirectoryService>;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _profileFieldsAreExact: Exact<(typeof PROFILE_FIELDS)[number], keyof DirectoryProfile> = true;
const _serviceFieldsAreExact: Exact<(typeof SERVICE_FIELDS)[number], keyof DirectoryService> = true;
void _profileFieldsAreExact;
void _serviceFieldsAreExact;

/** Words that name something a visitor must never be handed. */
const NEVER = [
  "organization_id",
  "confirmed_by",
  "confirmed_at",
  "email",
  "phone",
  "address",
  "street",
  "stripe",
  "client",
  "dog",
  "show_logo",
  "published\\b(?!_at)",
];

describe("the migration", () => {
  it("is file-only, after every migration on main and the ones open PRs hold", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    const stamps = readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, 14))
      .sort();
    expect(stamps.at(-1)).toBe(STAMP);
    // #888 holds 20261111150000, #870 20261111151000, #905 20261112010000.
    expect(STAMP > "20261112010000").toBe(true);
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/PROPOSED MIGRATION\. File only/);
    expect(read(`supabase/proofs/${STAMP}-a-directory-search-needs-no-service-role.sql`)).toMatch(
      /\\ir \.\.\/\.\.\/tests\/sql\/a-directory-search-needs-no-service-role\.proof\.sql/,
    );
  });

  it("drops a business whose current zones say outside, inside directory_search", () => {
    const body = sql().split("FUNCTION public.directory_search(")[1].split("$fn$;")[0];
    expect(body).toMatch(/public\.directory_zone_verdict\(p\.organization_id, _zip\) <> 'outside'/);
    expect(body).toMatch(/WHERE p\.published/);
    expect(body).toMatch(/o\.deleted_at IS NULL/);
    // Same public shape as before: it still returns what directory_public_rows returns.
    expect(body).toMatch(/SELECT r\.\*\s+FROM public\.directory_public_rows\(/);
  });

  it("keeps an unknown verdict listed: only 'outside' is a reason to drop", () => {
    const verdict = sql().split("FUNCTION public.directory_zone_verdict(")[1].split("$fn$;")[0];
    // Every failure path reads as unknown, never outside.
    expect(verdict).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RETURN 'unknown';/);
    expect(verdict).toMatch(/IF NOT _any THEN\s+RETURN 'unknown';/);
    expect(verdict).toMatch(/RETURN CASE WHEN _unsure THEN 'unknown' ELSE 'outside' END;/);
    // A zone that is turned off serves nobody (#449), as in the TypeScript.
    expect(verdict.match(/COALESCE\(zn\.enabled, true\)/g)?.length).toBe(2);
  });

  it("keeps the verdict and the org-id functions server-only, and the search a visitor's", () => {
    const s = sql();
    expect(s).toMatch(
      /REVOKE ALL ON FUNCTION public\.directory_zone_verdict\(uuid, text\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(s).not.toMatch(
      /GRANT [^;]*ON FUNCTION public\.directory_zone_verdict[^;]*TO [^;]*\b(anon|authenticated)\b/,
    );
    for (const fn of ["directory_org_for_quote", "directory_public_rows"]) {
      expect(s).not.toMatch(new RegExp(`GRANT [^;]*ON FUNCTION public\\.${fn}[^;]*TO [^;]*anon`));
    }
    expect(s).toMatch(/GRANT EXECUTE ON FUNCTION public\.directory_search\(text, text\) TO anon/);
  });

  it("grants anon SELECT on the view only, never on a base table", () => {
    const s = sql();
    expect(s).toMatch(/GRANT SELECT ON public\.directory_public_listings TO anon, authenticated;/);
    expect(s).toMatch(
      /REVOKE ALL ON public\.directory_public_listings FROM PUBLIC, anon, authenticated;/,
    );
    for (const t of [
      "directory_profiles",
      "directory_profile_services",
      "directory_reviews",
      "organizations",
    ]) {
      expect(s, t).not.toMatch(new RegExp(`GRANT [^;]*ON (TABLE )?public\\.${t}\\b[^;]*TO`));
    }
    // Nothing but SELECT is granted on the view.
    expect(s).not.toMatch(
      /GRANT (INSERT|UPDATE|DELETE|ALL|TRUNCATE)[^;]*directory_public_listings/,
    );
  });

  it("defines the view with exactly the public fields and nothing else", () => {
    const view = sql().split("CREATE VIEW public.directory_public_listings")[1].split(";")[0];
    const select = view
      .split(/\bAS\s+SELECT\b/)[1]
      .split(/\n\s+FROM public\.directory_profiles p\b/)[0];
    // Top-level select items, split on commas outside parentheses; each is
    // named by its AS alias, or is a bare `p.column`.
    const items: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of select) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        items.push(cur);
        cur = "";
      } else cur += ch;
    }
    items.push(cur);
    const top = items.map((it) => {
      const t = it.trim();
      return /\bAS ([a-z_]+)$/.exec(t)?.[1] ?? /^[a-z]+\.([a-z_]+)$/.exec(t)?.[1] ?? `?${t}`;
    });
    expect(top).toEqual([...PROFILE_FIELDS]);
    const svc = [...select.matchAll(/'([a-z_]+)', s\.[a-z_]+/g)].map((m) => m[1]);
    expect(svc).toEqual([...SERVICE_FIELDS]);
    // Two private columns are READ, never returned: the logo shows only when
    // the owner chose to show it, and services join on the business. Pinned
    // exactly, then taken out before looking for anything private.
    const JOIN =
      /FROM public\.directory_profile_services s\s+WHERE s\.organization_id = p\.organization_id/;
    const LOGO = "CASE WHEN p.show_logo THEN o.logo_url END AS logo_url";
    expect(select).toMatch(JOIN);
    expect(select).toContain(LOGO);
    const returned = select.replace(JOIN, "").replace(LOGO, "o.logo_url AS logo_url");
    for (const w of NEVER) expect(returned, w).not.toMatch(new RegExp(`\\b${w}`, "i"));
    // Published profiles of live businesses only.
    expect(view).toMatch(/WHERE p\.published\s+AND o\.deleted_at IS NULL/);
    // It reads the tables itself rather than calling the service-role-only
    // reader, whose EXECUTE would be checked against the visitor.
    expect(view).not.toMatch(/directory_public_rows|directory_org_for_quote/);
  });

  it("asserts what it establishes, from any starting state", () => {
    const s = sql();
    expect(s).toMatch(/RAISE EXCEPTION 'anon holds % on a directory table'/);
    expect(s).toMatch(/RAISE EXCEPTION 'directory_public_listings has columns %'/);
    expect(s).toMatch(
      /RAISE EXCEPTION 'directory_search does not drop a business whose zones say outside'/,
    );
  });

  it("touches no flag, no table it does not own, and no row", () => {
    const s = sql();
    expect(s).not.toMatch(/DIRECTORY_LIVE|PUBLIC_SITES_INDEXABLE/);
    expect(s).not.toMatch(/\b(INSERT INTO|UPDATE public\.|DELETE FROM|ALTER TABLE)\b/i);
  });
});

describe("searchDirectory", () => {
  const src = () => read("src/lib/directory.functions.ts");
  const search = () =>
    src().split("export const searchDirectory")[1].split("export const getDirectoryProfiles")[0];

  it("uses no service role for the zone filter, or for anything", () => {
    expect(search()).not.toMatch(
      /supabaseAdmin|client\.server|service_role|directory_org_for_quote|leadServiceAreas/,
    );
    expect(search()).toMatch(/visitorDb\(\)\.rpc\("directory_search"/);
    // Nothing visitor-facing in the file reaches for it either.
    expect(src()).not.toMatch(/supabaseAdmin/);
  });
});

describe("the quote paths", () => {
  it("leave the tenant lead path at CORS *", () => {
    const leads = read("src/routes/api/public/leads.ts");
    expect(leads).toMatch(/"Access-Control-Allow-Origin": "\*"/);
    expect(leads).toMatch(
      /POST: async \(\{ request \}\) => handlePublicLeadPost\(request, \{ cors: CORS \}\)/,
    );
  });

  it("answer the directory app's origins only on the directory alias, echoing rather than *", () => {
    for (const o of [
      ...DIRECTORY_APP_ORIGINS,
      "https://mypets-git-main-brendan.vercel.app",
      "https://mypets-4k2j9x-team.vercel.app",
    ]) {
      expect(isDirectoryAppOrigin(o), o).toBe(true);
      expect(directoryQuoteCors(o)["Access-Control-Allow-Origin"]).toBe(o);
      expect(directoryQuoteCors(o).Vary).toBe("Origin");
    }
    for (const o of [
      null,
      "",
      "*",
      "http://mypets.services",
      "https://mypets.services.evil.test",
      "https://evil-mypets.services",
      "https://mypets.vercel.app.evil.test",
      "https://mypets-x.vercel.app/",
      "https://a.b.mypets-x.vercel.app",
      "https://tenant-site.example",
      "https://app.houndstack.com",
    ]) {
      expect(isDirectoryAppOrigin(o), String(o)).toBe(false);
      expect(directoryQuoteCors(o)).not.toHaveProperty("Access-Control-Allow-Origin");
    }
  });

  it("delegate to the same handler, so the guards are the same code", () => {
    const alias = read("src/routes/api/public/directory/quotes.ts");
    expect(alias).toMatch(/createFileRoute\("\/api\/public\/directory\/quotes"\)/);
    expect(alias).toMatch(/handlePublicLeadPost\(request, \{ cors, directoryOnly: true \}\)/);
    expect(alias).not.toMatch(/supabase|\.insert\(|"\*"/);
    const leads = read("src/routes/api/public/leads.ts");
    const handler = leads.split("export async function handlePublicLeadPost")[1];
    // Honeypot and time check before anything is looked up; rate limit before the write.
    expect(handler.indexOf("screenSubmission(")).toBeLessThan(
      handler.indexOf("directory_org_for_quote"),
    );
    expect(handler.indexOf("takePublicFormTurn(")).toBeLessThan(handler.indexOf(".insert("));
    // A directory quote stores the cleaned ZIP, never the raw text.
    expect(handler).toMatch(
      /const directoryZip = data\.directory_slug \? cleanZip\(data\.location\) : null;/,
    );
    expect(handler).toMatch(
      /const location = fromDirectory \? directoryZip : data\.location \|\| null;/,
    );
  });

  // The handlers themselves, on the paths that end before any database call.
  const quote = (over: Record<string, unknown> = {}) => ({
    directory_slug: "e2e-directory-yard",
    name: "Probe",
    email: "probe@example.test",
    location: "48201",
    source: "directory",
    website_url: "",
    elapsed_ms: 5_000,
    ...over,
  });
  const post = (url: string, body: unknown, origin?: string) =>
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    });
  type Handler = (ctx: { request: Request }) => Promise<Response>;
  type ServerRoute = {
    options: { server: { handlers: { OPTIONS: Handler; POST: Handler } } };
  };
  const aliasRoute = async () =>
    (await import("@/routes/api/public/directory/quotes")).Route as unknown as ServerRoute;
  const leadsRoute = async () =>
    (await import("@/routes/api/public/leads")).Route as unknown as ServerRoute;
  const ALIAS = "https://app.houndstack.com/api/public/directory/quotes";
  const LEADS = "https://app.houndstack.com/api/public/leads";

  it("answer a preflight from mypets.services, and refuse one from anywhere else", async () => {
    const { OPTIONS } = (await aliasRoute()).options.server.handlers;
    const ok = await OPTIONS({
      request: new Request(ALIAS, {
        method: "OPTIONS",
        headers: { Origin: "https://mypets.services" },
      }),
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://mypets.services");
    const no = await OPTIONS({
      request: new Request(ALIAS, {
        method: "OPTIONS",
        headers: { Origin: "https://tenant-site.example" },
      }),
    });
    expect(no.status).toBe(403);
    expect(no.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const tenant = await (
      await leadsRoute()
    ).options.server.handlers.OPTIONS({ request: new Request(LEADS, { method: "OPTIONS" }) });
    expect(tenant.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("refuse a browser post to the alias from another page before reading the body", async () => {
    const { POST } = (await aliasRoute()).options.server.handlers;
    const r = await POST({ request: post(ALIAS, quote(), "https://tenant-site.example") });
    expect(r.status).toBe(403);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("take directory quotes only on the alias", async () => {
    const { POST } = (await aliasRoute()).options.server.handlers;
    const { directory_slug: _d, ...tenantLead } = quote();
    const r = await POST({
      request: post(
        ALIAS,
        { ...tenantLead, slug: "some-tenant", source: "website" },
        "https://mypets.services",
      ),
    });
    expect(r.status).toBe(400);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("https://mypets.services");
  });

  it("refuse a directory quote whose ZIP is not five clean digits, on both paths", async () => {
    const alias = (await aliasRoute()).options.server.handlers.POST;
    const leads = (await leadsRoute()).options.server.handlers.POST;
    for (const location of ['"48201"', "%2248201%22", "4820%", "482011", "Detroit", ""]) {
      const a = await alias({
        request: post(ALIAS, quote({ location }), "https://mypets.services"),
      });
      expect(a.status, location).toBe(400);
      const l = await leads({ request: post(LEADS, quote({ location })) });
      expect(l.status, location).toBe(400);
      expect(await l.json()).toEqual({ error: "Enter a five-digit ZIP code." });
    }
  });

  it("still screen the honeypot and the time check before anything else", async () => {
    const alias = (await aliasRoute()).options.server.handlers.POST;
    const bot = await alias({
      request: post(ALIAS, quote({ website_url: "http://spam.test" }), "https://mypets.services"),
    });
    expect(bot.status).toBe(400);
    const fast = await alias({
      request: post(ALIAS, quote({ elapsed_ms: 200 }), "https://mypets.services"),
    });
    expect(fast.status).toBe(400);
  });
});

// ── The proof, in a real database ─────────────────────────────────────────
const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
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

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the a-directory-search-needs-no-service-role proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("a directory search needs no service role, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("drops outside in the database, leaks no field, keeps the tables shut, and both mutations reproduce", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED|PROOF INCONCLUSIVE/);
    expect(out).toMatch(/ALL ANON DIRECTORY PROOFS PASSED/);
  });
});
