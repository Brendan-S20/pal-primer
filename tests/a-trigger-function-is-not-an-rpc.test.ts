// Thirty-four functions nobody can usefully call were granted to everybody who signs in.
//
// Every function in `public` whose return type is `trigger` carried EXECUTE for
// `authenticated`. They arrived that way one at a time, because `CREATE
// FUNCTION` in this schema grants to PUBLIC and the July `ALTER DEFAULT
// PRIVILEGES` meant to stop that demonstrably does not — the same mechanism
// documented at length in
// `the-lockdown-that-only-held-for-the-functions-that-existed-that-day`.
//
// ── THE CLAIM THE WHOLE CHANGE RESTS ON ───────────────────────────────────
//
// That revoking EXECUTE does not stop the trigger firing. Postgres checks
// EXECUTE on a trigger function when the trigger is CREATED, against the
// creating role; firing it as part of an INSERT or UPDATE does not re-check it
// against the caller. Believed from the documentation, then proved on the live
// database in a rolled-back transaction, because "the docs say so" is not the
// same as "this database does so": a temporary table, a SECURITY DEFINER
// trigger function owned by postgres with EXECUTE revoked from
// `authenticated`, and an INSERT run as `authenticated`.
//
//   trigger fired with EXECUTE revoked: OK, touched=true
//   direct call refused: permission denied for function _probe_tg
//
// ── WHY IT IS THIRTY-FOUR AND NOT THE ADVISOR'S TWENTY-FOUR ───────────────
//
// The Supabase security advisor reports 24, because it only looks at SECURITY
// DEFINER functions. The other ten are identical doors it does not mention:
// `set_updated_at`, `tg_touch_updated_at`, `tg_client_holds_validate`,
// `tg_client_notes_touch`, `tg_dogs_name_validate`,
// `tg_properties_derive_yard_size`, `tg_staff_field_flag`,
// `tg_waste_stations_number`, and — the reason the rule is by return type
// rather than by name — `apply_inventory_movement` and
// `recalc_visit_station_count`, two trigger functions that predate the `tg_`
// convention and that a `tg_%` sweep would have walked straight past.
//
// Closing 24 and leaving 10 because of where a linter's attention fell is how
// a list stops meaning anything, which is the entire argument of the lockdown
// file this one sits beside.
//
// ── WHAT THIS FILE CHECKS, AND WHAT IT CANNOT ─────────────────────────────
//
// It checks that the migration exists, revokes all 34 by name, and asserts its
// own preconditions and result from the catalog rather than trusting them. It
// cannot check the live grant — that is what the migration's own `$post$`
// block is for, and it fails the migration rather than a test run.
//
// The durable half is the last rule below: a NEW trigger function added later
// must carry its own REVOKE, or this fails naming it. Without that, thirty-four
// becomes thirty-five the first time somebody writes a trigger.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  migrationFiles,
  readMigration,
  statements,
  stripLineComments,
} from "./support/sql-migrations";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const THIS_MIGRATION = "20260812190000_a-trigger-function-is-not-an-rpc.sql";

/** Every trigger function this directory creates: a CREATE FUNCTION whose
 *  return type is `trigger` OR `event_trigger`. Replayed across the whole
 *  history, last write winning, because a function re-created later is still
 *  one function.
 *
 *  BOTH kinds, and that is the correction. 20260812190000 keyed its catalog
 *  predicate on `prorettype = 'trigger'::regtype`, which does not match
 *  `event_trigger` — a separate type, not a variant — so it left
 *  `rls_auto_enable` executable by `authenticated` on the same day it closed
 *  the other thirty-four. 20260812210000 revokes it, and this regex is why the
 *  NEXT one cannot slip through the same crack. */
function triggerFunctions(): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of migrationFiles()) {
    for (const st of statements(stripLineComments(readMigration(file)))) {
      const m =
        /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(\s*\)\s*RETURNS\s+(?:event_)?trigger\b/i.exec(
          st,
        );
      if (m) map.set(m[1].toLowerCase(), file);
      const d = /^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?public\.([a-z0-9_]+)\s*\(\s*\)/i.exec(st);
      if (d) map.delete(d[1].toLowerCase());
    }
  }
  return map;
}

/** Functions this migration revokes from `authenticated`. */
function revokedHere(): Set<string> {
  const out = new Set<string>();
  for (const st of statements(stripLineComments(readMigration(THIS_MIGRATION)))) {
    const m =
      /^REVOKE\s+(?:ALL|EXECUTE)[^;]*?\bON\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\(\s*\)\s*FROM\s+([^;]*)$/i.exec(
        st,
      );
    if (m && /\bauthenticated\b/i.test(m[2])) out.add(m[1].toLowerCase());
  }
  return out;
}

/** Every REVOKE of a no-argument function from `authenticated`, anywhere in the
 *  directory — so a trigger function closed by some later migration still
 *  counts as closed. */
function revokedAnywhere(): Set<string> {
  const out = new Set<string>();
  for (const file of migrationFiles()) {
    for (const st of statements(stripLineComments(readMigration(file)))) {
      const m =
        /^REVOKE\s+(?:ALL|EXECUTE)[^;]*?\bON\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\(\s*\)\s*FROM\s+([^;]*)$/i.exec(
          st,
        );
      if (m && /\b(authenticated|PUBLIC)\b/i.test(m[2])) out.add(m[1].toLowerCase());
    }
  }
  return out;
}

describe("no trigger function is executable by a signed-in user", () => {
  it("finds the trigger functions rather than passing on an empty set", () => {
    // Thirty-six: the thirty-five row-trigger functions plus the one event
    // trigger function, `rls_auto_enable`. The same thirty-six the catalog
    // holds — unusually, this repo creates every one of them in a tracked
    // migration, so the replay and the database agree with nothing left over.
    // (Not true of policies or of every function: the 2026-07-09 consolidated
    // bootstrap left other objects under names the filenames do not match.)
    // A parser that quietly stopped matching would report zero and look green.
    //
    // 35 -> 36 on 2026-08-25: visits_guard_privileged_columns, which stops a
    // technician repointing their own visit at another customer. It carries
    // its own REVOKE, so the durable rule below — "leaves no trigger function
    // this directory creates still open" — passed without being touched. This
    // number is the deliberate speed bump that makes you say so.
    //
    // 36 -> 37 on 2026-09-28: invoices_assign_number, which gives each
    // invoice its organization's next INV number and keeps it from changing.
    // It also carries its own REVOKE from PUBLIC, anon and authenticated.
    //
    // 37 -> 39 on 2026-09-28 (20260928170000, quotes): quotes_before_write,
    // which numbers a quote and keeps its references inside the tenant, and
    // quotes_guard_answer, which keeps a sent quote as sent and lets only the
    // customer's link accept or decline it. Both carry their own REVOKE from
    // PUBLIC, anon and authenticated.
    //
    // 39 -> 40 on 2026-09-29 (20260929110000, sales tax): tg_payments_tax_share,
    // which fills a payment's sales-tax share from its invoice on every write.
    // It carries its own REVOKE from PUBLIC, anon and authenticated.
    //
    // 40 -> 47 on 2026-09-29 (20260929080000, outbound webhooks):
    // webhook_endpoints_before_update, which keeps an endpoint's failure
    // counters in step with its switch, and six emitters that write the
    // webhook outbox on a transition -- webhook_emit_client, _visit,
    // _invoice, _payment, _quote and _lead. All seven carry their own REVOKE
    // from PUBLIC, anon and authenticated.
    //
    // 47 -> 48 on 2026-10-02 (20261002090200, the routing trials):
    // tg_properties_coordinates_are_a_place, which stores 0,0 and an
    // off-the-globe coordinate as NULL -- "no location" -- instead of a point
    // in the Gulf of Guinea that refused a whole day's routing. It carries its
    // own REVOKE from PUBLIC, anon and authenticated.
    expect(triggerFunctions().size).toBe(48);
  });

  it("revokes all thirty-four row-trigger functions, by return type and not by name", () => {
    const revoked = revokedHere();
    expect(revoked.size).toBe(34);
    // The two that a `tg_%` sweep would have missed, named so the reason for
    // the rule's shape survives.
    expect(revoked.has("apply_inventory_movement")).toBe(true);
    expect(revoked.has("recalc_visit_station_count")).toBe(true);
    // And the ten the advisor never mentions, one of them checked by name.
    expect(revoked.has("set_updated_at")).toBe(true);
  });

  it("leaves no trigger function this directory creates still open", () => {
    // The durable half. A trigger function added tomorrow without its own
    // REVOKE fails here, named.
    const closed = revokedAnywhere();
    const open = [...triggerFunctions().entries()]
      .filter(([fn]) => !closed.has(fn))
      .map(([fn, file]) => `public.${fn}() — created in ${file}`);
    expect(
      open,
      open.length
        ? `a trigger function is not an RPC: revoke EXECUTE from PUBLIC, anon ` +
            `and authenticated in the migration that creates it. Firing a ` +
            `trigger does not check the caller's EXECUTE, so this costs ` +
            `nothing and closes a door nobody can use:\n` +
            open.map((o) => `  ${o}`).join("\n")
        : "",
    ).toEqual([]);
  });
});

describe("the correction: the rule said trigger, and Postgres has two kinds", () => {
  const FILE = "20260812210000_the-rule-said-trigger-and-postgres-has-two-kinds.sql";

  it("closes the event trigger function the first rule's predicate missed", () => {
    // `prorettype = 'trigger'::regtype` does not match `event_trigger`. A
    // separate type, not a variant — which is how a rule written to close
    // exactly this class left one open on the day it shipped.
    const sql = stripLineComments(readMigration(FILE));
    expect(sql).toMatch(
      /revoke all on function public\.rls_auto_enable\(\) from public, anon, authenticated/i,
    );
    expect(sql).toMatch(/'pg_catalog\.event_trigger'::regtype/);
  });

  it("proves the event trigger still fires, which is the risk that mattered", () => {
    // rls_auto_enable is what keeps a new table from shipping without RLS. A
    // revoke that silenced it would be a far worse bug than the one fixed, so
    // the probe creates a table and reads relrowsecurity rather than trusting
    // that an event trigger behaves like a row trigger.
    const sql = readMigration(FILE);
    expect(sql).toMatch(/event trigger fired with EXECUTE revoked: RLS enabled = true/);
    expect(sql).toMatch(/direct call refused: permission denied for function rls_auto_enable/);
    const post = sql.slice(sql.indexOf("do $post$"));
    expect(post).toMatch(/evtenabled/);
    expect(post).toMatch(/RLS event trigger is gone or disabled/);
  });

  it("records that the direct call did NOT error, against expectation", () => {
    // The reasonable guess — and the one made — was that
    // pg_event_trigger_ddl_commands() would raise outside an event-trigger
    // context. It returns no rows instead, so the call succeeded and did
    // nothing. "It would error anyway" is not the defence; the door not
    // existing is. Pinned because a future reader will make the same guess.
    // Line-wrapped in the migration prose, so match without the article.
    expect(readMigration(FILE)).toMatch(/call SUCCEEDED and did nothing/);
  });

  it("checks both kinds afterwards, not just the one it revoked", () => {
    const post = readMigration(FILE).slice(readMigration(FILE).indexOf("do $post$"));
    expect(post).toMatch(
      /prorettype in \('pg_catalog\.trigger'::regtype, 'pg_catalog\.event_trigger'::regtype\)/,
    );
  });
});

describe("the migration proves its own preconditions", () => {
  it("refuses to run against a schema that is not the one it was written for", () => {
    const sql = readMigration(THIS_MIGRATION);
    expect(sql).toMatch(/do \$pre\$/i);
    expect(sql).toMatch(/expected 34 trigger functions in public/);
    expect(sql).toMatch(/expected all 34 executable by authenticated/);
  });

  it("refuses to revoke a trigger function attached to no trigger", () => {
    // One attached to nothing might be one somebody calls another way. All 34
    // are attached; this fails rather than guessing if that stops being true.
    const sql = readMigration(THIS_MIGRATION);
    expect(sql).toMatch(/attached to no trigger/);
    expect(sql).toMatch(/pg_trigger/);
    expect(sql).toMatch(/tgisinternal/);
  });

  it("checks the catalog afterwards, and that the triggers still exist", () => {
    const post = readMigration(THIS_MIGRATION).slice(
      readMigration(THIS_MIGRATION).indexOf("do $post$"),
    );
    expect(post).toMatch(/has_function_privilege\('authenticated'/);
    expect(post).toMatch(/still reachable by anon or authenticated/);
    // A grant change and nothing else: the triggers are counted again after.
    expect(post).toMatch(/expected at least 34 live triggers after the revokes/);
  });

  it("records the probe rather than citing the manual", () => {
    const sql = readMigration(THIS_MIGRATION);
    expect(sql).toMatch(/trigger fired with EXECUTE revoked: OK, touched=true/);
    expect(sql).toMatch(/direct call refused: permission denied for function/);
  });
});

describe("the account menu follows the tab bar, like everything else in that header", () => {
  const route = () => readFileSync(ROOT + "src/routes/_authenticated/route.tsx", "utf8");
  const codeOnly = (src: string) =>
    src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("{/*");
      })
      .join("\n");

  it("derives its breakpoint from the hook instead of spelling one", () => {
    // Sign out lives in the tab bar's More sheet wherever the bar reaches. The
    // avatar was hardcoded `max-md:hidden` while the bar already followed the
    // hook, so from 768 to 1023px the avatar was in the header AND Sign out was
    // in the sheet — the duplication the tier was introduced to remove.
    const src = codeOnly(route());
    expect(src).toMatch(
      /const accountMenuHidden = barThroughTablet \? "max-lg:hidden" : "max-md:hidden"/,
    );
    expect(src).toMatch(/<div className=\{accountMenuHidden\}>/);
  });

  it("spells both class strings out in full, because Tailwind reads source", () => {
    // An assembled class name is one Tailwind never sees and never emits.
    const src = codeOnly(route());
    expect(src).not.toMatch(/`max-\$\{/);
    expect(src).toMatch(/"max-lg:hidden"/);
  });
});
