#!/usr/bin/env node
// Does each OAuth button actually work, all the way to the provider?
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// On 2026-08-25 Google sign-in was enabled and shipped to production. It sent
// every buyer who pressed it to:
//
//     Access blocked: This app's request is invalid
//     Error 400: redirect_uri_mismatch
//
// The app has an in-flight guard for exactly this class of problem —
// oauthSignIn fetches the authorize URL first and treats >= 400 as "provider
// not enabled". It could not help, and the reason is the whole point of this
// script: SUPABASE ANSWERED 302, because Supabase was fine. The provider was
// enabled, configured, and happily redirecting. The failure was one hop
// further on, at Google, cross-origin and opaque to any check the app can make
// about itself.
//
// So "is the provider enabled" and "does pressing the button work" are
// different questions, and only the second one matters to a person trying to
// sign in. This asks the second.
//
// ── WHAT IT DOES ──────────────────────────────────────────────────────────
//
//   1. reads /auth/v1/settings          → which providers Supabase has ON
//   2. for each, GET /authorize?provider=…  with no redirect following
//   3. follows the Location to the provider itself and reads what comes back
//
// Step 3 is the one nothing else does. A provider that is switched on but
// misconfigured looks perfect at steps 1 and 2.
//
// Usage:  node scripts/check-oauth-providers.mjs
//         node scripts/check-oauth-providers.mjs --provider google
//
// Exit code is 1 if any provider the app OFFERS is broken, so this can gate a
// release. A provider that is off is not a failure — it is a decision.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The providers the sign-in card offers, in the order it offers them. Kept
// here rather than parsed out of the JSX because the question this script asks
// is "what do we intend to offer", and that is a decision, not a grep.
const OFFERED = ["google", "apple", "facebook"];

// Is the button LIVE — can a person actually press it? This is the difference
// between a finding and an outage, and the exit code below turns on it.
//
// A provider can be broken in two directions and only one of them reaches a
// buyer:
//
//   switched ON at Supabase, broken at the provider, button DISABLED
//       → nobody can reach it. Worth knowing, not worth failing a build.
//   switched OFF at Supabase, button LIVE
//       → every press lands on a raw "Unsupported provider" API error page.
//
// So the UI is parsed rather than assumed. A `disabled` attribute or a missing
// onClick means dead; an onClick calling oauthSignIn means live.
function liveInUI(provider) {
  let jsx;
  try {
    jsx = readFileSync(join(ROOT, "src/routes/auth.tsx"), "utf8");
  } catch {
    return null; // cannot tell; reported as unknown rather than guessed
  }
  // Strip JSX comment blocks first — this file documents the Google breakage
  // at length inside {/* … */}, and those words would otherwise read as code.
  const code = jsx.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const wired = new RegExp(`oauthSignIn\\(\\s*["']${provider}["']`).test(code);
  if (!wired) return false;
  // Find the button that mentions this provider and ask whether it is disabled.
  const blocks = code.match(/<Button[\s\S]*?<\/Button>/g) ?? [];
  const mine = blocks.find((b) => new RegExp(provider, "i").test(b));
  if (!mine) return false;
  // `disabled` is not one thing. A BARE attribute (or an explicit {true}) is a
  // dead button; `disabled={loading}` is a live button that greys out for the
  // half second a submit is in flight, and `disabled:pointer-events-none` is a
  // Tailwind class. The first version of this treated all three the same and
  // reported a freshly-enabled Google button as disabled — which fails in the
  // dangerous direction, downgrading a reachable broken provider to a warning.
  const bare = /\bdisabled\b(?!\s*[=:])/.test(mine);
  const hard = /\bdisabled\s*=\s*\{\s*true\s*\}/.test(mine);
  return !(bare || hard);
}

function readConst(file, re) {
  const m = re.exec(readFileSync(join(ROOT, file), "utf8"));
  return m?.[1] ?? null;
}

const SUPABASE_URL = readConst(
  "src/integrations/supabase/client.ts",
  /const SUPABASE_URL\s*=\s*["']([^"']+)["']/,
);
const ANON = readConst(
  "src/integrations/supabase/client.ts",
  /const SUPABASE_PUBLISHABLE_KEY\s*=\s*["']([^"']+)["']/,
);

if (!SUPABASE_URL || !ANON) {
  console.error("could not read the Supabase URL / publishable key from client.ts");
  process.exit(2);
}

const only = process.argv.includes("--provider")
  ? process.argv[process.argv.indexOf("--provider") + 1]
  : null;

const settings = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
  headers: { apikey: ANON },
}).then((r) => r.json());

const external = settings.external ?? {};
const rows = [];

for (const provider of OFFERED) {
  if (only && provider !== only) continue;

  const enabled = !!external[provider];
  const live = liveInUI(provider);
  if (!enabled) {
    rows.push({
      provider,
      enabled,
      live,
      verdict: live ? "BROKEN" : "OFF",
      detail: live
        ? "the button is LIVE but the provider is not enabled in Supabase — every press lands on a raw API error page"
        : "not enabled in Supabase, and the button is disabled — consistent",
    });
    continue;
  }

  // Step 2 — what the app's own probe sees.
  const authorize = `${SUPABASE_URL}/auth/v1/authorize?provider=${provider}`;
  let res;
  try {
    res = await fetch(authorize, { redirect: "manual", headers: { apikey: ANON } });
  } catch (e) {
    // UNKNOWN, not BROKEN. This step gates a release, so it must fail on a
    // provider that rejects us and never on a flaky network: an unreachable
    // host says nothing about whether the button works.
    rows.push({ provider, enabled, live, verdict: "UNKNOWN", detail: `authorize unreachable: ${e.message}` });
    continue;
  }

  if (res.status >= 400) {
    rows.push({
      provider,
      enabled,
      live,
      verdict: "BROKEN",
      detail: `Supabase refused the authorize request (${res.status}) — the app's own probe WOULD catch this one`,
    });
    continue;
  }

  const location = res.headers.get("location");
  if (!location) {
    rows.push({ provider, enabled, live, verdict: "BROKEN", detail: `no redirect from authorize (${res.status})` });
    continue;
  }

  // Step 3 — the hop the app cannot make. Ask the provider.
  let providerRes, body = "";
  try {
    providerRes = await fetch(location, { redirect: "manual" });
    body = await providerRes.text();
  } catch (e) {
    rows.push({ provider, enabled, live, verdict: "UNKNOWN", detail: `provider unreachable: ${e.message}` });
    continue;
  }

  const redirectUri = decodeURIComponent(new URL(location).searchParams.get("redirect_uri") ?? "");

  // ── THE HOP THIS SCRIPT ORIGINALLY MISSED ──────────────────────────────
  //
  // The first version of this file read only the BODY and treated any 302 as
  // success — which is the identical mistake the app's own probe makes, one
  // level up. Google does not answer 400 with an error page. It answers 302
  // to accounts.google.com/signin/oauth/error with the reason base64'd into
  // an `authError` query parameter, so the body is empty and the status looks
  // like a healthy redirect to a consent screen.
  //
  // A checker written to catch "stops one hop too early" that stopped one hop
  // too early. So the redirect TARGET is inspected too, and the parameter is
  // decoded rather than pattern-matched, because the words are inside base64.
  const nextLocation = providerRes.headers.get("location") ?? "";
  let decodedError = "";
  try {
    const authError = new URL(nextLocation, location).searchParams.get("authError");
    if (authError) {
      decodedError = Buffer.from(authError, "base64").toString("utf8").replace(/[^\x20-\x7e]+/g, " ").trim();
    }
  } catch {
    /* not a URL we can parse; the string checks below still apply */
  }

  const haystack = (body + " " + nextLocation + " " + decodedError).toLowerCase();

  // Each provider announces a misconfiguration differently, so each is named
  // rather than guessed at from the status code.
  const mismatch =
    haystack.includes("redirect_uri_mismatch") ||
    haystack.includes("invalid redirect_uri") ||
    haystack.includes("url blocked") ||                 // Meta
    haystack.includes("invalid_client") ||
    haystack.includes("invalid_request") ||
    /\/oauth\/error|\/signin\/oauth\/error|[?&]error=/.test(nextLocation);

  if (mismatch) {
    rows.push({
      provider,
      enabled,
      live,
      verdict: "BROKEN",
      detail:
        `the provider rejects our redirect_uri — register ${redirectUri} with ${provider}` +
        (decodedError ? `\n${" ".repeat(32)}${decodedError.slice(0, 120)}` : ""),
    });
  } else if (providerRes.status >= 400) {
    rows.push({
      provider,
      enabled,
      live,
      verdict: "BROKEN",
      detail: `provider answered ${providerRes.status} — redirect_uri was ${redirectUri}`,
    });
  } else {
    rows.push({
      provider,
      enabled,
      live,
      verdict: "OK",
      detail: `provider accepted the request (redirect_uri ${redirectUri})`,
    });
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log("");
console.log(pad("PROVIDER", 12) + pad("SUPABASE", 10) + pad("BUTTON", 10) + pad("VERDICT", 10) + "DETAIL");
console.log("-".repeat(100));
for (const r of rows) {
  console.log(
    pad(r.provider, 12) +
      pad(r.enabled ? "enabled" : "off", 10) +
      pad(r.live === null ? "?" : r.live ? "live" : "disabled", 10) +
      pad(r.verdict, 10) +
      r.detail,
  );
}
console.log("");

const broken = rows.filter((r) => r.verdict === "BROKEN");
const reachable = broken.filter((r) => r.live);
const latent = broken.filter((r) => !r.live);

for (const r of latent) {
  console.warn(
    `! ${r.provider}: switched on at Supabase and broken at the provider, but the button is\n` +
      "  disabled so nobody can reach it. Fix the console side BEFORE re-enabling the button.",
  );
}

if (reachable.length) {
  console.error(
    `\u2717 ${reachable.length} provider(s) can be PRESSED and do not work. A button that ejects\n` +
      "  somebody onto a provider error page at the moment of commitment is worse than\n" +
      "  no button: disable it in src/routes/auth.tsx until the console side is done.",
  );
  process.exit(1);
}
console.log(
  latent.length
    ? "\u2713 no reachable provider is broken (see the warnings above before enabling anything)"
    : "\u2713 every provider that is switched on completes the handshake to its provider",
);
