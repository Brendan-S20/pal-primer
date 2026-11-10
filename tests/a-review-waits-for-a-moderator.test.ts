// A review in HoundStack's directory is public only after a moderator
// approves it (#630; Brendan, 2026-11-09). And the directory's domain lives in
// one config value, with no DNS or Vercel step in the code.
//
// This file:
//   * pins the migration: a new review starts pending, every edit returns it
//     to pending, only a platform admin approves or rejects (asked inside the
//     function), a rejection names a written rule and never the rating, the
//     public reader returns approved reviews only and no reviewer identity,
//     and no client role touches the table;
//   * pins the server functions: both moderator functions ask
//     is_platform_admin BEFORE any other call, and refuse anyone else;
//   * pins the queue page: in the platform console, which only a platform
//     admin reaches;
//   * pins the domain decision: "mypets.services" is written in exactly one
//     file in src/, nothing links to it, and canonicals do not point at it;
//   * runs tests/sql/a-review-waits-for-a-moderator.proof.sql against a real
//     database when one answers (skipped, loudly, when none does): a new
//     review is not visible publicly; it becomes visible only after approval;
//     a rejected review never shows.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MIN_REVIEWS_FOR_AVERAGE,
  REVIEW_REJECTION_REASONS,
  reviewSummary,
  toPublicReviews,
} from "@/lib/directory-reviews";
import { ONLY_A_MODERATOR, assertModerator } from "@/lib/directory-reviews.functions";
import { DIRECTORY_BRAND, directoryOrigin } from "@/lib/directory-site";

vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const PROFILES = join(
  ROOT,
  "supabase/migrations/20261110120000_a-pet-owner-can-find-compare-and-ask-a-business-that-opted-in.sql",
);
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261110120100_a-review-is-public-only-after-a-moderator-approves-it.sql",
);
const PROOF = join(ROOT, "tests/sql/a-review-waits-for-a-moderator.proof.sql");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const sql = () =>
  readFileSync(MIGRATION, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
const fnBody = (name: string) => sql().split(`FUNCTION public.${name}(`)[1].split("$fn$;")[0];

describe("the migration", () => {
  it("comes after the profiles migration and has a proof beside it", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(MIGRATION > PROFILES).toBe(true);
    expect(read("supabase/proofs/20261110120100-a-review-waits-for-a-moderator.sql")).toMatch(
      /\\ir \.\.\/\.\.\/tests\/sql\/a-review-waits-for-a-moderator\.proof\.sql/,
    );
  });

  it("starts every review pending, and only the moderator function changes that", () => {
    const s = sql();
    expect(s).toMatch(/status text NOT NULL DEFAULT 'pending'/);
    const submit = fnBody("submit_directory_review");
    expect(submit).not.toMatch(/'approved'/);
    // An edit goes back to the queue.
    expect(submit).toMatch(
      /ON CONFLICT \(organization_id, client_id\) DO UPDATE SET[^;]*status = 'pending'/,
    );
    const writers = s.match(/status = CASE WHEN _approve THEN 'approved'/g) ?? [];
    expect(writers).toHaveLength(1);
    expect(fnBody("moderate_directory_review")).toMatch(/'approved'/);
  });

  it("lets only a platform admin read the queue or moderate, asked first", () => {
    for (const fn of ["directory_review_queue", "moderate_directory_review"]) {
      const body = fnBody(fn);
      const ask = body.indexOf("public.is_platform_admin(auth.uid())");
      expect(ask, fn).toBeGreaterThan(-1);
      expect(ask, fn).toBeLessThan(Math.max(body.indexOf("UPDATE"), body.indexOf("RETURN QUERY")));
      expect(sql()).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon`),
      );
    }
  });

  it("rejects only under a written rule, never the rating", () => {
    const s = sql();
    for (const r of REVIEW_REJECTION_REASONS) expect(s).toContain(`'${r}'`);
    expect(s).not.toMatch(/'(negative|low_rating|too_negative|rating)'/);
    expect(s).toMatch(/CHECK \(\(status = 'rejected'\) = \(rejection_reason IS NOT NULL\)\)/);
  });

  it("shows a visitor approved reviews only, and never who wrote them", () => {
    const body = fnBody("directory_public_reviews");
    expect(body).toMatch(/r\.status = 'approved'/);
    expect(body).toMatch(/p\.published/);
    expect(body).toMatch(/o\.deleted_at IS NULL/);
    const shape = sql().split("FUNCTION public.directory_public_reviews(")[1].split("LANGUAGE")[0];
    expect(shape).not.toMatch(/client|email|name|organization_id/);
  });

  it("gives no client role the table, and only the server submits", () => {
    const s = sql();
    expect(s).toMatch(/REVOKE ALL ON public\.directory_reviews FROM anon, authenticated/);
    expect(s).not.toMatch(/GRANT [^;]*ON public\.directory_reviews TO [^;]*(anon|authenticated)/);
    expect(s).toMatch(
      /REVOKE ALL ON FUNCTION public\.submit_directory_review\(uuid, integer, text\) FROM PUBLIC, anon, authenticated/,
    );
  });

  it("takes a review only from a client with a completed visit or a paid invoice, not from staff", () => {
    const body = fnBody("submit_directory_review");
    expect(body).toMatch(/v\.status = 'completed'/);
    expect(body).toMatch(/i\.status = 'paid'/);
    expect(body).toMatch(/staff cannot review their own business/);
    expect(body).toMatch(/p\.published/);
  });
});

describe("the server functions", () => {
  const rpcClient = (answer: unknown, error: { message: string } | null = null) => {
    const calls: string[] = [];
    return {
      calls,
      rpc: async (fn: string) => (calls.push(fn), { data: answer, error }),
    };
  };

  it("let a platform admin through", async () => {
    const db = rpcClient(true);
    await expect(assertModerator(db, "u1")).resolves.toBeUndefined();
    expect(db.calls).toEqual(["is_platform_admin"]);
  });

  it.each([
    ["a business owner", false],
    ["an unknown answer", null],
    ["a failed check", true, { message: "boom" }],
  ] as const)("refuse %s", async (_l, answer, error = null) => {
    await expect(assertModerator(rpcClient(answer, error), "u1")).rejects.toThrow(ONLY_A_MODERATOR);
  });

  it("ask before every other call, on the caller's own client", () => {
    const src = read("src/lib/directory-reviews.functions.ts");
    for (const name of ["listDirectoryReviewQueue", "moderateDirectoryReview"]) {
      const body = src.split(`export const ${name}`)[1].split("export const")[0];
      expect(body.indexOf("assertModerator(context.supabase")).toBeGreaterThan(-1);
      expect(body.indexOf("assertModerator(")).toBeLessThan(body.indexOf(".rpc("));
      expect(body).not.toMatch(/supabaseAdmin/);
    }
  });

  it("does not let anything client-facing submit a review yet", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          /\.(ts|tsx)$/.test(f) &&
          readFileSync(p, "utf8").includes("submit_directory_review")
        ) {
          hits.push(p);
        }
      }
    };
    walk(join(ROOT, "src"));
    expect(hits).toEqual([]);
  });
});

describe("the queue page", () => {
  it("lives in the platform console and is in its nav", () => {
    expect(read("src/routes/platform.directory-reviews.tsx")).toMatch(
      /createFileRoute\("\/platform\/directory-reviews"\)/,
    );
    expect(read("src/routes/platform.tsx")).toMatch(/to: "\/platform\/directory-reviews"/);
  });

  it("offers only the written rules as rejection reasons", () => {
    const src = read("src/routes/platform.directory-reviews.tsx");
    expect(src).toMatch(/REVIEW_REJECTION_REASONS\.map/);
  });
});

describe("what a visitor reads", () => {
  it("writes out an average only from three approved reviews", () => {
    expect(MIN_REVIEWS_FOR_AVERAGE).toBe(3);
    expect(reviewSummary([{ rating: 5 }, { rating: 4 }])).toBeNull();
    expect(reviewSummary([{ rating: 5 }, { rating: 4 }, { rating: 5 }])).toEqual({
      average: 4.7,
      count: 3,
    });
  });

  it("drops anything that is not rating, text and date", () => {
    expect(
      toPublicReviews([
        { rating: 5, body: "ok", reviewed_at: "2026-11-01", client_id: "leak", name: "Jo" },
      ]),
    ).toEqual([{ rating: 5, body: "ok", reviewed_at: "2026-11-01" }]);
  });

  it("are drawn on the profile only from the approved-only reader, with no structured data", () => {
    const page = read("src/routes/pros.$slug.index.tsx");
    expect(page).toMatch(/getDirectoryReviews/);
    expect(read("src/lib/directory-reviews.functions.ts")).toMatch(
      /rpc\("directory_public_reviews"/,
    );
    expect(read("src/components/directory/DirectoryReviews.tsx")).not.toMatch(
      /ld\+json|AggregateRating/,
    );
  });
});

describe("the domain (mypets.services: registered, attached after merge)", () => {
  afterEach(() => {
    delete process.env.DIRECTORY_ORIGIN;
  });

  it("is written in exactly one file in src/", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|css|html|json)$/.test(f) && /mypets/i.test(readFileSync(p, "utf8"))) {
          hits.push(p.slice(ROOT.length + 1).replace(/\\/g, "/"));
        }
      }
    };
    walk(join(ROOT, "src"));
    expect(hits).toEqual(["src/lib/directory-site.ts"]);
    expect(DIRECTORY_BRAND).toBe("mypets.services");
  });

  it("is not linked to, and no DNS, Vercel, deployment or Android config names it", () => {
    expect(read("src/lib/directory-site.ts")).not.toMatch(/https?:\/\/(www\.)?mypets/i);
    for (const f of [
      "vite.config.ts",
      "capacitor.config.ts",
      "android/app/src/main/AndroidManifest.xml",
      "src/lib/android-app-links.ts",
      "src/routes/[.]well-known.assetlinks[.]json.ts",
    ]) {
      expect(read(f), f).not.toMatch(/mypets/i);
    }
  });

  it("does not become the canonical until DIRECTORY_ORIGIN says so", () => {
    delete process.env.DIRECTORY_ORIGIN;
    expect(directoryOrigin()).not.toMatch(/mypets/);
    process.env.DIRECTORY_ORIGIN = "https://mypets.services/";
    expect(directoryOrigin()).toBe("https://mypets.services");
    process.env.DIRECTORY_ORIGIN = "javascript:alert(1)";
    expect(directoryOrigin()).not.toMatch(/javascript/);
  });

  it("is what every directory page's canonical is built from", () => {
    for (const f of [
      "src/routes/pros.index.tsx",
      "src/routes/pros.compare.tsx",
      "src/routes/pros.$slug.index.tsx",
      "src/routes/pros.$slug.quote.tsx",
    ]) {
      const src = read(f);
      expect(src, f).toMatch(/origin: directoryOrigin\(\)/);
      expect(src, f).not.toMatch(/appOrigin/);
    }
  });
});

describe("no minimum number of businesses per city", () => {
  it("is in the code: nothing counts businesses before listing them", () => {
    const files = [
      "src/lib/directory.ts",
      "src/lib/directory.functions.ts",
      "src/routes/pros.index.tsx",
      "supabase/migrations/20261110120000_a-pet-owner-can-find-compare-and-ask-a-business-that-opted-in.sql",
    ];
    for (const f of files) {
      expect(read(f), f).not.toMatch(
        /MIN_(BUSINESSES|PROFILES)|businesses_per_city|min_per_city|Detroit has/i,
      );
    }
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
    `\n  SKIPPED: the a-review-waits-for-a-moderator proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("a review waits for a moderator, in a real database", () => {
  it("a new review is not visible; it becomes visible only after approval; a rejected one never shows", () => {
    // The profiles migration only where the stack does not have it yet.
    const has = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select to_regclass('public.directory_profiles') is not null"],
      { encoding: "utf8" },
    ).stdout?.trim();
    const args = [DB_URL, "-X", "-v", `migration=${MIGRATION}`];
    if (has !== "t") args.push("-v", `profiles=${PROFILES}`);
    const r = spawnSync(psql!, [...args, "-f", PROOF], { encoding: "utf8", timeout: 300_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED|PROOF INCONCLUSIVE/);
    expect(out).toMatch(/a new review is not visible publicly/);
    expect(out).toMatch(/the approved review is visible, the rejected one is not/);
    expect(out).toMatch(/ALL REVIEW MODERATION PROOFS PASSED/);
  });
});
