import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The `leads` INSERT policy was `WITH CHECK (true)`, on a table reached with
// the PUBLISHABLE key — the one shipped to every browser. So anyone could POST
// straight to /rest/v1/leads, skipping both application paths, and write a lead
// into any organization_id they liked. The org UUID needed to aim it is one
// documented anon lookup away: public_get_org_for_lead_form is SECURITY
// DEFINER, granted to anon, and returns the id for any slug.
//
// Same shape as the seed_demo_org and ai_usage_state findings before it: a
// server function that authorizes correctly, and the table underneath open to
// everyone who reaches PostgREST directly.
//
// Probed live as `anon` in a rolled-back transaction, after the fix:
//
//   real form submission ............ ACCEPTED  (want ACCEPTED)
//   orphan lead (org_id NULL) ....... BLOCKED
//   lead pre-set to converted ....... BLOCKED
//   lead pre-set to contacted ....... BLOCKED
//   lead aimed at a nonexistent org . BLOCKED
//   anon reading leads .............. 0 rows visible
//
// The first line is the one that matters most. The obvious policy body — an
// inline EXISTS against `organizations` — rejects EVERY submission, because
// that subquery runs as the caller and anon cannot read `organizations`. It was
// written that way first and the probe caught it; without the probe the lead
// form would have shipped silently dead.

const ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const allSql = files.map((f) => readFileSync(join(MIGRATIONS, f), "utf8"));

/** The body of the LAST policy created for a table+command. */
function latestPolicy(table: string, cmd: string): string {
  let found = "";
  const re = new RegExp(
    `CREATE\\s+POLICY[\\s\\S]*?ON\\s+public\\.${table}[\\s\\S]*?FOR\\s+${cmd}[\\s\\S]*?;`,
    "gi",
  );
  for (const sql of allSql) {
    const matches = sql.match(re);
    if (matches?.length) found = matches[matches.length - 1];
  }
  return found;
}

describe("the leads insert policy", () => {
  const policy = latestPolicy("leads", "INSERT");

  it("exists at all", () => {
    expect(policy, "no INSERT policy for public.leads found in any migration").not.toBe("");
  });

  it("is no longer WITH CHECK (true)", () => {
    expect(policy).not.toMatch(/WITH\s+CHECK\s*\(\s*true\s*\)/i);
  });

  it("refuses a lead that names no organization", () => {
    // Nullable column, no default. An orphan lead is invisible to every
    // tenant's SELECT *and* every tenant's DELETE — it accumulates and nobody
    // can remove it.
    expect(policy).toMatch(/organization_id\s+IS\s+NOT\s+NULL/i);
  });

  it("resolves the organization through a SECURITY DEFINER function, not an inline EXISTS", () => {
    // This is the regression the live probe caught. An inline subquery against
    // `organizations` evaluates as `anon`, which cannot read that table, so the
    // policy denies everything including the real form.
    expect(policy).toMatch(/org_accepts_public_leads\s*\(/i);
    expect(policy).not.toMatch(/SELECT[\s\S]*FROM\s+public\.organizations/i);
  });

  it("refuses a submission that pre-sets the tenant's own workflow state", () => {
    // A lead arriving already `converted` is a false entry in the conversion
    // figures on the platform overview and in the weekly digest.
    expect(policy).toMatch(/status\s*=\s*'new'/i);
    expect(policy).toMatch(/contacted_at\s+IS\s+NULL/i);
    expect(policy).toMatch(/converted_at\s+IS\s+NULL/i);
  });
});

describe("the resolver the policy depends on", () => {
  const fn =
    allSql
      .flatMap((sql) => sql.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.org_accepts_public_leads[\s\S]*?\$\$;/gi) ?? [])
      .pop() ?? "";

  it("is SECURITY DEFINER with a pinned search_path", () => {
    expect(fn, "org_accepts_public_leads not found").not.toBe("");
    expect(fn).toMatch(/SECURITY\s+DEFINER/i);
    expect(fn).toMatch(/SET\s+search_path\s*=\s*public,\s*pg_temp/i);
  });

  it("excludes soft-deleted organizations", () => {
    expect(fn).toMatch(/deleted_at\s+IS\s+NULL/i);
  });

  it("matches how the lead form actually resolves a business", () => {
    // public_get_org_for_lead_form accepts portal_slug OR slug. If the two ever
    // disagree, the policy stops describing which businesses have a form.
    expect(fn).toMatch(/portal_slug\s+IS\s+NOT\s+NULL\s+OR\s+o\.slug\s+IS\s+NOT\s+NULL/i);
  });

  it("is not granted to PUBLIC", () => {
    const grantSql = allSql.find((s) => s.includes("org_accepts_public_leads")) ?? "";
    expect(grantSql).toMatch(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.org_accepts_public_leads\(uuid\)\s+FROM\s+PUBLIC/i);
  });
});

describe("no write policy anywhere is unconditional", () => {
  it("has no INSERT/UPDATE/DELETE policy with a bare `true`", () => {
    // Verified against the live database at the same time: the only remaining
    // `true` policies are four SELECTs on platform-wide catalogs — addons,
    // feature flags, referral settings, the weather cache — which hold no
    // tenant data. Every write policy is now conditional.
    // Every policy a later migration explicitly drops, as exact (name, table)
    // pairs. Matching on the name alone is not enough: "Anyone can submit a
    // lead" is a PREFIX of its replacement "Anyone can submit a lead to a
    // business that publishes a form", so a substring test silently reports the
    // old one as dropped whether or not it ever was.
    const dropped = new Set<string>();
    for (const sql of allSql) {
      const re = /DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"([^"]+)"\s+ON\s+(public\.\w+)/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql))) dropped.add(`${m[1]}||${m[2].toLowerCase()}`);
    }

    const offenders: string[] = [];
    for (const [i, sql] of allSql.entries()) {
      // Split on the statement keyword and cut each chunk at its own
      // terminator. A single greedy regex spans NEIGHBOURING statements and
      // pairs a SELECT policy's `USING (true)` with a later `FOR INSERT`,
      // which is how the first version of this test reported three false
      // positives on read-only catalog tables.
      for (const chunk of sql.split(/CREATE\s+POLICY/i).slice(1)) {
        const stmt = "CREATE POLICY" + chunk.split(";")[0];
        if (!/\bFOR\s+(INSERT|UPDATE|DELETE|ALL)\b/i.test(stmt)) continue;
        if (!/WITH\s+CHECK\s*\(\s*true\s*\)/i.test(stmt) && !/USING\s*\(\s*true\s*\)/i.test(stmt)) {
          continue;
        }
        // A later migration may legitimately drop an offender created earlier.
        // Only ones still standing at the end of the ledger count.
        const name = /CREATE\s+POLICY\s+"([^"]+)"/i.exec(stmt)?.[1];
        const table = /ON\s+(public\.\w+)/i.exec(stmt)?.[1]?.toLowerCase();
        if (name && table && dropped.has(`${name}||${table}`)) continue;
        offenders.push(`${files[i]}: ${stmt.slice(0, 90).replace(/\s+/g, " ")}…`);
      }
    }
    expect(offenders, `unconditional write policies still standing:\n${offenders.join("\n")}`).toEqual([]);
  });
});
