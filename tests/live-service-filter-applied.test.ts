import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// One rule, got wrong in four separate places, each of which asked
// `status = 'active'` and stopped there:
//
//   1. listClients — counted every ENDED service as one the tenant was running
//   2. admin_generate_seasonal_deepcleans — in SQL, where it BILLED: a deep
//      clean generated against a cancelled plan, twice a year, for ever
//   3. recomputePropertyEstimate — a finished one-off became the property's
//      cadence and doubled its routing time via initialCleanupFactor
//   4. the client portal's "your plan" — showed a dead one-off, and handed its
//      id to portalChangeFrequency
//
// The cause is that this schema does not record ending as a status:
// endSubscription writes `ends_on` and LEAVES status 'active'.
//
// Fixing four call sites is not the same as fixing the rule. This asserts the
// fixes are actually APPLIED at each site — a shared helper that nothing calls
// is the built-and-uncalled pattern the dead-machinery check exists for, and it
// cannot see TypeScript.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The `.from("subscriptions")` query chain, so an import line cannot satisfy
 *  an assertion about what the QUERY does. */
function subscriptionQuery(src: string): string {
  const start = src.indexOf('.from("subscriptions")');
  if (start < 0) throw new Error("no subscriptions query found");
  // To the end of the chain — the first line that is not part of it.
  const end = src.indexOf(".limit(1)", start);
  if (end < 0) throw new Error("subscriptions query has no .limit(1)");
  return src.slice(start, end + 10);
}

describe("every 'is this service live' query uses the shared rule", () => {
  it("the property service-time estimate does", () => {
    // Scoped to the subscriptions QUERY, not the file. `toContain` over the
    // whole file is satisfied by the import statement alone — which is how the
    // first version of this test passed a mutation that deleted the filter, the
    // same mistake the dead-machinery rule made when it counted TypeScript
    // comments as callers.
    const src = subscriptionQuery(read("src/lib/estimate.server.ts"));
    expect(src).toContain("liveServiceOrFilter(");
    // And excludes one_time outright: a single call-out is not this property's
    // ongoing cadence, and computeEstimatedMinutes multiplies by
    // initialCleanupFactor (2) when it sees one.
    expect(src).toMatch(/\.neq\(\s*"frequency",\s*"one_time"\s*\)/);
  });

  it("the client portal's plan lookup does", () => {
    const src = subscriptionQuery(read("src/lib/portal.functions.ts"));
    expect(src).toContain("liveServiceOrFilter(");
    expect(src).toMatch(/\.neq\(\s*"frequency",\s*"one_time"\s*\)/);
  });

  it("the client list uses isServiceEnded rather than status alone", () => {
    const src = read("src/lib/clients.functions.ts");
    // NOT a whole-file toContain — this file's own header explains that such an
    // assertion is satisfied by the import line, and then line 61 did exactly
    // that. It was satisfied by the COMMENT above it, and a mutation neutering
    // the only real call (`!(!!false && isServiceEnded(...))`, which counts
    // every ended service as live) passed. The call has to be a call.
    expect(src).toMatch(/if\s*\(\s*!\s*isServiceEnded\s*\(/);
    // It also has to SELECT ends_on, or it is judging on a column it did not
    // fetch — which reads as "never ended" for every row.
    expect(src).toMatch(/select\([^)]*ends_on/i);
  });

  it("the deep-clean generator's SQL filters on ends_on and skips one_time", () => {
    // The one that billed. Asserted against the shipped migration rather than
    // restated here.
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = join(ROOT, "supabase/migrations");
    const re =
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.admin_generate_seasonal_deepcleans\s*\(/i;
    let latest: string | null = null;
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      const sql = readFileSync(join(dir, f), "utf8");
      if (re.test(sql)) latest = sql;
    }
    expect(latest, "no migration defines admin_generate_seasonal_deepcleans").toBeTruthy();
    expect(latest!).toMatch(/ends_on\s+IS\s+NULL\s+OR\s+s\.ends_on\s*>=\s*_target/i);
    expect(latest!).toMatch(/frequency\s*<>\s*'one_time'/i);
  });

  it("booking a one-off generates only its own subscription, not the org", () => {
    // generate_visits_through is org-wide; beyond the 60-day horizon one
    // booking pinned the whole org's schedule across a window with no
    // blackouts entered, and addBlackout does not remove visits already made.
    // The body moved to one-off-visit.server.ts on 2026-09-29, when the
    // portal's auto-accept path became its second caller. That path runs as
    // the service role and so calls generate_visits_core, the function
    // generate_visits_for_subscription wraps -- still scoped to one
    // subscription, which is the property this test exists for.
    const src = read("src/lib/one-off-visit.server.ts");
    const block = src.slice(src.indexOf("export async function bookOneOffVisit"));
    expect(block).toContain("generate_visits_for_subscription");
    expect(block).toMatch(/generate_visits_core[\s\S]{0,200}_subscription_id:\s*sub\.id/);
    expect(block).not.toMatch(/rpc\(\s*"generate_visits_through"/);
    // And createOneOffVisit still reaches it rather than keeping a copy.
    const fn = read("src/lib/visits.functions.ts");
    expect(fn.slice(fn.indexOf("export const createOneOffVisit"))).toMatch(/bookOneOffVisit\(/);
  });
});
