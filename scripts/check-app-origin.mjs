#!/usr/bin/env node
// Does the origin this app publishes actually answer, and does it answer the
// native app's preflight?
//
// ── WHY THIS IS A SCRIPT AND NOT A LINE IN A RUNBOOK ──────────────────────
//
// §3 item 6 of the brief listed two curls as "only you can confirm, because
// this sandbox cannot". They sat unrun for days. When they were finally run the
// documented host FAILED: `app.houndstack.com` answered 307 to
// `www.app.houndstack.com`, and a CORS preflight may not follow a redirect —
// the Fetch spec makes it a network error — so the native app pointed there
// could not call a single server function.
//
// The owner removed the CDN rule the same day, and the direction REVERSED: the
// bare host now serves and the www form redirects. This script caught that flip
// on the next run, which is the whole argument for its existence. The CORS and
// CSRF work was right throughout; only ever the host was wrong, and which host
// is wrong is a fact that lives at the edge and nowhere in this repo.
//
// ── WHAT IT ASSERTS ───────────────────────────────────────────────────────
//
//   1. The origin serves rather than bouncing to a DIFFERENT host. A same-host
//      redirect (`/` → `/auth` for a signed-out visitor) is ordinary routing and
//      is not a finding — the first version of this failed on it.
//   2. The preflight answers 2xx with allow-origin for the native origin.
//   3. `access-control-expose-headers` carries x-tss-serialized and x-tss-raw.
//      Without those the app receives every reply successfully and decodes all
//      of them wrongly, with nothing anywhere reporting a problem — BUG-62,
//      which is the failure mode worth a dedicated assertion.
//
// Usage:
//   node scripts/check-app-origin.mjs                  # uses appOrigin()'s default
//   APP_ORIGIN=https://staging.example node scripts/check-app-origin.mjs
//   node scripts/check-app-origin.mjs --skip-if-unreachable   # for offline CI

const NATIVE_ORIGIN = "capacitor://localhost";
const PROBE_PATH = "/_serverFn/getMyDay";
const REQUIRED_EXPOSED = ["x-tss-serialized", "x-tss-raw"];

// Duplicated rather than imported: this is a plain node script and src/ is TS.
// The test suite asserts the two agree — see tests/one-app-origin.test.ts and
// the `check:app-origin default matches appOrigin()` case.
const FALLBACK = "https://app.houndstack.com";

function origin() {
  const v = process.env.APP_ORIGIN || process.env.PUBLIC_APP_ORIGIN || process.env.APP_URL;
  return (v ? v.trim().replace(/\/+$/, "") : FALLBACK);
}

/**
 * True when a response is a redirect that leaves `base`'s origin.
 *
 * A relative Location, or one pointing at the same scheme+host, is ordinary
 * routing. `new URL(location, base)` resolves both forms, so a bare `/auth` and
 * an absolute same-host URL are treated alike.
 */
function crossOrigin(base, res) {
  if (res.status < 300 || res.status >= 400) return false;
  const loc = res.headers.get("location");
  if (!loc) return false;
  try {
    return new URL(loc, base).origin !== new URL(base).origin;
  } catch {
    return false;
  }
}

async function main() {
  const skipIfUnreachable = process.argv.includes("--skip-if-unreachable");
  const base = origin();
  const problems = [];
  console.log(`checking ${base}`);

  let root;
  try {
    root = await fetch(base + "/", { redirect: "manual" });
  } catch (e) {
    const msg = `could not reach ${base}: ${e.message}`;
    if (skipIfUnreachable) {
      console.log(`⚠ ${msg} — skipped by --skip-if-unreachable`);
      return;
    }
    console.error(`✗ ${msg}`);
    process.exit(2);
  }

  // Only a redirect that leaves the ORIGIN is a finding.
  //
  // The first version of this flagged the default host, because
  // `www.app.houndstack.com/` answers 307 → `/auth` — the app's own routing for
  // a signed-out visitor, which is correct. Failing a check on correct
  // behaviour is how a check gets switched off, so the test is
  // "does it send me to a different host", not "does it redirect".
  if (crossOrigin(base, root)) {
    problems.push(
      `the origin redirects to another host: ${root.status} → ${root.headers.get("location")}\n` +
        `      A cross-host redirect breaks the native app outright — a CORS preflight may\n` +
        `      not follow one — and server-to-server callers do not follow redirects on\n` +
        `      POST, so webhook callbacks are delivered to the redirect and dropped.`,
    );
  }

  const pre = await fetch(base + PROBE_PATH, {
    method: "OPTIONS",
    redirect: "manual",
    headers: {
      Origin: NATIVE_ORIGIN,
      "Access-Control-Request-Method": "POST",
    },
  });

  if (pre.status >= 300 && pre.status < 400) {
    // Any redirect on a preflight is fatal, same-host or not — the Fetch spec
    // does not permit following one. So unlike the root check above, this does
    // not care where it points.
    problems.push(
      `the preflight redirects: ${pre.status} → ${pre.headers.get("location")}\n` +
        `      This is the whole finding. The browser turns it into a network error.`,
    );
  } else if (pre.status >= 400) {
    problems.push(`the preflight answered ${pre.status}; expected 2xx`);
  } else {
    const allow = pre.headers.get("access-control-allow-origin");
    if (allow !== NATIVE_ORIGIN) {
      problems.push(
        `preflight allow-origin is ${JSON.stringify(allow)}, expected ${NATIVE_ORIGIN}`,
      );
    }
    const exposed = (pre.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    const missing = REQUIRED_EXPOSED.filter((h) => !exposed.includes(h));
    if (missing.length) {
      problems.push(
        `expose-headers is missing ${missing.join(", ")} (got ${JSON.stringify(exposed)})\n` +
          `      Without these the app receives every reply successfully and decodes all of\n` +
          `      them wrongly, with nothing reporting a problem. That is BUG-62.`,
      );
    }
  }

  if (problems.length === 0) {
    console.log(
      `✓ ${base} serves directly, answers the native preflight, and exposes ` +
        REQUIRED_EXPOSED.join(" + "),
    );
    return;
  }

  console.error(`✗ ${base} is not usable by the native app:\n` + problems.map((p) => `    - ${p}`).join("\n"));
  console.error(
    `\n  A cross-host redirect here is a CDN/DNS setting, not a code change. Point ` +
      `the\n  redirect the other way, or set APP_ORIGIN to the host that actually serves ` +
      `and\n  update FALLBACK in this file and in src/lib/app-origin.ts together — a test ` +
      `pins\n  the two to each other.`,
  );
  process.exit(1);
}

main();
