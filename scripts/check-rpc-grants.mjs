#!/usr/bin/env node
// Can the app actually CALL the functions it calls?
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// On 2026-09-03 a migration rewrote the planner and, re-granting the functions
// it touched, applied the internal-helper pattern to the ENTRY POINT:
//
//     REVOKE ALL ON FUNCTION public.plan_day_across_staff(...) FROM public, anon, authenticated;
//     GRANT EXECUTE ON FUNCTION public.plan_day_across_staff(...) TO service_role;
//
// Auto-routing then refused every day for a week -- "permission denied for
// function plan_day_across_staff", once per day in the range -- and nothing
// here noticed:
//
//   - the migration applied cleanly; revoking a grant is valid SQL
//   - check-migrations saw the file in the ledger
//   - check-baseline-objects saw the function in the catalog. It IS there. It
//     is simply not callable by the role that calls it
//   - the type generator emitted it, because types come from the signature
//   - every unit test passed, because none of them cross a role boundary
//
// Existence and reachability are different questions and everything we had
// asked the first one.
//
// ── THE RULE ──────────────────────────────────────────────────────────────
//
// Every `.rpc("name")` in src/ is checked against the role its own call site
// uses. A call through the request-scoped client (publishable key + the user's
// JWT) executes as `authenticated` and must be executable by `authenticated`.
//
// ── WHY IT CLASSIFIES THE CLIENT INSTEAD OF CHECKING EVERYTHING ───────────
//
// The first version of this file checked all 114 call sites against
// `authenticated` and was measured before being trusted: it produced FORTY
// findings, of which one was real. The other thirty-nine were correct
// lockdowns -- twenty-one `portal_*` functions (the customer portal is
// token-based and runs server-side on the service role), plus admin_*,
// run_billing_cycles, move_to_dlq, enqueue_email, read_email_batch and the
// rest of the cron and webhook surface.
//
// A check with a 39-to-1 false-positive rate is worse than no check, which is
// exactly what check-baseline-objects says about the eighty false positives
// that made its own predecessor unusable. So the client is classified per call
// site, and functions called only on a service-role client are not examined at
// all: their revocation of `authenticated` is correct and asserting anything
// about it would turn a good lockdown into a failure.
//
// With that classification the same run produces ONE finding, and it is the
// real one.
//
// ── WHAT IT DOES NOT ANSWER ───────────────────────────────────────────────
//
// Whether a function is SAFE to expose. That is the job of the guard inside
// it -- plan_day_across_staff opens with can_write_org(auth.uid(), _org_id),
// and auth.uid() is NULL on the service role, so that guard only means
// anything when the caller is `authenticated`. This asks only whether the app
// can reach what it already tries to reach.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    // types.ts is generated and names every function in the schema, called or
    // not. Reading it would turn this into a catalogue check.
    else if (/\.(ts|tsx)$/.test(p) && !p.endsWith("types.ts")) out.push(p);
  }
  return out;
}

const CALL = /([A-Za-z_$][\w$]*)\s*(?:as any)?\s*\)?\s*\.rpc[(<]\s*["'`]([a-z_][a-z0-9_]*)["'`]/g;
// A name this cannot read is a name it cannot check. Reported, not skipped.
const DYNAMIC = /\.rpc\(\s*[A-Za-z_$][\w$]*\s*[,)]/g;

const authenticated = new Map();
const dynamic = [];

for (const file of walk(join(root, "src"))) {
  const text = readFileSync(file, "utf8");
  const rel = file.replace(root + "/", "");

  // Identifiers in THIS file that hold a service-role client. Both spellings
  // are load-bearing: src/routes/email/queue/process.ts builds one with
  // `const supabase = createClient(url, supabaseServiceKey)`, so a check that
  // recognised only the name `supabaseAdmin` would call it authenticated and
  // report three false findings.
  const serviceClients = new Set(["supabaseAdmin", "admin"]);
  // `admin(` and any helper whose name ends in `adminClient(` (campaigns
  // .functions.ts wraps supabaseAdmin in `adminClient()`). Missing that one
  // reported two correct lockdowns as findings the first time this check
  // actually ran (2026-10-03).
  for (const m of text.matchAll(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?(?:admin|[A-Za-z_$]*[aA]dminClient)\s*\(/g,
  )) {
    serviceClients.add(m[1]);
  }
  for (const m of text.matchAll(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?createClient[^;]*?(?:[sS]erviceKey|SERVICE_ROLE)/g,
  )) {
    serviceClients.add(m[1]);
  }

  for (const m of text.matchAll(CALL)) {
    if (serviceClients.has(m[1])) continue;
    // A call made on a client this file cannot classify by name, but that
    // only ever runs as the service role, says so in a comment within the
    // three lines above it: `// rpc-role: service`. one-off-visit.server.ts
    // calls generate_visits_core on `db` only when `input.asService`.
    const before = text.slice(0, m.index).split("\n").slice(-4).join("\n");
    if (/rpc-role:\s*service/.test(before)) continue;
    const line = text.slice(0, m.index).split("\n").length;
    if (!authenticated.has(m[2])) authenticated.set(m[2], []);
    authenticated.get(m[2]).push(`${rel}:${line}`);
  }
  for (const m of text.matchAll(DYNAMIC)) {
    dynamic.push(`${rel}:${text.slice(0, m.index).split("\n").length}`);
  }
}

if (authenticated.size === 0) {
  console.error("✗ found no request-scoped .rpc() call sites in src/. The matcher is broken.");
  process.exit(1);
}

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.log(
    "? SUPABASE_DB_URL is not set; cannot ask the database. Not treating that as a failure.",
  );
  process.exit(0);
}

const names = [...authenticated.keys()];
const sql = `
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid),
       has_function_privilege('authenticated', p.oid, 'EXECUTE')
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname = ANY('{${names.join(",")}}'::text[]);`;
// The braces are the array literal; the names are matched by
// `[a-z_][a-z0-9_]*` above, so a single-quoted literal is safe. Until 2026-10-03 this read
// `$$a,b,c$$::text[]` (no braces), which Postgres rejects as a malformed array literal,
// and the catch below reported that as "could not reach the database" and
// exited 0. So from the day it landed (#193) the check never ran once: twelve
// "malformed array literal" errors a day in the production log, and green.

let rows;
try {
  rows = execFileSync("psql", [dbUrl, "-At", "-F", "\t", "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [proname, args, can] = l.split("\t");
      return { proname, args, can: can === "t" };
    });
} catch (e) {
  // Only a CONNECTION failure is "could not ask". psql exits 2 for that; a
  // query the database rejected exits 1, and is this script's bug, which
  // must fail loudly rather than pass for a network blip.
  const stderr = String(e.stderr ?? "");
  const unreachable =
    e.status === 2 || /could not connect|connection to server|could not translate host/i.test(stderr);
  if (unreachable) {
    console.log(
      `? could not reach the database (${e.message.split("\n")[0]}); not treating that as a failure.`,
    );
    process.exit(0);
  }
  console.error(`✗ the database rejected this check's own query:\n${stderr || e.message}`);
  process.exit(1);
}

const problems = [];
for (const [name, sites] of authenticated) {
  const overloads = rows.filter((r) => r.proname === name);
  if (overloads.length === 0) {
    problems.push(
      `${name} does not exist in public, so every call gets PGRST202.\n` +
        `    Called from: ${sites.join(", ")}`,
    );
    continue;
  }
  // One reachable overload is enough: PostgREST resolves by the argument names
  // the caller sends.
  if (!overloads.some((o) => o.can)) {
    problems.push(
      `${name} exists but "authenticated" cannot EXECUTE it, so every call fails\n` +
        `    with "permission denied for function ${name}".\n` +
        `    Signature(s): ${overloads.map((o) => `(${o.args})`).join(", ")}\n` +
        `    Called from: ${sites.join(", ")}`,
    );
  }
}

console.log(`\nchecked ${authenticated.size} function(s) the app calls as "authenticated"`);
if (dynamic.length) {
  console.log(`  ${dynamic.length} call(s) pass a variable name and could not be checked:`);
  for (const d of dynamic) console.log(`    ${d}`);
}

if (problems.length) {
  console.error(`\n✗ the app calls ${problems.length} function(s) it cannot execute:\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  console.error(
    "  A function can exist, typecheck, and sit in every migration ledger while\n" +
      "  being unreachable by the role that calls it. check-baseline-objects asks\n" +
      "  whether it exists; this asks whether the app can call it.",
  );
  process.exit(1);
}

console.log('✓ every function the app calls as "authenticated" is executable by it\n');
