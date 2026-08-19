// Two permissive policies for the same role and the same command is an OR
// that Postgres pays for twice.
//
// A PERMISSIVE row-level-security policy is a disjunct. When two of them apply
// to one role and one command, both are evaluated for every row the scan
// touches and the row is returned if either says yes — neither can be skipped,
// because until both have run it is not known which one let the row through.
//
// The performance advisor found 48 of these, which resolve to 43 colliding
// PAIRS across 38 tables. Nobody wrote a duplicate deliberately. They came out
// of a convention followed almost everywhere in this schema — one read policy
// and one write policy per table:
//
//     create policy "Members read visits"   ... for select using (is_org_member(...));
//     create policy "Managers write visits" ... for all    using (can_write_org(...));
//
// `FOR ALL` is all four commands, and that includes SELECT. So the policy
// written to describe who may WRITE quietly joined the read path, and every
// read of `visits` called `can_write_org()` once per row to produce a subset of
// what `is_org_member()` had already returned.
//
// Measured on production before the fix, 3,013 rows visible to an org owner,
// four passes alternating which shape ran first so neither always got the warm
// cache: 104.5 ms with both SELECT policies, 89.1 ms with one. Fifteen percent
// — worth having because it is linear in rows scanned and paid on every read by
// every tenant, not because fifteen percent is a lot.
//
// ── WHY THIS IS A RULE AND NOT A LIST OF 43 NAMES ─────────────────────────
//
// The same reason as the `auth.uid()` rule next door: a list passes forever
// while the 44th pair is being written. And this is a mistake with no local
// symptom at all. Adding a `FOR ALL` policy beside an existing `FOR SELECT`
// one does not fail a test, does not change a single query result, and does
// not look wrong in review — the diff is one correct-looking policy. It just
// makes every read of that table permanently slower.
//
// So the rule is structural: NO two permissive policies on one table in
// `public` may overlap in both command and role.
//
// ── THE PART THAT MAKES THE RULE HONEST ───────────────────────────────────
//
// It cannot grep. The 20260810120000 migration drops 45 policies and creates
// 117, and every migration that originally created the dropped ones still
// contains its CREATE and always will — history is not edited here. A grep
// would report the pre-fix world forever.
//
// So it replays. Every CREATE / ALTER / DROP POLICY across the whole directory
// in filename order, folded into a map keyed by schema.table.policy, which is
// what the database does when the migrations are applied in order.
//
// One thing this replay has to do that the `auth.uid()` rule did not: MERGE
// rather than overwrite. `ALTER POLICY x ON t USING (...)` changes the
// expression and leaves the command and the roles alone, and 20260809200000
// altered 140 policies that way. Taking the last statement whole would leave
// almost every policy in the schema with no recorded command — and a rule that
// cannot see a command cannot see a collision, so it would pass on everything.
// Each verb therefore updates only the fields it names.
//
// ── `public` IS NOT A ROLE BESIDE THE OTHERS ──────────────────────────────
//
// It is all of them. Comparing role sets by name gets 32 of the 38 tables and
// silently misses the other six — `clients`, `dogs`, `properties`, `staff`,
// `addon_services`, `subscriptions` — where the read policy was granted TO
// public and the write policy TO authenticated, or the reverse. That was the
// first version of this rule, and it agreed with itself while disagreeing with
// the advisor by exactly six. `public` intersects everything.
//
// ── WHAT IT DELIBERATELY DOES NOT COVER ───────────────────────────────────
//
// RESTRICTIVE policies. They AND rather than OR, so two of them are not
// redundant work in the same way and Postgres has to run both regardless.
// There are none in `public` today; the filter is there so that adding one is
// not mistaken for a violation.
//
// And `storage.objects`, for the same reason the auth rule leaves it alone:
// those policies are managed through the Supabase dashboard and are not this
// repo's to rewrite.

import { describe, expect, it } from "vitest";
import {
  IDENT,
  migrationFiles,
  readMigration,
  statements,
  stripLineComments,
  unquote,
} from "./support/sql-migrations";

const THIS_MIGRATION =
  "20260810120000_forty-three-pairs-of-policies-asked-the-same-question-twice.sql";

const ALL_COMMANDS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
type Command = (typeof ALL_COMMANDS)[number];

type Policy = {
  schema: string;
  table: string;
  name: string;
  permissive: boolean;
  commands: Command[];
  roles: string[];
  file: string;
};

const HEAD = new RegExp(
  String.raw`^(CREATE|ALTER|DROP)\s+POLICY\s+(?:IF\s+EXISTS\s+)?${IDENT}\s+ON\s+(?:${IDENT}\s*\.\s*)?${IDENT}`,
  "is",
);

/** `AS RESTRICTIVE` / `AS PERMISSIVE`, CREATE only. Absent means permissive. */
const AS_CLAUSE = /\bAS\s+(PERMISSIVE|RESTRICTIVE)\b/i;

/** `FOR SELECT` etc, CREATE only. Absent means ALL. Anchored on the word so
 *  it cannot match the `for` inside a policy NAME, which is why it runs
 *  against the statement with the head already sliced off. */
const FOR_CLAUSE = /\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i;

/** `TO a, b, c` up to the next keyword. Valid on CREATE and on ALTER. */
const TO_CLAUSE = new RegExp(
  String.raw`\bTO\s+((?:${IDENT}|CURRENT_USER|SESSION_USER|PUBLIC)(?:\s*,\s*(?:${IDENT}|CURRENT_USER|SESSION_USER|PUBLIC))*)`,
  "is",
);

/** Replay the directory and return every policy that still exists, with the
 *  command and role set it ends up with. */
function effectivePolicies(): Policy[] {
  const map = new Map<string, Policy>();

  for (const file of migrationFiles()) {
    for (const st of statements(stripLineComments(readMigration(file)))) {
      const head = HEAD.exec(st);
      if (!head) continue;
      const [matched, verb, rawPolicy, rawSchema, rawTable] = head;
      const schema = rawSchema ? unquote(rawSchema) : "public";
      const table = unquote(rawTable);
      const name = unquote(rawPolicy);
      const key = `${schema}.${table}.${name}`;

      if (verb.toUpperCase() === "DROP") {
        map.delete(key);
        continue;
      }

      // Everything after `... ON table` — the head is skipped so a policy
      // NAME containing "for" or "to" cannot be read as a clause.
      const tail = st.slice(matched.length);
      const to = TO_CLAUSE.exec(tail);
      const roles = to ? to[1].split(",").map((r) => unquote(r.trim()).toLowerCase()) : undefined;

      if (verb.toUpperCase() === "CREATE") {
        const forClause = FOR_CLAUSE.exec(tail)?.[1]?.toUpperCase() ?? "ALL";
        map.set(key, {
          schema,
          table,
          name,
          permissive: (AS_CLAUSE.exec(tail)?.[1] ?? "PERMISSIVE").toUpperCase() === "PERMISSIVE",
          commands: forClause === "ALL" ? [...ALL_COMMANDS] : [forClause as Command],
          // No TO clause on a CREATE means PUBLIC, which is every role.
          roles: roles ?? ["public"],
          file,
        });
        continue;
      }

      // ALTER: merge. It may carry TO and/or USING and/or WITH CHECK, and it
      // can never change the command. Anything it does not name is untouched.
      const prev = map.get(key);
      if (!prev) continue; // altering something this directory never created
      map.set(key, { ...prev, roles: roles ?? prev.roles, file });
    }
  }

  return [...map.values()];
}

const rolesOverlap = (a: string[], b: string[]): boolean =>
  a.includes("public") || b.includes("public") || a.some((r) => b.includes(r));

type Collision = { table: string; a: Policy; b: Policy; on: Command[] };

function collisions(policies: Policy[]): Collision[] {
  const out: Collision[] = [];
  const inPublic = policies
    .filter((p) => p.schema === "public" && p.permissive)
    .sort((x, y) => (x.table + x.name < y.table + y.name ? -1 : 1));

  for (let i = 0; i < inPublic.length; i++) {
    for (let j = i + 1; j < inPublic.length; j++) {
      const a = inPublic[i];
      const b = inPublic[j];
      if (a.table !== b.table) continue;
      if (!rolesOverlap(a.roles, b.roles)) continue;
      const on = a.commands.filter((c) => b.commands.includes(c));
      if (on.length) out.push({ table: a.table, a, b, on });
    }
  }
  return out;
}

describe("no table in public asks the same question twice per row", () => {
  it("reconstructs the policy surface rather than passing on an empty set", () => {
    const all = effectivePolicies();
    const inPublic = all.filter((p) => p.schema === "public");

    // 222 policies live in pg_policy in `public` after 20260810120000. Nine of
    // them — the `Service role can …` policies on the four email tables — have
    // no CREATE anywhere in this directory; they arrived in the 2026-07-09
    // consolidated bootstrap that scripts/check-migrations.mjs already records
    // as applied under names the filenames do not match, and their first
    // appearance here is the ALTER that wrapped their auth call. So the replay
    // can see at most 213, and if it silently stopped matching this collapses
    // long before the rule below gets to report success on nothing.
    expect(inPublic.length).toBeGreaterThanOrEqual(213);
    expect(all.length).toBeGreaterThan(inPublic.length); // storage is seen too
  });

  it("recovers a command for every policy, not just for the ones never altered", () => {
    // The failure this guards against: `ALTER POLICY x ON t USING (...)`
    // overwriting the CREATE and taking the command with it. 140 policies were
    // altered that way in 20260809200000, so a replay that overwrites leaves
    // most of the schema command-less — and a rule that cannot see a command
    // reports zero collisions on everything.
    const inPublic = effectivePolicies().filter((p) => p.schema === "public");
    const commandless = inPublic.filter((p) => p.commands.length === 0);
    expect(commandless).toEqual([]);

    // And the roles survive the same way. Every policy in this schema is
    // granted to something; none should come back with an empty set.
    expect(inPublic.filter((p) => p.roles.length === 0)).toEqual([]);
  });

  it("leaves no two permissive policies overlapping in both command and role", () => {
    const found = collisions(effectivePolicies());
    const named = found.map(
      (c) =>
        `${c.table}: "${c.a.name}" + "${c.b.name}" — both apply to ${c.on.join("/")} ` +
        `for ${[...new Set([...c.a.roles, ...c.b.roles])].join(", ")} ` +
        `(last touched in ${c.a.file} and ${c.b.file})`,
    );

    expect(
      named,
      named.length
        ? `each of these tables evaluates two permissive policies for every row.\n` +
            `Either narrow the FOR ALL policy to the commands it was written for\n` +
            `(insert/update/delete), or merge the two predicates with OR into one\n` +
            `policy — see 20260810120000 for both shapes and when each applies:\n` +
            named.map((n) => `  ${n}`).join("\n")
        : "",
    ).toEqual([]);
  });

  it("still sees the storage policies it deliberately does not police", () => {
    // Named rather than silent: if these move, the exemption in the header
    // gets re-read instead of rotting.
    const storage = effectivePolicies().filter((p) => p.schema === "storage");
    expect(storage.length).toBeGreaterThan(0);
  });

  it("treats public as overlapping every role, which is the whole of six tables", () => {
    const p = (roles: string[], commands: Command[]): Policy => ({
      schema: "public",
      table: "t",
      name: roles.join("+") + commands.join(""),
      permissive: true,
      commands,
      roles,
      file: "x.sql",
    });
    // The six that a name-equality comparison misses.
    expect(collisions([p(["public"], ["SELECT"]), p(["authenticated"], ["SELECT"])])).toHaveLength(
      1,
    );
    // Different commands on overlapping roles is not a collision.
    expect(
      collisions([p(["authenticated"], ["SELECT"]), p(["authenticated"], ["INSERT"])]),
    ).toEqual([]);
    // Nor is the same command on genuinely disjoint roles.
    expect(collisions([p(["anon"], ["SELECT"]), p(["authenticated"], ["SELECT"])])).toEqual([]);
    // Restrictive policies AND rather than OR, so they are not this defect.
    expect(
      collisions([
        { ...p(["authenticated"], ["SELECT"]), permissive: false },
        p(["authenticated"], ["SELECT"]),
      ]),
    ).toEqual([]);
  });
});

describe("the migration that did it proves itself rather than asserting", () => {
  const migration = () => stripLineComments(readMigration(THIS_MIGRATION));

  it("drops 45 policies and writes 117, which is where 222 comes from", () => {
    const sql = migration();
    expect((sql.match(/^drop policy/gim) ?? []).length).toBe(45);
    expect((sql.match(/^create policy/gim) ?? []).length).toBe(117);
    // 150 live before, 150 - 45 + 117 = 222, which $post$ asserts against the
    // catalog rather than against this arithmetic.
    expect(readMigration(THIS_MIGRATION)).toMatch(/expected 222 policies in public/);
  });

  it("measures reachability for every caller before and after, and compares", () => {
    const sql = readMigration(THIS_MIGRATION);
    expect(sql).toMatch(/do \$pre\$/i);
    expect(sql).toMatch(/do \$post\$/i);
    // The subset claim the 32 rest on, counted rather than argued.
    expect(sql).toMatch(/reachable only through a write policy/);
    // The comparison that catches a dropped disjunct or a typo in a merge.
    expect(sql).toMatch(/reachability changed for someone/);
    // Guards against both halves passing on nothing. These were exceptions
    // until the Sandboxes replay reached this file: a database built from the
    // migrations has no rows in user_roles or platform_admins, so it has one
    // caller and the sample really is too small — which is what the guards say,
    // and refusing to apply is not. They are warnings now, and the wording
    // pinned here is the wording they carry.
    //
    // What the downgrade did NOT touch is the assertion each guard protects.
    // `reachability changed for someone` above is still an exception, and it
    // cannot report a false pass on an empty database: with no rows there is
    // nothing that can differ.
    expect(sql).toMatch(/too few callers in this database to mean anything/);
    expect(sql).toMatch(/too few callers in this database for the comparison to mean anything/);
    expect(sql).toMatch(/raise exception 'reachability changed for someone/);
  });

  it("keeps the two tables that must not get an (insert) policy without one", () => {
    // inventory_movements and waste_disposal_manifests already carry an INSERT
    // policy checking is_org_member, which is wider than the can_write_org in
    // the FOR ALL policy they replaced. Creating an `(insert)` for them would
    // re-create the duplicate this migration exists to remove.
    const sql = migration();
    for (const t of ["inventory_movements", "waste_disposal_manifests"]) {
      const forTable =
        sql.match(new RegExp(String.raw`^create policy[^;]*on public\.${t}\b`, "gim")) ?? [];
      expect(forTable.length, `${t} should get update and delete only`).toBe(2);
      expect(sql).not.toMatch(new RegExp(String.raw`\(insert\)"[^;]*on public\.${t}\b`, "i"));
    }
  });

  it("does not widen anything while it is in there", () => {
    const sql = migration();
    // Every new predicate is either carried over verbatim or an OR of two that
    // already applied. `true` as a whole predicate would be neither.
    expect(sql).not.toMatch(/^\s*(using|with check)\s*\(\s*true\s*\)/im);
    // And it stays in its lane: no grants, no indexes, no table changes.
    expect(sql).not.toMatch(/\bgrant\b/i);
    expect(sql).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(sql).not.toMatch(/alter\s+table/i);
  });

  it("names every policy inside the 63 bytes an identifier gets", () => {
    // Postgres truncates policy names at NAMEDATALEN. The first draft had two
    // org_platform_addons names that differed only after byte 63; the second
    // CREATE failed with "already exists" naming a policy that appears nowhere
    // in the file. Checked here so the next long name fails in the test rather
    // than halfway through a migration.
    const names = [
      ...migration().matchAll(/^create policy\s+("(?:[^"]|"")+"|[A-Za-z_][\w$]*)/gim),
    ].map((m) => unquote(m[1]));
    expect(names.length).toBe(117);
    const tooLong = names.filter((n) => Buffer.byteLength(n) > 63);
    expect(tooLong).toEqual([]);
    const truncated = names.map((n) => Buffer.from(n).subarray(0, 63).toString());
    expect(new Set(truncated).size, "two names collide once Postgres truncates them").toBe(
      names.length,
    );
  });
});
