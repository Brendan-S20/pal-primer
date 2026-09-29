// In July a migration revoked EXECUTE from PUBLIC and anon across every
// function in `public`, and ended with what was meant to make it permanent:
//
//   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
//   -- stop new functions from arriving pre-granted. Without this the next
//   -- migration reopens the hole and nobody notices.
//
// It does not work. Probed on the live database inside a rolled-back
// transaction: the stored default for postgres/public/functions carries no
// PUBLIC entry, and a function created one statement later still came out
// `=X/postgres | postgres=X | authenticated=X | service_role=X`. `=X` is
// PUBLIC and anon is a member of PUBLIC. Re-issuing the ALTER DEFAULT
// PRIVILEGES inside the same transaction changed nothing.
//
// So the July sweep cleaned the functions that existed that day and nothing
// after. Thirty-one SECURITY DEFINER functions were anon-executable again by
// August — twenty-five of them purely through PUBLIC, never granted to anon by
// anyone, which is why `REVOKE EXECUTE ... FROM anon` on them would have been a
// silent no-op. Four were genuinely exploitable with nothing but the
// publishable key: the nightly add-on biller (2 charges raised and $70 taken
// out of a customer's prepaid balance, in a rolled-back probe), the chargeback
// review-queue writer (which also DELETES a real chargeback notice),
// `record_client_sms_consent` (whose `_source = 'portal'` skipped
// authorization entirely — forging TCPA consent and clearing an opt-out), and
// `assert_available_on`, which reads a named staff member's absence out in an
// exception message.
//
// A test that checks those four are fixed would be worth very little; they will
// stay fixed. What this file protects is the thing that failed twice: the SIZE
// OF THE SURFACE. Every function this schema adds arrives executable by the key
// in the browser bundle, so the anonymous surface grows on its own, silently,
// and the only durable defence is a list that has to be argued with. Hence the
// centre of this file: after the most recent catalog-wide sweep, the set of
// functions `anon` can execute must equal an allowlist that names a caller for
// every entry — and any function created after that sweep must carry its own
// REVOKE or fail here.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// LAZY, every one of them. Resolved inside the `it` that needs them and never
// in a `describe` body: a throw during collection makes vitest report "no
// tests" rather than N failures, and "no tests" reads as a pass. The mutation
// test for this file stashes src/ AND supabase/, so all of these paths are
// briefly absent by design.
const read = (p: string) => () => readFileSync(join(ROOT, p), "utf8");
const nightlySrc = read("src/routes/api/public/hooks/nightly.ts");
const stripeSrc = read("src/routes/api/public/hooks/stripe.ts");
const portalSrc = read("src/lib/portal.functions.ts");

const migrations = () => {
  const dir = join(ROOT, "supabase/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ file: f, sql: readFileSync(join(dir, f), "utf8") }));
};

/** Line comments stripped.
 *
 *  Every migration here explains the grant it is removing, and the prose names
 *  the functions it names — so a raw `toMatch` for `GRANT ... TO anon` finds
 *  the paragraph describing the bug as readily as the statement fixing it. */
const codeOnly = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

// ── the intended anonymous surface, with a caller for each ────────────────
//
// Six entries. A seventh must be added here, with a reason, before it can pass.
const ALLOWED_FOR_ANON: Record<string, string> = {
  public_get_org_by_slug:
    "signup.functions.ts resolves a tenant from a public slug before any account exists",
  public_get_org_for_lead_form:
    "api/public/leads.ts serves a lead form embedded on a tenant's own website",
  public_quote: "signup.$slug.tsx prices a visit for a visitor who has not signed up yet",
  org_accepts_public_leads:
    "the anon INSERT policy on `leads` calls it, so the querying role needs EXECUTE",
  roadmap_vote_counts: "the marketing roadmap reads counts from the browser",
  cast_roadmap_vote: "the marketing roadmap writes a vote from the browser",
};

/** A migration that sweeps the whole catalog rather than naming functions —
 *  a loop over pg_proc issuing REVOKE. Everything before one of these is
 *  irrelevant to what anon can reach today, which is why the model starts at
 *  the last one rather than replaying four hundred files. */
const isSweep = (sql: string) =>
  /FROM\s+pg_proc/i.test(sql) && /REVOKE\s+ALL\s+ON\s+FUNCTION\s+%s\s+FROM\s+PUBLIC/i.test(sql);

describe("the anonymous surface is a list, not an accident", () => {
  it("is exactly the six functions that have a caller, and no others", () => {
    const files = migrations();
    const lastSweep = files.map((f) => isSweep(f.sql)).lastIndexOf(true);
    expect(
      lastSweep,
      "no migration sweeps the catalog; the anon surface is unbounded",
    ).toBeGreaterThan(-1);

    // From the sweep onward: granted to anon minus revoked from anon/PUBLIC,
    // applied IN THE ORDER THE STATEMENTS RUN. It used to apply every GRANT in
    // a file and then every REVOKE, which is not what Postgres does: a file
    // that drops and recreates an anon function has to REVOKE the fresh
    // PUBLIC grant and then GRANT anon back (20260929120000 does exactly that
    // for public_quote), and grants-then-revokes read that as the function
    // leaving the surface when it had only been re-granted.
    const granted = new Set<string>();
    for (const { sql } of files.slice(lastSweep)) {
      const code = codeOnly(sql);
      const events: Array<{ at: number; fn: string; grant: boolean }> = [];
      for (const m of code.matchAll(
        /GRANT\s+(?:ALL|EXECUTE)[^;]*?\bON\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\([^;]*?\)\s*TO\s+([^;]*);/gi,
      )) {
        if (/\banon\b/i.test(m[2])) events.push({ at: m.index!, fn: m[1].toLowerCase(), grant: true });
      }
      for (const m of code.matchAll(
        /REVOKE\s+(?:ALL|EXECUTE)[^;]*?\bON\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\([^;]*?\)\s*FROM\s+([^;]*);/gi,
      )) {
        if (/\b(anon|PUBLIC)\b/i.test(m[2]))
          events.push({ at: m.index!, fn: m[1].toLowerCase(), grant: false });
      }
      for (const e of events.sort((a, b) => a.at - b.at)) {
        if (e.grant) granted.add(e.fn);
        else granted.delete(e.fn);
      }
    }

    expect([...granted].sort()).toEqual(Object.keys(ALLOWED_FOR_ANON).sort());
    // A reason per entry is the point of the allowlist, not decoration.
    for (const [fn, why] of Object.entries(ALLOWED_FOR_ANON)) {
      expect(why.length, `${fn} has no stated caller`).toBeGreaterThan(20);
    }
  });

  it("has no function added since the sweep that quietly inherited a PUBLIC grant", () => {
    const files = migrations();
    const lastSweep = files.map((f) => isSweep(f.sql)).lastIndexOf(true);

    // CREATE FUNCTION in `public` grants EXECUTE to PUBLIC, and ALTER DEFAULT
    // PRIVILEGES demonstrably does not stop it — so anything created after the
    // sweep is anon-reachable until a REVOKE says otherwise. CREATE OR REPLACE
    // of a function that already existed inherits the old ACL, but a signature
    // change is a new object with a fresh one, and telling those apart from
    // text is not reliable. Both are required to carry a REVOKE.
    const offenders: string[] = [];
    for (const { file, sql } of files.slice(lastSweep + 1)) {
      const code = codeOnly(sql);
      const created = new Set(
        [
          ...code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(/gi),
        ].map((m) => m[1].toLowerCase()),
      );
      const revoked = new Set(
        [
          ...code.matchAll(
            /REVOKE\s+(?:ALL|EXECUTE)[^;]*?\bON\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\([^;]*?\)\s*FROM\s+([^;]*);/gi,
          ),
        ]
          .filter((m) => /\b(anon|PUBLIC)\b/i.test(m[2]))
          .map((m) => m[1].toLowerCase()),
      );
      for (const fn of created) {
        if (!revoked.has(fn) && !(fn in ALLOWED_FOR_ANON)) {
          offenders.push(
            `${file}: public.${fn} is created without REVOKE ... FROM PUBLIC, anon — ` +
              `it ships executable by the publishable key`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the four that anon could actually use", () => {
  const sweep = () => {
    const files = migrations();
    const i = files.map((f) => isSweep(f.sql)).lastIndexOf(true);
    return codeOnly(files[i].sql);
  };

  it("locks the nightly add-on biller and the chargeback writer to the server, not just away from anon", () => {
    // Both take the organization from a parameter and check nothing against
    // it, so `authenticated` was as dangerous as `anon`: any signed-in user of
    // any tenant could bill, or unfile a chargeback in, any other tenant.
    const sql = sweep();
    expect(sql).toMatch(
      /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.admin_generate_addon_charges_through\([^)]*\)\s*FROM\s+PUBLIC,\s*anon,\s*authenticated/i,
    );
    expect(sql).toMatch(
      /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.file_reversal_review_item\([^)]*\)\s*FROM\s+PUBLIC,\s*anon,\s*authenticated/i,
    );
  });

  it("leaves the app's own checked route to add-on billing alone", () => {
    // The revoke above is only safe because the guarded wrapper exists. If a
    // later migration revokes THAT from authenticated, the office loses the
    // ability to bill add-ons and this test should be what says so.
    const all = migrations()
      .map((m) => codeOnly(m.sql))
      .join("\n");
    expect(all).not.toMatch(
      /REVOKE[^;]*\bON\s+FUNCTION\s+public\.generate_addon_charges_through\([^)]*\)[^;]*FROM[^;]*\bauthenticated\b/i,
    );
  });

  it("stops 'portal' being a password on record_client_sms_consent", () => {
    // The guard read `IF _source <> 'portal' AND NOT can_write_org(...)`, so
    // naming yourself the portal skipped authorization entirely — enough to
    // forge a consent record and clear an opt-out on any client in any tenant.
    // The portal is not an anonymous caller: portal.functions.ts checks the
    // session token and then calls on the service-role client, which has no
    // user identity at all.
    const sql = sweep();
    const body = sql.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.record_client_sms_consent[\s\S]*?\$\$;/i,
    )?.[0];
    expect(body, "record_client_sms_consent is not redefined").toBeTruthy();
    expect(body!).toMatch(/_source\s*=\s*'portal'\s+AND\s+auth\.uid\(\)\s+IS\s+NULL/i);
    expect(body!).toMatch(/NOT\s+public\.can_write_org\(auth\.uid\(\),\s*_org\)/i);
    // The old shape must be gone, not merely joined by the new one.
    expect(body!).not.toMatch(/_source\s*<>\s*'portal'\s+AND\s+NOT\s+public\.can_write_org/i);
  });

  it("keeps the sweep off extension-owned functions", () => {
    // pg_net's extension is registered in `public`. A loop that revoked from
    // every function in the schema would reach into it.
    expect(sweep()).toMatch(/pg_depend[\s\S]{0,200}deptype\s*=\s*'e'/i);
  });
});

describe("revoking from anon was safe because nothing anonymous was calling", () => {
  it("bills add-ons and files chargebacks on the service-role client", () => {
    // If either of these ever moves onto a user-session client, the REVOKE
    // above turns into a production outage rather than a fix.
    const nightly = codeOnly(nightlySrc());
    const nightlyCall = nightly.slice(
      nightly.indexOf("admin_generate_addon_charges_through") - 400,
      nightly.indexOf("admin_generate_addon_charges_through"),
    );
    expect(nightlyCall).toMatch(/supabaseAdmin/);

    const stripe = codeOnly(stripeSrc());
    expect(stripe).toMatch(/supabaseAdmin[\s\S]{0,80}\.rpc\(\s*"file_reversal_review_item"/);
  });

  it("records portal consent on the service-role client, after a session check", () => {
    // This is what makes `auth.uid() IS NULL` the right test for "is the
    // portal": the portal never carries a user identity, it carries a token
    // that requirePortalSession has already validated.
    const portal = codeOnly(portalSrc());
    const i = portal.indexOf('"record_client_sms_consent"');
    expect(i, "the portal no longer records consent").toBeGreaterThan(-1);
    const handler = portal.slice(Math.max(0, i - 1600), i);
    expect(handler).toMatch(/requirePortalSession/);
    expect(handler).toMatch(/await admin\(\)/);
  });
});

describe("the admin_ prefix means service_role, and every one of them keeps it", () => {
  it("has no admin_ function left reachable by a browser key", () => {
    // The convention this schema documents: an `admin_`-prefixed function
    // carries the logic with NO permission check, for cron and service_role
    // where auth.uid() is NULL, and the check lives in the unprefixed wrapper.
    // That convention is only true if the grants hold it up — which is exactly
    // where admin_generate_addon_charges_through fell out, by being created
    // after the sweep that had locked its four siblings.
    // The rule is deliberately an EXPLICIT, NAMED revoke rather than "a sweep
    // ran at some point after it was created". A sweep is a floor that erodes
    // — it cleans what exists on the day and the schema keeps growing — and
    // relying on one is precisely how this function slipped through. Its four
    // siblings each carry a line naming them; the test is that the fifth does
    // too, and that the sixth will have to.
    const all = migrations()
      .map((m) => codeOnly(m.sql))
      .join("\n");
    const created = new Set(
      [
        ...all.matchAll(
          /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(admin_[a-z0-9_]+)\s*\(/gi,
        ),
      ].map((m) => m[1].toLowerCase()),
    );
    expect(created.size).toBeGreaterThan(3);

    const unlocked = [...created].filter((fn) => {
      const revokes = [
        ...all.matchAll(
          new RegExp(
            `REVOKE\\s+(?:ALL|EXECUTE)[^;]*?\\bON\\s+FUNCTION\\s+public\\.${fn}\\s*\\([^;]*?\\)\\s*FROM\\s+([^;]*);`,
            "gi",
          ),
        ),
      ].map((m) => m[1]);
      // Both roles, because either one alone reaches every tenant: `anon` is
      // the key in the browser bundle and `authenticated` is a signed-in user
      // of some other organization, and an admin_ function checks neither.
      return !revokes.some((r) => /\banon\b/i.test(r) && /\bauthenticated\b/i.test(r));
    });
    expect(unlocked).toEqual([]);
  });
});
