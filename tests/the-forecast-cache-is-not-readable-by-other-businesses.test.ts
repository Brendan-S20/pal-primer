import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const strip = (s: string) =>
  s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("weather_forecast_cache is service-role only (#1005)", () => {
  it("drops the signed-in SELECT policy and adds none", () => {
    const sql = strip(
      readFileSync(
        "supabase/migrations/20261119140000_the-forecast-cache-is-not-readable-by-other-businesses.sql",
        "utf8",
      ),
    );
    expect(sql).toMatch(
      /DROP\s+POLICY\s+IF\s+EXISTS\s+"authenticated read weather cache"\s+ON\s+public\.weather_forecast_cache\s*;/i,
    );
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
  });

  it("reads the cache with the admin client, not the caller's", () => {
    const src = readFileSync("src/lib/weather.functions.ts", "utf8");
    const reads = [...src.matchAll(/(\w+(?: as any\))?)\s*\n?\s*\.from\("weather_forecast_cache"\)/g)];
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r[1]).toMatch(/supabaseAdmin/);
  });
});
