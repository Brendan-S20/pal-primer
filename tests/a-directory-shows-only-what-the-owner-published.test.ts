// A directory shows only what the owner published (#630, phase 1).
//
// HoundStack's OWN directory of pet pros, not an Angi listing. This file:
//   * pins the migration: anon reads only through the two public RPCs, which
//     return published rows of live businesses and public columns only; anon
//     holds no grant on either table and cannot execute the writer or the
//     slug-to-org lookup; only an owner writes; no review tables (phase 2);
//   * pins the pages: every /pros route sets its own noindex and a
//     self-canonical through directoryHead, never passes `indexable`, and is
//     drawn inside DirectoryShell, which carries the "HoundStack customers"
//     disclosure; the public shape has no contact or address field;
//   * pins the pure helpers (compare is up to three, the quote body);
//   * runs tests/sql/a-directory-shows-only-what-the-owner-published.proof.sql
//     against a real database when one answers (skipped, loudly, when none
//     does). CI's database job runs the same proof through supabase/proofs/.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DIRECTORY_DISCLOSURE,
  MAX_COMPARE,
  cleanZip,
  compareSlugs,
  directoryHead,
  directoryQuoteBody,
  isDirectorySlug,
  lowestPriceFrom,
  priceFromLabel,
  slugFromName,
  type DirectoryProfile,
} from "@/lib/directory";
import { toDirectoryProfiles } from "@/lib/directory.functions";
import { appLinkClaims, STAYS_IN_BROWSER } from "@/lib/android-app-links";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261110120000_a-pet-owner-can-find-compare-and-ask-a-business-that-opted-in.sql",
);
const PROOF = join(ROOT, "tests/sql/a-directory-shows-only-what-the-owner-published.proof.sql");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const sql = () =>
  readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

const PAGES = [
  "src/routes/pros.index.tsx",
  "src/routes/pros.compare.tsx",
  "src/routes/pros.$slug.index.tsx",
  "src/routes/pros.$slug.quote.tsx",
];

describe("the migration", () => {
  it("is timestamped after every open PR's and has a proof beside it", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(
      existsSync(
        join(
          ROOT,
          "supabase/proofs/20261110120000-a-directory-shows-only-what-the-owner-published.sql",
        ),
      ),
    ).toBe(true);
    expect(
      read("supabase/proofs/20261110120000-a-directory-shows-only-what-the-owner-published.sql"),
    ).toMatch(
      /\\ir \.\.\/\.\.\/tests\/sql\/a-directory-shows-only-what-the-owner-published\.proof\.sql/,
    );
  });

  it("gives anon no grant on either table, and RLS plus two-step sign-in on both", () => {
    const s = sql();
    for (const t of ["directory_profiles", "directory_profile_services"]) {
      expect(s).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
      expect(s).toMatch(new RegExp(`SELECT public\\.require_mfa_policy\\('public\\.${t}'\\)`));
      expect(s).toMatch(new RegExp(`REVOKE ALL ON public\\.${t} FROM anon`));
      expect(s).toMatch(
        new RegExp(`REVOKE INSERT, UPDATE, DELETE ON public\\.${t} FROM authenticated`),
      );
      expect(s).not.toMatch(new RegExp(`GRANT [^;]*ON public\\.${t} TO [^;]*anon`));
    }
  });

  it("lets anon execute only the two readers, never the writer or the org lookup", () => {
    const s = sql();
    expect(s).toMatch(/GRANT EXECUTE ON FUNCTION public\.directory_search\(text, text\) TO anon/);
    expect(s).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.directory_profiles_by_slug\(text\[\]\) TO anon/,
    );
    for (const fn of [
      "directory_org_for_quote",
      "directory_public_rows",
      "set_directory_profile",
    ]) {
      expect(s).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon`),
      );
      expect(s).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO [^;]*anon`),
      );
    }
  });

  it("reads only published rows of businesses that are not deleted", () => {
    const body = sql().split("FUNCTION public.directory_public_rows")[1].split("$fn$;")[0];
    expect(body).toMatch(/WHERE p\.published/);
    expect(body).toMatch(/o\.deleted_at IS NULL/);
    const lookup = sql().split("FUNCTION public.directory_org_for_quote")[1].split("$fn$;")[0];
    expect(lookup).toMatch(/p\.published AND o\.deleted_at IS NULL/);
  });

  it("returns no organization id, contact detail, address or client from the public readers", () => {
    const shape = sql().split("FUNCTION public.directory_public_rows")[1].split("LANGUAGE sql")[0];
    for (const forbidden of [
      "organization_id",
      "confirmed_by",
      "client_id",
      "phone",
      "email",
      "street",
      "address",
    ]) {
      expect(shape, forbidden).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it("asks for an owner of the business before writing anything", () => {
    const body = sql().split("FUNCTION public.set_directory_profile(")[1].split("$fn$;")[0];
    expect(body).toMatch(/public\.has_role\(auth\.uid\(\), _org, 'owner'::public\.app_role\)/);
    expect(body.indexOf("has_role")).toBeLessThan(body.indexOf("INSERT INTO"));
    // Only this business's own services can be listed.
    expect(body).toMatch(/AND s\.organization_id = _org/);
    // ...and only ones it sells today.
    expect(body).toMatch(/AND s\.active\b/);
  });

  it("is off by default, and leaves reviews to the next migration", () => {
    const s = sql();
    expect(s).toMatch(/published boolean NOT NULL DEFAULT false/);
    expect(s).not.toMatch(/CREATE TABLE[^;]*directory_review/);
  });

  it("asserts what it establishes, from any starting state", () => {
    const s = sql();
    expect(s).toMatch(/RAISE EXCEPTION 'anon can read a directory table directly'/);
    expect(s).toMatch(/RAISE EXCEPTION 'set_directory_profile does not ask for an owner'/);
  });
});

describe("the pages", () => {
  it("each sets its own robots tag and a self-canonical, and none is indexable", () => {
    for (const f of PAGES) {
      const src = read(f);
      expect(src, f).toMatch(/head: [^]*directoryHead\(/);
      expect(src, f).not.toMatch(/indexable/);
      expect(src, f).toMatch(/<DirectoryShell>/);
    }
    const h = directoryHead({
      title: "t",
      description: "d",
      path: "/pros/acme",
      origin: "https://x.test",
    });
    expect(h.meta).toContainEqual({ name: "robots", content: "noindex, follow" });
    expect(h.links).toEqual([{ rel: "canonical", href: "https://x.test/pros/acme" }]);
  });

  it("does not touch the root's head (#738 owns __root.tsx)", () => {
    expect(read("src/routes/__root.tsx")).not.toMatch(/pros|directory/i);
  });

  it("draw the disclosure on every page, through the shell", () => {
    expect(read("src/components/directory/DirectoryShell.tsx")).toMatch(/\{DIRECTORY_DISCLOSURE\}/);
    expect(DIRECTORY_DISCLOSURE).toMatch(/runs their business on HoundStack/);
    expect(DIRECTORY_DISCLOSURE).toMatch(/chose to be listed/);
    expect(DIRECTORY_DISCLOSURE).toMatch(/No paid placement/);
  });

  it("imply no affiliation: Angi is named nowhere a visitor reads, the disclosure included", () => {
    expect(DIRECTORY_DISCLOSURE).not.toMatch(/\bAngi\b/);
    const files = [
      ...PAGES,
      "src/components/directory/DirectoryShell.tsx",
      "src/components/directory/DirectoryProfileParts.tsx",
      "src/routes/_authenticated/settings.directory.tsx",
    ];
    for (const f of files) expect(read(f), f).not.toMatch(/\bAngi\b/);
  });

  it("carry no structured data or stars in phase 1", () => {
    for (const f of PAGES) {
      const src = read(f);
      expect(src, f).not.toMatch(/application\/ld\+json|AggregateRating|LocalBusiness|Star/);
    }
  });

  it("are customer pages that stay in the browser on Android; the settings page opens the app", () => {
    expect(STAYS_IN_BROWSER["/pros"]).toBeTruthy();
    expect(appLinkClaims("/pros/acme-scoop")).toBe(false);
    expect(appLinkClaims("/settings/directory")).toBe(true);
  });
});

describe("the public shape", () => {
  it("drops anything that is not a public column, whatever the RPC returns", () => {
    const [p] = toDirectoryProfiles([
      {
        slug: "acme-scoop",
        display_name: "Acme",
        logo_url: null,
        bio: "Hi",
        service_lines: ["pet_waste"],
        coverage_zips: ["48201"],
        coverage_cities: ["Detroit"],
        services: [
          {
            label: "Weekly",
            service_line: "pet_waste",
            price_from_cents: 1500,
            price_unit: "visit",
            secret: 1,
          },
        ],
        published_at: null,
        organization_id: "leak",
        phone: "313-555-0100",
        email: "owner@acme.test",
      },
    ]);
    expect(Object.keys(p).sort()).toEqual(
      [
        "bio",
        "coverage_cities",
        "coverage_zips",
        "display_name",
        "logo_url",
        "published_at",
        "service_lines",
        "services",
        "slug",
      ].sort(),
    );
    expect(Object.keys(p.services[0]).sort()).toEqual(
      ["label", "price_from_cents", "price_unit", "service_line"].sort(),
    );
  });
});

describe("the helpers", () => {
  it("compares up to three, cleaned and deduplicated", () => {
    expect(MAX_COMPARE).toBe(3);
    expect(compareSlugs("a-1,b-2,A-1,c-3,d-4")).toEqual(["a-1", "b-2", "c-3"]);
    expect(compareSlugs("../etc,ok-slug,")).toEqual(["ok-slug"]);
    expect(compareSlugs(undefined)).toEqual([]);
  });

  it("takes a five-digit ZIP and nothing else", () => {
    expect(cleanZip(" 48201 ")).toBe("48201");
    expect(cleanZip("4820%")).toBeNull();
    expect(cleanZip("482011")).toBeNull();
  });

  it("suggests a slug the database will accept", () => {
    for (const n of ["Acme Scoopers LLC", "Ñandú Pets", "A", "!!!", "x".repeat(90)]) {
      expect(isDirectorySlug(slugFromName(n)), n).toBe(true);
    }
  });

  it("says a price-from, or asks for a quote", () => {
    expect(priceFromLabel({ price_from_cents: 2200, price_unit: "visit" })).toBe(
      "From $22 / visit",
    );
    expect(priceFromLabel({ price_from_cents: 1250, price_unit: null })).toBe("From $12.50");
    expect(priceFromLabel({ price_from_cents: null, price_unit: "visit" })).toBe("Ask for a quote");
    const p = {
      services: [
        { label: "a", service_line: "dog_walking", price_from_cents: 3000, price_unit: "visit" },
        { label: "b", service_line: "dog_walking", price_from_cents: 2500, price_unit: "visit" },
        { label: "c", service_line: "pet_waste", price_from_cents: 1000, price_unit: "visit" },
      ],
    } as DirectoryProfile;
    expect(lowestPriceFrom(p, "dog_walking")?.label).toBe("b");
    expect(lowestPriceFrom(p, null)?.label).toBe("c");
  });

  it("builds a quote body that names the directory slug and the source", () => {
    const b = directoryQuoteBody("acme-scoop", {
      name: " Rosa ",
      email: "r@example.test",
      phone: "",
      zip: "48201",
      service_line: "dog_walking",
      dog_count: "",
      message: "",
    });
    expect(b).toMatchObject({
      directory_slug: "acme-scoop",
      source: "directory",
      location: "48201",
      name: "Rosa",
    });
    expect(b).not.toHaveProperty("slug");
    expect(b.dog_count).toBeUndefined();
    expect(b.message).toContain("Asked about: Dog walking.");
  });
});

describe("the owner's settings page", () => {
  it("is a new page, and settings.business.tsx is not touched for it (#709)", () => {
    expect(read("src/routes/_authenticated/settings.directory.tsx")).toMatch(
      /createFileRoute\("\/_authenticated\/settings\/directory"\)/,
    );
    expect(read("src/routes/_authenticated/settings.business.tsx")).not.toMatch(
      /directory_profile|DirectoryProfile/,
    );
    expect(read("src/routes/_authenticated/settings.tsx")).toMatch(/to: "\/settings\/directory"/);
  });

  it("saves only as an owner, before the RPC", () => {
    const src = read("src/lib/directory.functions.ts");
    const save = src.split("export const saveMyDirectoryProfile")[1];
    expect(save.indexOf('role !== "owner"')).toBeGreaterThan(-1);
    expect(save.indexOf('role !== "owner"')).toBeLessThan(
      save.indexOf('rpc("set_directory_profile"'),
    );
    expect(save).not.toMatch(/supabaseAdmin/);
  });
});

describe("the hand-written types", () => {
  it("leave supabase/types.ts alone (#749, #733, #717, #716)", () => {
    expect(read("src/integrations/supabase/types.ts")).not.toMatch(/directory_profiles/);
  });

  it("put no contact or address field on the public type", () => {
    const src = read("src/lib/directory.ts");
    const t = src.split("export type DirectoryProfile = {")[1].split("};")[0];
    expect(t).not.toMatch(/phone|email|street|address|organization_id/);
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
    `\n  SKIPPED: the a-directory-shows-only-what-the-owner-published proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)(
  "a directory shows only what the owner published, in a real database",
  () => {
    it("has the files it runs", () => {
      expect(existsSync(MIGRATION)).toBe(true);
      expect(existsSync(PROOF)).toBe(true);
    });

    it("owner-only writes, published-only anon reads, no private column, and the mutation reproduces", () => {
      const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
        encoding: "utf8",
        timeout: 300_000,
      });
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, out).toBe(0);
      expect(out).not.toMatch(/PROOF FAILED|PROOF INCONCLUSIVE/);
      expect(out).toMatch(/ALL DIRECTORY PROOFS PASSED/);
    });
  },
);

// Keep the reader honest: every directory page is listed above.
it("lists every /pros route file", () => {
  const routes = readdirSync(join(ROOT, "src/routes")).filter((f) => f.startsWith("pros."));
  expect(routes.map((f) => `src/routes/${f}`).sort()).toEqual([...PAGES].sort());
});
