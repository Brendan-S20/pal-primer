// A sitter logs what each pet got (#411, the sitter's day): migration
// 20261016130000, the server functions, the generated types, the email
// switch, and the pure rules My Day's sit card reads (src/lib/sit-day.ts).
// tests/integration/care-log.db.test.ts runs the functions against a
// database built from the migrations.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripLineComments } from "./support/sql-migrations";
import {
  CARE_KINDS,
  byTime,
  cleanMissedReason,
  clockMinutes,
  isSitVisit,
  medDueAtVisit,
  sitPets,
  stayProgress,
  unloggedDueMeds,
  type CareEntry,
  type SitFacts,
} from "@/lib/sit-day";

const read = (p: string) => readFileSync(p, "utf8");
const MIG = "supabase/migrations/20261016130000_a-sitter-logs-what-each-pet-got.sql";
const sql = stripLineComments(read(MIG));
const between = (from: string, to: string) => sql.slice(sql.indexOf(from), sql.indexOf(to, sql.indexOf(from)));
const SIG = "uuid, uuid, text, text, text, text, text, timestamptz, uuid";
const recordBody = between("CREATE FUNCTION public.record_care_entry(", "REVOKE ALL ON FUNCTION public.record_care_entry");
const deleteBody = between(
  "CREATE OR REPLACE FUNCTION public.delete_care_entry",
  "REVOKE ALL ON FUNCTION public.delete_care_entry",
);
const factsBody = between("CREATE FUNCTION public.sit_visit_facts", "REVOKE ALL ON FUNCTION public.sit_visit_facts");
const check = sql.slice(sql.lastIndexOf("DO $check$"));

describe("the care log table", () => {
  it("has the columns the design names, with their foreign keys", () => {
    const table = between("CREATE TABLE IF NOT EXISTS public.care_log", ");\n");
    expect(table).toMatch(/visit_id uuid NOT NULL REFERENCES public\.visits\(id\) ON DELETE CASCADE/);
    expect(table).toMatch(/pet_id uuid REFERENCES public\.dogs\(id\) ON DELETE SET NULL/);
    expect(table).toMatch(/organization_id uuid NOT NULL REFERENCES public\.organizations\(id\)/);
    expect(table).toMatch(/given_by uuid REFERENCES public\.staff\(id\)/);
    expect(table).toMatch(/status text NOT NULL DEFAULT 'done'/);
    expect(table).toMatch(/at timestamptz NOT NULL DEFAULT now\(\)/);
    expect(table).toMatch(/created_at timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it("checks the kind, the status, the med name, the missed reason and the note", () => {
    expect(sql).toMatch(/CHECK \(kind IN \('feed', 'meds', 'litter', 'walk', 'water', 'other'\)\)/);
    expect(sql).toMatch(/CHECK \(status IN \('done', 'missed'\)\)/);
    // A med entry names its med; nothing else does.
    expect(sql).toMatch(/kind = 'meds' AND med_name IS NOT NULL AND btrim\(med_name\) <> ''/);
    expect(sql).toMatch(/OR \(kind <> 'meds' AND med_name IS NULL\)/);
    // Missed has a reason up to 300; done has none.
    expect(sql).toMatch(/status = 'missed' AND missed_reason IS NOT NULL AND btrim\(missed_reason\) <> ''/);
    expect(sql).toMatch(/char_length\(missed_reason\) <= 300/);
    expect(sql).toMatch(/OR \(status = 'done' AND missed_reason IS NULL\)/);
    expect(sql).toMatch(/note IS NULL OR char_length\(note\) <= 300/);
  });

  it("matches the kinds the app sends", () => {
    expect([...CARE_KINDS]).toEqual(["feed", "meds", "litter", "walk", "water", "other"]);
  });

  it("has row level security, the two-step policy, and is read only to signed-in users", () => {
    const rls = sql.indexOf("ALTER TABLE public.care_log ENABLE ROW LEVEL SECURITY;");
    expect(rls).toBeGreaterThan(-1);
    expect(sql.indexOf("SELECT public.require_mfa_policy('public.care_log');")).toBeGreaterThan(rls);
    expect(sql).toMatch(/CREATE POLICY "Members read care log" ON public\.care_log\s+FOR SELECT TO authenticated/);
    expect(sql).toMatch(/public\.is_org_member\(\(SELECT auth\.uid\(\)\), organization_id\)/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.care_log FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT SELECT ON TABLE public\.care_log TO authenticated;/);
    // Writes only through the functions: no policy for anything else.
    expect(sql).not.toMatch(/ON public\.care_log\s+FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(sql).not.toMatch(/GRANT [^;]*INSERT[^;]*ON TABLE public\.care_log TO authenticated/);
  });

  it("drops its policy before creating it, so a replay is idempotent", () => {
    const drop = sql.indexOf('DROP POLICY IF EXISTS "Members read care log" ON public.care_log;');
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(sql.indexOf('CREATE POLICY "Members read care log"'));
    expect(sql.indexOf("DROP FUNCTION IF EXISTS public.record_care_entry(")).toBeLessThan(
      sql.indexOf("CREATE FUNCTION public.record_care_entry("),
    );
    expect(sql.indexOf("DROP FUNCTION IF EXISTS public.sit_visit_facts(uuid[]);")).toBeLessThan(
      sql.indexOf("CREATE FUNCTION public.sit_visit_facts"),
    );
  });
});

describe("record_care_entry", () => {
  it("is a definer function with a pinned search_path, returning the row id", () => {
    expect(recordBody).toMatch(
      /record_care_entry\(\s*_visit_id uuid,\s*_pet_id uuid,\s*_kind text,\s*_med_name text,\s*_status text,\s*_missed_reason text,\s*_note text,\s*_at timestamptz DEFAULT NULL,\s*_id uuid DEFAULT NULL\s*\)/,
    );
    expect(recordBody).toMatch(/RETURNS uuid/);
    expect(recordBody).toMatch(/SECURITY DEFINER/);
    expect(recordBody).toMatch(/SET search_path TO 'public', 'pg_temp'/);
  });

  it("lets the assigned sitter or the office write, and nobody else", () => {
    expect(recordBody).toMatch(
      /IF NOT \(public\.is_visit_tech\(auth\.uid\(\), _visit_id\)\s+OR public\.can_write_org\(auth\.uid\(\), _org\)\) THEN\s+RAISE EXCEPTION 'Not authorized for this visit' USING ERRCODE = 'insufficient_privilege'/,
    );
    // Asked before anything is read about the entry, the pet or the clock.
    expect(recordBody.indexOf("is_visit_tech")).toBeLessThan(recordBody.indexOf("FROM public.care_log c"));
  });

  it("is for a pet sitting visit under way, or completed today on the business's clock", () => {
    expect(recordBody).toMatch(/IF _line IS DISTINCT FROM 'pet_sitting' THEN/);
    expect(recordBody).toMatch(/_vstatus = 'in_progress'/);
    expect(recordBody).toMatch(
      /_vstatus = 'completed' AND _completed_at IS NOT NULL\s+AND \(_completed_at AT TIME ZONE COALESCE\(_tz, 'America\/Chicago'\)\)::date = _today/,
    );
  });

  it("refuses a pet from another home", () => {
    expect(recordBody).toMatch(
      /_pet_id IS NOT NULL AND NOT EXISTS \(\s*SELECT 1 FROM public\.dogs d\s+WHERE d\.id = _pet_id AND d\.property_id = _property AND d\.organization_id = _org/,
    );
  });

  it("requires a med name for meds and a reason for missed, and bounds both", () => {
    expect(recordBody).toMatch(/IF _med IS NULL THEN\s+RAISE EXCEPTION 'Name the medication\.'/);
    expect(recordBody).toMatch(/IF _reason IS NULL THEN\s+RAISE EXCEPTION 'Say why it was missed\.'/);
    expect(recordBody).toMatch(/char_length\(_reason\) > 300/);
    expect(recordBody).toMatch(/char_length\(_med\) > 80/);
    expect(recordBody).toMatch(/char_length\(_note_v\) > 300/);
  });

  it("believes no phone clock ahead of the server, nor a queue days old", () => {
    expect(recordBody).toMatch(/IF _when > now\(\) THEN\s+_when := now\(\);/);
    expect(recordBody).toMatch(/IF _when < now\(\) - interval '2 days' THEN/);
  });

  it("returns the same row for a replay, and only for the same visit", () => {
    expect(recordBody).toMatch(/IF _existing IS DISTINCT FROM _visit_id THEN/);
    expect(recordBody).toMatch(/RETURN _id;/);
    expect(recordBody).toMatch(/COALESCE\(_id, gen_random_uuid\(\)\)/);
  });

  it("writes no notification itself: the app tells the office", () => {
    expect(sql).not.toMatch(/INSERT INTO public\.app_notifications/);
  });

  it("is executable by signed-in users and the service role, never anon", () => {
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.record_care_entry(${SIG})\n  FROM PUBLIC, anon;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.record_care_entry(${SIG})\n  TO authenticated, service_role;`);
  });
});

describe("delete_care_entry", () => {
  it("is a definer function with a pinned search_path", () => {
    expect(deleteBody).toMatch(/delete_care_entry\(_id uuid\)/);
    expect(deleteBody).toMatch(/SECURITY DEFINER/);
    expect(deleteBody).toMatch(/SET search_path TO 'public', 'pg_temp'/);
  });

  it("lets the same people undo, within 12 hours", () => {
    expect(deleteBody).toMatch(
      /IF NOT \(public\.is_visit_tech\(auth\.uid\(\), _visit\)\s+OR public\.can_write_org\(auth\.uid\(\), _org\)\) THEN/,
    );
    expect(deleteBody).toMatch(/IF _created < now\(\) - interval '12 hours' THEN/);
    expect(deleteBody.indexOf("interval '12 hours'")).toBeLessThan(deleteBody.indexOf("DELETE FROM public.care_log"));
  });

  it("treats an entry already gone as undone", () => {
    expect(deleteBody).toMatch(/IF _org IS NULL THEN\s+RETURN;/);
  });

  it("is never anon's", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.delete_care_entry\(uuid\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.delete_care_entry\(uuid\) TO authenticated, service_role;/);
  });
});

describe("sit_visit_facts", () => {
  it("answers only for visits the caller works, or the office, and caps the list", () => {
    expect(factsBody).toMatch(/SECURITY DEFINER/);
    expect(factsBody).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    expect(factsBody).toMatch(/STABLE/);
    expect(factsBody).toMatch(
      /public\.is_visit_tech\(auth\.uid\(\), v\.id\)\s+OR public\.can_write_org\(auth\.uid\(\), v\.organization_id\)/,
    );
    expect(factsBody).toMatch(/unnest\(_visit_ids\[1:200\]\)/);
    // Canceled visits are not counted in "Night 2 of 5".
    expect(factsBody).toMatch(/v\.status <> 'canceled'/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.sit_visit_facts\(uuid\[\]\) FROM PUBLIC, anon;/);
  });
});

describe("the email switch", () => {
  it("is on by default", () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.organizations\s+ADD COLUMN IF NOT EXISTS notify_email_missed_meds boolean NOT NULL DEFAULT true;/,
    );
  });

  it("is drawn and saved only for a pet sitting business", () => {
    const page = read("src/routes/_authenticated/settings.emails.tsx");
    expect(page).toMatch(/\.\.\.\(values\.runs_pet_sitting \? SIT_ROWS : \[\]\)/);
    expect(page).toMatch(/\.\.\.\(runs_pet_sitting \? \{ notify_email_missed_meds \} : \{\}\)/);
    const fn = read("src/lib/email-settings.functions.ts");
    expect(fn).toMatch(/runs_pet_sitting: lines\.includes\("pet_sitting"\)/);
    expect(fn).toMatch(/notify_email_missed_meds: z\.boolean\(\)\.optional\(\)/);
    expect(read("src/lib/email/enqueue.server.ts")).toMatch(/\| "notify_email_missed_meds"/);
  });
});

describe("what the migration establishes", () => {
  it("ends by asserting it", () => {
    expect(check).toMatch(/to_regclass\('public\.care_log'\) IS NULL/);
    for (const c of [
      "care_log_kind_check",
      "care_log_status_check",
      "care_log_med_name_fits_kind",
      "care_log_missed_has_reason",
      "care_log_note_length",
    ])
      expect(check, c).toContain(`('${c}')`);
    expect(check).toMatch(/relrowsecurity/);
    expect(check).toMatch(/permissive = 'RESTRICTIVE'/);
    // Counts permissive policies only: the two-step policy is restrictive.
    expect(check).toMatch(/permissive = 'PERMISSIVE'\) <> 1/);
    expect(check).toMatch(/has_table_privilege\('authenticated', 'public\.care_log', 'INSERT, UPDATE, DELETE, TRUNCATE'\)/);
    expect(check).toMatch(/has_function_privilege\('anon', 'public\.record_care_entry/);
    expect(check).toMatch(/has_function_privilege\('anon', 'public\.delete_care_entry\(uuid\)'/);
    expect(check).toMatch(/NOT p\.prosecdef/);
    expect(check).toMatch(/c\.setting LIKE 'search_path=%'/);
    expect(check).toMatch(/notify_email_missed_meds/);
    expect(check.match(/RAISE EXCEPTION/g)?.length).toBeGreaterThanOrEqual(10);
  });

  it("reads function bodies by name, never pg_get_functiondef", () => {
    expect(sql).not.toMatch(/pg_get_functiondef/);
    expect(check).toMatch(/'public\.record_care_entry\(uuid, uuid, text, text, text, text, text, timestamptz, uuid\)'::regprocedure/);
  });

  it("adds no trigger function", () => {
    expect(sql).not.toMatch(/RETURNS trigger/i);
    expect(sql).not.toMatch(/CREATE TRIGGER/i);
  });
});

describe("the server functions and the generated types", () => {
  const fns = read("src/lib/care-log.functions.ts");
  const types = read("src/integrations/supabase/types.ts");

  it("call the RPCs with the device's id, and tell the office of a missed dose", () => {
    expect(fns).toMatch(/\.rpc\("record_care_entry", \{/);
    expect(fns).toMatch(/_id: data\.id,/);
    expect(fns).toMatch(/\.rpc\("delete_care_entry", \{ _id: data\.id \}\)/);
    expect(fns).toMatch(
      /if \(data\.kind === "meds" && data\.status === "missed"\) \{[\s\S]{0,200}notifyMissedMed\(/,
    );
    expect(fns.match(/requireSupabaseAuth/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("know the table, the functions and the column", () => {
    expect(types).toMatch(/care_log: \{/);
    expect(types).toMatch(/record_care_entry: \{/);
    expect(types).toMatch(/delete_care_entry: \{/);
    expect(types).toMatch(/sit_visit_facts: \{/);
    expect(types).toMatch(/notify_email_missed_meds: boolean/);
  });

  it("make missed medication a notification type the office can mute", () => {
    const center = read("src/lib/notifications-center.functions.ts");
    expect(center).toMatch(/\{ type: "missed_meds", label: "A sitter missed a medication" \}/);
    expect(read("src/lib/sit-notify.server.ts")).toMatch(/export const MISSED_MED_TYPE = "missed_meds";/);
  });

  it("ask nothing more of a day with no pet sitting stop", () => {
    const server = read("src/lib/sit-day.server.ts");
    expect(server).toMatch(/if \(ids\.length === 0\) return visits;/);
    expect(server.indexOf("if (ids.length === 0) return visits;")).toBeLessThan(server.indexOf(".rpc("));
  });
});

// ── The pure rules ──────────────────────────────────────────────────────

const facts = (over: Partial<SitFacts> = {}): SitFacts => ({
  visit_id: "v",
  stay_id: "s",
  kind: "drop_in",
  starts_on: "2026-10-19",
  ends_on: "2026-10-23",
  pet_ids: [],
  visit_number: 3,
  visit_total: 10,
  window_earliest: "08:00:00",
  window_latest: "10:00:00",
  ...over,
});

describe("a sit visit", () => {
  it("is a stop whose service is pet sitting, and nothing else", () => {
    expect(isSitVisit({ services: { service_line: "pet_sitting" } })).toBe(true);
    expect(isSitVisit({ services: [{ service_line: "pet_sitting" }] })).toBe(true);
    expect(isSitVisit({ services: { service_line: "pet_waste" } })).toBe(false);
    expect(isSitVisit({ services: { service_line: "dog_walking" } })).toBe(false);
    expect(isSitVisit({ services: null })).toBe(false);
    expect(isSitVisit(null)).toBe(false);
  });

  it("reads as Night n of N for an overnight and Visit n of N for a drop-in", () => {
    expect(stayProgress(facts())).toEqual({ unit: "visit", n: 3, total: 10 });
    expect(stayProgress(facts({ kind: "overnight", visit_number: 2, visit_total: 5 }))).toEqual({
      unit: "night",
      n: 2,
      total: 5,
    });
    expect(stayProgress(facts({ visit_number: null }))).toBeNull();
    expect(stayProgress(facts({ visit_number: 6, visit_total: 5 }))).toBeNull();
    expect(stayProgress(null)).toBeNull();
  });

  it("is for the stay's pets when it names them, otherwise the active pets at home", () => {
    const rows = [
      { id: "a", name: " Luna ", species: "cat", active: true },
      { id: "b", name: "Max", species: "dog", active: true },
      { id: "c", name: "Old", species: "lizard", active: false },
    ];
    expect(sitPets(rows, facts({ pet_ids: ["a"] })).map((p) => p.id)).toEqual(["a"]);
    expect(sitPets(rows, facts()).map((p) => p.id)).toEqual(["a", "b"]);
    const [luna] = sitPets(rows, null);
    expect(luna).toMatchObject({ name: "Luna", species: "cat", care: null });
    // An unknown species reads as a dog, as it did before species existed.
    expect(sitPets(rows, facts({ pet_ids: ["c"] }))[0].species).toBe("dog");
  });
});

describe("a med due at this visit", () => {
  it("reads clock times", () => {
    expect(clockMinutes("08:05")).toBe(485);
    expect(clockMinutes("08:05:00")).toBe(485);
    expect(clockMinutes("8:05")).toBeNull();
    expect(clockMinutes(null)).toBeNull();
  });

  it("is due within an hour of a drop-in's window", () => {
    const w = { earliest: "08:00", latest: "10:00" };
    expect(medDueAtVisit(["07:00"], w, false)).toBe(true);
    expect(medDueAtVisit(["11:00"], w, false)).toBe(true);
    expect(medDueAtVisit(["06:59"], w, false)).toBe(false);
    expect(medDueAtVisit(["11:01"], w, false)).toBe(false);
    expect(medDueAtVisit(["20:00"], w, false)).toBe(false);
  });

  it("covers the evening and the next morning for an overnight", () => {
    const w = { earliest: "19:00", latest: "21:00" };
    expect(medDueAtVisit(["18:00"], w, true)).toBe(true);
    expect(medDueAtVisit(["23:30"], w, true)).toBe(true);
    expect(medDueAtVisit(["07:00"], w, true)).toBe(true);
    expect(medDueAtVisit(["14:00"], w, true)).toBe(false);
  });

  it("is never due as needed, nor with no window to compare", () => {
    expect(medDueAtVisit([], { earliest: "08:00", latest: "10:00" }, false)).toBe(false);
    expect(medDueAtVisit(["08:00"], null, false)).toBe(false);
  });
});

describe("the warning before the visit ends", () => {
  const pets = sitPets(
    [
      {
        id: "luna",
        name: "Luna",
        species: "cat",
        pet_care_instructions: {
          feeding: null,
          meds: [
            { name: "Insulin", dose: "2 units", times: ["08:00"] },
            { name: "Drops", times: [] },
            { name: "Evening pill", times: ["20:00"] },
          ],
          other_care: null,
        },
      },
    ],
    null,
  );
  const entry = (over: Partial<CareEntry>): CareEntry => ({
    id: "e",
    pet_id: "luna",
    kind: "meds",
    med_name: "Insulin",
    status: "done",
    missed_reason: null,
    at: "2026-10-19T13:00:00Z",
    ...over,
  });

  it("names each due dose nobody logged, and no other", () => {
    expect(unloggedDueMeds(pets, [], facts())).toEqual([
      { petId: "luna", petName: "Luna", medName: "Insulin" },
    ]);
  });

  it("is satisfied by a dose given or missed, whatever its case", () => {
    expect(unloggedDueMeds(pets, [entry({ med_name: "insulin" })], facts())).toEqual([]);
    expect(
      unloggedDueMeds(pets, [entry({ status: "missed", missed_reason: "Hid" })], facts()),
    ).toEqual([]);
    // Logged for another pet, it is still missing for this one.
    expect(unloggedDueMeds(pets, [entry({ pet_id: "max" })], facts())).toHaveLength(1);
  });

  it("says nothing when the visit has no stay window", () => {
    expect(unloggedDueMeds(pets, [], null)).toEqual([]);
  });

  it("is a warning on the card, never a block on ending the visit", () => {
    const page = read("src/routes/_authenticated/my-day.tsx");
    const complete = page.slice(page.indexOf("const complete = useMutation"), page.indexOf("onSuccess:", page.indexOf("const complete = useMutation")));
    expect(complete).not.toMatch(/unloggedDueMeds|medNotLogged/);
  });
});

describe("the log's small rules", () => {
  it("lists entries oldest first", () => {
    const e = (id: string, at: string) =>
      ({ id, at, pet_id: null, kind: "feed", med_name: null, status: "done", missed_reason: null }) as CareEntry;
    expect(byTime([e("b", "2026-10-19T10:00:00Z"), e("a", "2026-10-19T09:00:00Z")]).map((x) => x.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("trims a missed reason, and an empty one is none", () => {
    expect(cleanMissedReason("  Hid  ")).toBe("Hid");
    expect(cleanMissedReason("   ")).toBeNull();
    expect(cleanMissedReason("x".repeat(400))).toHaveLength(300);
  });
});
