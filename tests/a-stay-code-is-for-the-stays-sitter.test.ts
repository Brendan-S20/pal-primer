// A stay's codes are for the stay's sitter, during the stay (#411 review,
// blocker 2). The window the sit card uses, and the shape of the reads: the
// database half is tests/integration/stay-access.db.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stayAccessOpen, stayAccessWindow, stayDays } from "@/lib/stays";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const sql = read("supabase/migrations/20261017010000_a-stay-code-is-for-the-stays-sitter.sql");

describe("the access window", () => {
  it("runs from the day before the first visit to the last visit day", () => {
    expect(stayAccessWindow(["2026-10-21", "2026-10-19", "2026-10-20"])).toEqual({
      from: "2026-10-18",
      through: "2026-10-21",
    });
    // Overnight Mon 19 -> checkout Sat 24: nights 19..23.
    expect(stayAccessWindow(stayDays("overnight", "2026-10-19", "2026-10-24"))).toEqual({
      from: "2026-10-18",
      through: "2026-10-23",
    });
    expect(stayAccessWindow([])).toBeNull();
  });

  it("is open on both ends and closed outside them", () => {
    const w = { from: "2026-10-18", through: "2026-10-21" };
    expect(stayAccessOpen("2026-10-17", w)).toBe(false);
    expect(stayAccessOpen("2026-10-18", w)).toBe(true);
    expect(stayAccessOpen("2026-10-21", w)).toBe(true);
    expect(stayAccessOpen("2026-10-22", w)).toBe(false);
    expect(stayAccessOpen("2026-10-19", null)).toBe(false);
  });
});

describe("the database reads", () => {
  const body = (name: string) => {
    const at = sql.indexOf(`FUNCTION public.${name}(`);
    return sql.slice(at, sql.indexOf("$function$;", at));
  };

  it("stay_access_codes checks the office, the active sitter and the window, and logs every row", () => {
    const fn = body("stay_access_codes");
    expect(fn).toMatch(/public\.can_write_org\(_uid, st\.organization_id\)/);
    expect(fn).toMatch(/AND sf\.active\b/);
    expect(fn).toMatch(/BETWEEN w\.first_day - 1 AND w\.last_day/);
    expect(fn).toMatch(/INSERT INTO public\.activity_log/);
    expect(fn).toMatch(/'stay\.access_viewed'/);
    expect(fn).toMatch(/WHERE st\.status <> 'canceled'/);
  });

  it("20261017060000 keeps the window for the stay's sitter, gives a covering sitter their day, and checks the office as walking does", () => {
    const next = read("supabase/migrations/20261017060000_a-covering-sitter-sees-codes-on-their-days.sql");
    const at = next.indexOf("FUNCTION public.stay_access_codes(");
    const fn = next.slice(at, next.indexOf("$function$;", at));
    expect(fn).not.toMatch(/can_write_org/);
    expect(fn).toMatch(/public\.has_permission\(_uid, st\.organization_id, 'view_client_directory'\)/);
    expect(fn).toMatch(/sf\.id = st\.assigned_staff_id/);
    expect(fn).toMatch(/BETWEEN w\.first_day - 1 AND w\.last_day/);
    expect(fn).toMatch(/v\.scheduled_on = t\.today/);
    expect(fn).toMatch(/INSERT INTO public\.activity_log/);
    expect(next).toMatch(/REVOKE ALL ON FUNCTION public\.stay_access_codes\(uuid\[\]\) FROM PUBLIC, anon;/);
  });

  it("a stay visit no longer opens property_access_codes", () => {
    expect(body("property_access_codes")).toMatch(/sub\.stay_id IS NOT NULL/);
  });

  // 20261015215000 moved the gate code behind property_access_codes. This file
  // drops and remakes that function, so the last definition decides whether
  // anyone signed in can read the gate code at all.
  it("the last property_access_codes still returns the gate code", () => {
    const dir = join(ROOT, "supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const defining = files.filter((f) =>
      /CREATE (OR REPLACE )?FUNCTION public\.property_access_codes\(/.test(readFileSync(join(dir, f), "utf8")),
    );
    const last = readFileSync(join(dir, defining[defining.length - 1]), "utf8");
    const at = last.indexOf("FUNCTION public.property_access_codes(");
    const fn = last.slice(at, last.indexOf("$function$;", at));
    expect(fn).toMatch(/RETURNS TABLE \(property_id uuid, gate_code text,/);
    expect(fn).toMatch(/SELECT p\.id, p\.gate_code,/);
  });

  it("no migration after the revoke grants SELECT on the whole properties table again", () => {
    const dir = join(ROOT, "supabase/migrations");
    const later = readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && f > "20261015215000_a-lock-box-code-is-for-the-assigned-day.sql")
      .sort();
    for (const f of later)
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(
        /GRANT\s+(SELECT|ALL)[^;(]*\bON\s+(TABLE\s+)?(public\.)?properties\b[^;]*\b(authenticated|anon|PUBLIC)\b/i,
      );
  });

  it("keeps both reads off anon and leaves alarm_notes ungranted", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.stay_access_codes\(uuid\[\]\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.property_access_codes\(uuid\[\]\) FROM PUBLIC, anon;/);
    expect(sql).not.toMatch(/GRANT SELECT \([^)]*alarm_notes/);
  });
});

describe("the sit card", () => {
  it("reads a stay's codes through stay_access_codes and replaces whatever else is on the property", () => {
    const server = read("src/lib/sit-day.server.ts");
    expect(server).toMatch(/rpc\("stay_access_codes"/);
    for (const col of ["gate_code", "lock_box_code", "key_location", "key_tag", "alarm_notes"])
      expect(server).toMatch(new RegExp(`${col}: c\\?\\.${col} \\?\\? null`));
  });

  it("the day's query never selects alarm_notes or the gate code", () => {
    for (const rel of ["src/lib/my-day.functions.ts", "src/lib/properties.functions.ts", "src/lib/clients.functions.ts"])
      expect(read(rel)).not.toMatch(/select\([^)]*alarm_notes/);
    expect(read("src/lib/my-day.functions.ts")).not.toMatch(/\bgate_code\b/);
  });
});
