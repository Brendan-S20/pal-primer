// A directory profile says what a business is, and where (#630; mypets v2
// step 5a: tagline, highlights and business areas).
//
// This file:
//   * pins 20261112090000: additive only (no DROP of a column, table, view or
//     the nine-argument writer); the new table has RLS, two-step sign-in,
//     owner-only write policies, no anon grant and the subset guard; both
//     writers ask for an owner and neither is anon's;
//   * pins the CONTRACT: directory_public_listings' columns, the keys of a
//     listed service and of an area, the proof's expected keys, and
//     PUBLIC_LISTING_FIELDS / PUBLIC_SERVICE_FIELDS / PUBLIC_AREA_FIELDS in
//     lib/directory.ts are one list, and toDirectoryListings drops anything
//     else whatever the view returns;
//   * pins the form's validation to the database's limits;
//   * runs tests/sql/a-directory-profile-says-what-a-business-is-and-where.proof.sql
//     against a real database when one answers (skipped, loudly, when none
//     does). CI's database job runs the same proof through supabase/proofs/.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DIRECTORY_AREAS_MAX,
  DIRECTORY_AREA_NAME_MAX,
  DIRECTORY_HIGHLIGHTS_MAX,
  DIRECTORY_HIGHLIGHT_MAX,
  DIRECTORY_TAGLINE_MAX,
  PUBLIC_AREA_FIELDS,
  PUBLIC_LISTING_FIELDS,
  PUBLIC_SERVICE_FIELDS,
  cleanHighlights,
  directoryContentProblems,
  type DirectoryArea,
  type DirectoryListing,
} from "@/lib/directory";
import { directoryProfileSchema, toDirectoryListings } from "@/lib/directory.functions";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const STAMP = "20261112090000";
const NAME = "a-directory-profile-says-what-a-business-is-and-where";
const MIGRATION = join(ROOT, `supabase/migrations/${STAMP}_${NAME}.sql`);
const PROOF = join(
  ROOT,
  "tests/sql/a-directory-profile-says-what-a-business-is-and-where.proof.sql",
);
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
const sql = () => codeOnly(readFileSync(MIGRATION, "utf8"));

// Exact both ways: a key added to the type without a decision in the
// allowlist fails to compile, and so does an allowlist entry the type lacks.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _listing: Exact<(typeof PUBLIC_LISTING_FIELDS)[number], keyof DirectoryListing> = true;
const _area: Exact<(typeof PUBLIC_AREA_FIELDS)[number], keyof DirectoryArea> = true;
void _listing;
void _area;

/** Top-level SELECT items of a view, by alias or bare `p.column`. */
function viewColumns(view: string): string[] {
  const select = view
    .split(/\bAS\s+SELECT\b/)[1]
    .split(/\n\s+FROM public\.directory_profiles p\b/)[0];
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
  return items.map((it) => {
    const t = it.trim();
    return /\bAS ([a-z_]+)$/.exec(t)?.[1] ?? /^[a-z]+\.([a-z_]+)$/.exec(t)?.[1] ?? `?${t}`;
  });
}

describe("the migration", () => {
  it("is timestamped after every other migration and every open PR's, with a proof beside it", () => {
    const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith(STAMP))).toEqual([`${STAMP}_${NAME}.sql`]);
    // #910 holds 20261112060000 and #912 20261112080000.
    expect(STAMP > "20261112080000").toBe(true);
    expect(readFileSync(MIGRATION, "utf8")).toMatch(/PROPOSED MIGRATION\. File only/);
    expect(read(`supabase/proofs/${STAMP}-${NAME}.sql`)).toMatch(
      new RegExp(`\\\\ir \\.\\./\\.\\./tests/sql/${NAME}\\.proof\\.sql`),
    );
  });

  it("is additive: it drops no column, table or function, and leaves the nine-argument writer as it was", () => {
    const s = sql();
    expect(s).not.toMatch(/DROP\s+(TABLE|COLUMN|FUNCTION|VIEW)\b/i);
    expect(s).not.toMatch(/ALTER TABLE[^;]*DROP COLUMN/i);
    expect(s).not.toMatch(/ALTER COLUMN/i);
    // The only set_directory_profile created here has twelve arguments.
    const created = [
      ...s.matchAll(/CREATE OR REPLACE FUNCTION public\.set_directory_profile\(([^)]*)\)/g),
    ];
    expect(created).toHaveLength(1);
    expect(created[0][1]).toMatch(/_tagline text,\s+_highlights text\[\],\s+_areas jsonb/);
    // ...and it calls the nine-argument one rather than copying it.
    const body = s.split("FUNCTION public.set_directory_profile(\n")[1].split("$fn$;")[0];
    expect(body).toMatch(
      /PERFORM public\.set_directory_profile\(_org, _slug, _display_name, _bio, _show_logo,\s+_coverage_zips, _coverage_cities, _services, _published\);/,
    );
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS tagline text;/);
    expect(s).toMatch(/ADD COLUMN IF NOT EXISTS highlights text\[\] NOT NULL DEFAULT '\{\}';/);
    // directory_search and directory_profiles_by_slug keep their shape.
    expect(s).not.toMatch(
      /FUNCTION public\.(directory_search|directory_profiles_by_slug|directory_public_rows)\b/,
    );
  });

  it("holds the limits in the database: 90, 4 x 40, 8 areas, 40-character names", () => {
    const s = sql();
    expect(s).toMatch(/char_length\(tagline\) BETWEEN 1 AND 90/);
    expect(s).toMatch(/cardinality\(_h\) <= 4/);
    expect(s).toMatch(/char_length\(x\) NOT BETWEEN 1 AND 40/);
    expect(s).toMatch(/CHECK \(position BETWEEN 0 AND 7\)/);
    expect(s).toMatch(/UNIQUE \(organization_id, position\)/);
    expect(s).toMatch(/char_length\(name\) BETWEEN 1 AND 40/);
    expect(DIRECTORY_TAGLINE_MAX).toBe(90);
    expect(DIRECTORY_HIGHLIGHTS_MAX).toBe(4);
    expect(DIRECTORY_HIGHLIGHT_MAX).toBe(40);
    expect(DIRECTORY_AREAS_MAX).toBe(8);
    expect(DIRECTORY_AREA_NAME_MAX).toBe(40);
  });

  it("gives the areas table RLS, two-step sign-in, owner-only writes and no anon grant", () => {
    const s = sql();
    const t = "directory_profile_areas";
    expect(s).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
    expect(s).toMatch(new RegExp(`SELECT public\\.require_mfa_policy\\('public\\.${t}'\\)`));
    expect(s).toMatch(new RegExp(`REVOKE ALL ON public\\.${t} FROM PUBLIC, anon, authenticated;`));
    expect(s).not.toMatch(new RegExp(`GRANT [^;]*ON public\\.${t} TO [^;]*anon`));
    const policies = [
      ...s.matchAll(/CREATE POLICY "[^"]+" ON public\.directory_profile_areas\s+FOR (\w+)[^;]*;/g),
    ];
    expect(policies.map((p) => p[1]).sort()).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    for (const p of policies.filter((p) => p[1] !== "SELECT")) {
      expect(p[0]).toMatch(
        /public\.has_role\(\(SELECT auth\.uid\(\)\), organization_id, 'owner'::public\.app_role\)/,
      );
      expect(p[0]).not.toMatch(/is_org_member/);
    }
    // The subset rule is a trigger, so a direct write cannot skip it.
    expect(s).toMatch(/BEFORE INSERT OR UPDATE ON public\.directory_profile_areas/);
    expect(s).toMatch(/AFTER UPDATE OF coverage_zips ON public\.directory_profiles/);
  });

  it("lets anon execute none of its functions, and both writers ask for an owner first", () => {
    const s = sql();
    for (const fn of [
      "directory_highlights_ok",
      "directory_profile_areas_guard",
      "directory_profile_areas_follow_coverage",
      "set_directory_profile_areas",
      "set_directory_profile",
    ]) {
      expect(s, fn).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon`),
      );
      expect(s, fn).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO [^;]*anon`),
      );
    }
    for (const fn of ["set_directory_profile_areas(", "set_directory_profile(\n"]) {
      const body = s.split(`FUNCTION public.${fn}`)[1].split("$fn$;")[0];
      const check = body.indexOf("public.has_role(auth.uid(), _org, 'owner'::public.app_role)");
      expect(check, fn).toBeGreaterThan(-1);
      for (const write of ["INSERT INTO", "DELETE FROM", "UPDATE public", "PERFORM public"]) {
        const at = body.indexOf(write);
        if (at > -1) expect(check, `${fn} ${write}`).toBeLessThan(at);
      }
    }
  });
});

describe("the public contract", () => {
  const view = () =>
    sql().split("CREATE OR REPLACE VIEW public.directory_public_listings")[1].split(";")[0];

  it("is the view's columns, in order, and nothing else", () => {
    expect(viewColumns(view())).toEqual([...PUBLIC_LISTING_FIELDS]);
    // The nine 20261112020000 created keep their place: REPLACE can only add.
    const before = codeOnly(
      read("supabase/migrations/20261112020000_a-directory-search-needs-no-service-role.sql"),
    )
      .split("CREATE VIEW public.directory_public_listings")[1]
      .split(";")[0];
    const first = viewColumns(before);
    expect(viewColumns(view()).slice(0, first.length)).toEqual(first);
    expect(sql()).toMatch(
      /IF _cols IS DISTINCT FROM ARRAY\['slug', 'display_name', 'logo_url', 'bio', 'service_lines',\s+'coverage_zips', 'coverage_cities', 'services', 'published_at',\s+'tagline', 'highlights', 'areas'\]/,
    );
  });

  it("names exactly the allowlisted keys for a service and an area", () => {
    const v = view();
    const svc = [...v.matchAll(/'([a-z_]+)', s\.[a-z_]+/g)].map((m) => m[1]);
    expect(svc).toEqual([...PUBLIC_SERVICE_FIELDS]);
    const area = v.split("FROM public.directory_profile_areas a")[0].split("AS services,")[1];
    expect([...area.matchAll(/'([a-z_]+)', /g)].map((m) => m[1])).toEqual([...PUBLIC_AREA_FIELDS]);
  });

  it("returns no organization id, contact detail or address", () => {
    // Two private columns are READ to join and to filter; take those clauses
    // out before looking for anything private in what is returned.
    const returned = view()
      .replace(/WHERE s\.organization_id = p\.organization_id/, "")
      .replace(/WHERE a\.organization_id = p\.organization_id/, "")
      .replace(/JOIN public\.organizations o ON o\.id = p\.organization_id/, "")
      .replace("CASE WHEN p.show_logo THEN o.logo_url END AS logo_url", "");
    for (const forbidden of [
      "organization_id",
      "confirmed_by",
      "client_id",
      "phone",
      "email",
      "street",
      "address",
      "contact_",
    ]) {
      expect(returned, forbidden).not.toMatch(new RegExp(`\\b${forbidden}`));
    }
    expect(view()).toMatch(/WHERE p\.published\s+AND o\.deleted_at IS NULL/);
  });

  it("is the list the proof expects, key for key", () => {
    const proof = readFileSync(PROOF, "utf8");
    const keys = /_keys IS DISTINCT FROM ARRAY\[([^\]]+)\]/.exec(proof)![1];
    expect([...keys.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual(
      [...PUBLIC_LISTING_FIELDS].sort(),
    );
    expect(proof).toMatch(/_area_keys IS DISTINCT FROM ARRAY\['name', 'zips'\]/);
  });

  it("toDirectoryListings keeps the allowlist and drops everything else, at every level", () => {
    const [l] = toDirectoryListings([
      {
        slug: "acme-scoop",
        display_name: "Acme",
        logo_url: null,
        bio: null,
        service_lines: ["dog_walking"],
        coverage_zips: ["48201", "48202"],
        coverage_cities: [],
        services: [
          {
            label: "Walk",
            service_line: "dog_walking",
            price_from_cents: 2200,
            price_unit: "visit",
            cost: 1,
          },
        ],
        published_at: null,
        tagline: "Same walker every week",
        highlights: ["Insured", 7, "GPS updates"],
        areas: [
          { name: "Downtown", zips: ["48201", 5], organization_id: "leak", position: 0 },
          { zips: ["48202"] },
        ],
        organization_id: "leak",
        contact_email: "owner@acme.test",
        contact_phone: "313-555-0100",
      },
    ]);
    expect(Object.keys(l).sort()).toEqual([...PUBLIC_LISTING_FIELDS].sort());
    expect(Object.keys(l.services[0]).sort()).toEqual([...PUBLIC_SERVICE_FIELDS].sort());
    expect(l.areas).toEqual([{ name: "Downtown", zips: ["48201"] }]);
    expect(Object.keys(l.areas[0]).sort()).toEqual([...PUBLIC_AREA_FIELDS].sort());
    expect(l.highlights).toEqual(["Insured", "GPS updates"]);
    expect(JSON.stringify(l)).not.toMatch(/leak|acme\.test|555/);
  });

  it("is what the e2e contract against a real stack expects", () => {
    const e2e = read("tests/e2e/a-quote-from-mypets-lands-in-the-test-org.spec.ts");
    const list = /const PUBLIC_FIELDS = \[([^\]]+)\]/.exec(e2e)![1];
    expect([...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual(
      [...PUBLIC_LISTING_FIELDS].sort(),
    );
  });
});

describe("the form's validation is the database's", () => {
  const ok = { tagline: "", highlights: [], areas: [], coverageZips: ["48201", "48202"] };

  it("accepts the limits and refuses one past each", () => {
    expect(directoryContentProblems({ ...ok, tagline: "t".repeat(90) })).toEqual([]);
    expect(directoryContentProblems({ ...ok, tagline: "t".repeat(91) })[0]?.where).toBe("tagline");
    expect(directoryContentProblems({ ...ok, highlights: ["a", "b", "c", "d"] })).toEqual([]);
    expect(
      directoryContentProblems({ ...ok, highlights: ["a", "b", "c", "d", "e"] })[0]?.where,
    ).toBe("highlights");
    expect(directoryContentProblems({ ...ok, highlights: ["h".repeat(40)] })).toEqual([]);
    expect(directoryContentProblems({ ...ok, highlights: ["h".repeat(41)] })[0]?.where).toBe(
      "highlights",
    );
    const area = (name: string, zips = ["48201"]) => ({ name, zips });
    const eight = Array.from({ length: 8 }, (_, i) => area(`Area ${i}`));
    expect(directoryContentProblems({ ...ok, areas: eight })).toEqual([]);
    expect(directoryContentProblems({ ...ok, areas: [...eight, area("Ninth")] })[0]?.where).toBe(
      "areas",
    );
    expect(directoryContentProblems({ ...ok, areas: [area("n".repeat(41))] })[0]?.where).toBe(
      "area-0",
    );
    expect(directoryContentProblems({ ...ok, areas: [area("")] })[0]?.message).toMatch(/name/);
    expect(directoryContentProblems({ ...ok, areas: [area("Downtown", [])] })[0]?.message).toMatch(
      /at least one ZIP/,
    );
    expect(
      directoryContentProblems({ ...ok, areas: [area("Downtown"), area(" downtown ")] }).map(
        (p) => p.where,
      ),
    ).toEqual(["area-1"]);
    const outside = directoryContentProblems({ ...ok, areas: [area("Far", ["48201", "90210"])] });
    expect(outside).toHaveLength(1);
    expect(outside[0].message).toMatch(/90210/);
    expect(outside[0].message).not.toMatch(/48201/);
  });

  it("cleans highlights the way the database stores them", () => {
    expect(cleanHighlights(["Insured", " ", "  GPS   photo updates ", "INSURED"])).toEqual([
      "Insured",
      "GPS photo updates",
    ]);
  });

  it("is applied by the server's schema too", () => {
    const base = {
      slug: "acme-scoop",
      displayName: "Acme",
      bio: null,
      showLogo: false,
      coverageZips: ["48201"],
      coverageCities: [],
      services: [],
      published: false,
      tagline: "  Same   walker ",
      highlights: ["Insured", "insured", ""],
      areas: [{ name: " Downtown ", zips: ["48201"] }],
    };
    const parsed = directoryProfileSchema.parse(base);
    expect(parsed.tagline).toBe("Same walker");
    expect(parsed.highlights).toEqual(["Insured"]);
    expect(parsed.areas).toEqual([{ name: "Downtown", zips: ["48201"] }]);
    expect(() =>
      directoryProfileSchema.parse({ ...base, areas: [{ name: "Far", zips: ["90210"] }] }),
    ).toThrow(/90210/);
    expect(() => directoryProfileSchema.parse({ ...base, tagline: "t".repeat(91) })).toThrow();
  });

  it("is what the settings page shows, beside each field", () => {
    const page = read("src/routes/_authenticated/settings.directory.tsx");
    expect(page).toMatch(/directoryContentProblems\(/);
    expect(page).toMatch(/problemsAt\("tagline"\)/);
    expect(page).toMatch(/problemsAt\("highlights"\)/);
    expect(page).toMatch(/problemsAt\(`area-\$\{i\}`\)/);
    // The ZIP picker offers the coverage, not a free-text box.
    expect(page).toMatch(/coveredZips\.map\(\(z\) =>/);
    expect(page).toMatch(/aria-pressed=\{picked\.has\(z\)\}/);
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
    `\n  SKIPPED: the ${NAME} proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)(
  "a directory profile says what a business is and where, in a real database",
  () => {
    it("has the files it runs", () => {
      expect(existsSync(MIGRATION)).toBe(true);
      expect(existsSync(PROOF)).toBe(true);
    });

    it("owner-only writes, the limits on every path, areas within coverage, anon through the view only, and both mutations reproduce", () => {
      const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
        encoding: "utf8",
        timeout: 300_000,
      });
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, out).toBe(0);
      expect(out).not.toMatch(/PROOF FAILED|PROOF INCONCLUSIVE/);
      expect(out).toMatch(/ALL DIRECTORY CONTENT PROOFS PASSED/);
    });
  },
);
