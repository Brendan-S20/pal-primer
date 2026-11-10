#!/usr/bin/env node
// Does every Supabase Auth hook this product depends on point at a host that
// exists, and does the route there answer?
//
// ── WHY (#764) ────────────────────────────────────────────────────────────
//
// From about 2026-08-10 to 2026-11-09 every Supabase Auth email — password
// reset, email change, magic link, reauthentication — went nowhere. The Send
// Email hook URI was `https://www.app.houndstack.com/email/auth/webhook`, and
// on 2026-08-10 the www host stopped existing (NXDOMAIN; see
// src/lib/app-origin.ts). GoTrue logged `dial tcp: lookup www.app.houndstack.com
// ... no such host` three times per request and answered 422
// `hook_timeout_after_retry`. Nobody noticed for three months because sign-up
// auto-confirms, so no new business ever needed an auth email.
//
// `check-app-origin.mjs` was already asking the live edge whether the APP's
// origin answers. It could not see this, because the hook URI is a remote Auth
// setting (dashboard-only; not in supabase/config.toml), not anything in code.
// This is the sibling that asks the same question of the hook.
//
// ── WHAT IT ASSERTS, PER HOOK URI ─────────────────────────────────────────
//
//   1. It parses and is https.
//   2. Its host RESOLVES (dns lookup; NXDOMAIN or no address is a failure).
//      This is the exact fault #764 was.
//   3. Unless --dns-only: the route ANSWERS. An unsigned POST is sent; a 401 /
//      400 is the healthy answer (the route is alive and refused an unsigned
//      call). A connection error, a 404/405 (no such route), any 5xx (the
//      route is there but broken — e.g. "Server configuration error" when the
//      hook secret is missing) or a redirect to another host is a failure:
//      GoTrue does not follow a hook redirect, so the email would be dropped.
//
// ── WHERE THE URIS COME FROM ──────────────────────────────────────────────
//
// This script does NOT read the production Auth config — that needs a
// management token, and a check that holds one is a check that can write.
// Instead it checks the URIs it is given:
//
//   AUTH_HOOK_URIS             comma/space separated list, every hook in use
//   AUTH_SEND_EMAIL_HOOK_URI   the send-email hook alone
//   (neither)                  DEFAULT_SEND_EMAIL_HOOK_URI below — the value
//                              prod was set to on 2026-11-09
//
// Whoever changes the hook in the dashboard changes the default here (or the
// env in CI) in the same breath; a test pins the default to the app origin.
//
// ── SECRETS ───────────────────────────────────────────────────────────────
//
// Output names scheme, host and path ONLY. Userinfo, query and fragment are
// stripped before anything is printed, the unsigned probe carries no secret,
// and no environment variable but the ones above is read.
//
// ── --live: WHAT AUTH IS ACTUALLY CONFIGURED WITH ────────────────────────
//
// Checking a URI from env or a default would NOT have caught #764: the code
// and env already assumed the right host while the live setting said www.
// So `--live` reads the project's Auth config from the Management API —
// `GET /v1/projects/{ref}/config/auth`, a GET and nothing else — and checks
// what is really there:
//
//   - `hook_send_email_uri` must equal EXPECTED_SEND_EMAIL_HOOK_URI exactly
//     (drift back to the www host fails here, before any DNS);
//   - every ENABLED hook whose URI is http(s) is resolved and probed as above
//     (pg-functions:// hooks run inside Postgres and have no host).
//
// The token comes from SUPABASE_ACCESS_TOKEN in the caller's environment and is
// never printed, nor is the config response; only hook field names and
// redacted URIs are. No Management API token is stored in GitHub (per
// Brendan): the daily --live run happens outside GitHub, from SIC's routine.
// .github/workflows/auth-hook-health.yml schedules only the no-token path
// above, and its manual live job skips at the workflow layer when the runner
// has no token. Called directly, a missing token under --live is still a
// failure (exit 2), not a skip: the caller asked for the live check.
//
// Usage:
//   node scripts/check-auth-hook-hosts.mjs
//   node scripts/check-auth-hook-hosts.mjs --dns-only
//   AUTH_SEND_EMAIL_HOOK_URI=https://… node scripts/check-auth-hook-hosts.mjs
//   SUPABASE_ACCESS_TOKEN=… node scripts/check-auth-hook-hosts.mjs --live
//   (with the token set, live is the default; --live makes a missing token fatal)
//
// Exit codes: 0 every hook healthy, 1 at least one hook is not, 2 --live
// could not read the config (no token, or the API refused).

import { promises as dns } from "node:dns";
import { pathToFileURL } from "node:url";

// Same host as FALLBACK in check-app-origin.mjs and appOrigin() — pinned by
// tests/the-reset-email-went-to-a-host-that-did-not-exist.test.ts.
export const DEFAULT_SEND_EMAIL_HOOK_URI = "https://app.houndstack.com/email/auth/webhook";

/** What the live send-email hook must be, exactly. */
export const EXPECTED_SEND_EMAIL_HOOK_URI = DEFAULT_SEND_EMAIL_HOOK_URI;

/** Production project (supabase/config.toml project_id; scripts/native-prod-hosts.mjs). */
export const PROD_SUPABASE_REF = "vsxzrbxublqrcfnxfwcu";
const MANAGEMENT_API = "https://api.supabase.com";

const PROBE_TIMEOUT_MS = 10_000;
const RESERVED_TLD = /\.(invalid|test|example|localhost)\.?$/i;

/** The URIs to check, from the environment or the default. */
export function hookUrisFromEnv(env = process.env) {
  const list = (env.AUTH_HOOK_URIS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length) return list;
  const one = (env.AUTH_SEND_EMAIL_HOOK_URI ?? "").trim();
  return [one || DEFAULT_SEND_EMAIL_HOOK_URI];
}

/** scheme://host/path — never userinfo, query or fragment. Safe to print. */
export function redactUri(uri) {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<unparseable hook URI>";
  }
}

async function defaultLookup(host) {
  return dns.lookup(host, { all: true });
}

async function defaultProbe(uri) {
  return fetch(uri, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
}

/**
 * Check one hook URI. Returns `{ uri, host, problems }`; healthy when
 * `problems` is empty. `lookup` and `probe` are injectable so the verdicts are
 * testable without the network; the defaults use real DNS and real fetch.
 */
export async function checkHookUri(uri, opts = {}) {
  const lookup = opts.lookup ?? defaultLookup;
  const probe = opts.probe ?? defaultProbe;
  const shown = redactUri(uri);
  const problems = [];

  let url;
  try {
    url = new URL(uri);
  } catch {
    return { uri: shown, host: null, problems: ["the hook URI does not parse"] };
  }
  if (url.protocol !== "https:") {
    problems.push(`the hook URI is ${url.protocol.replace(":", "")}, not https`);
  }
  const host = url.hostname;

  // RFC 6761: `.invalid`, `.test`, `.example` and `.localhost` never name a
  // public host, and applications are told to treat them so rather than ask
  // a resolver — some resolvers (sinkholes, captive portals) answer anything.
  if (RESERVED_TLD.test(host)) {
    problems.push(
      `host ${host} is a reserved name (RFC 6761) that does not resolve publicly. ` +
        `Supabase Auth cannot reach this hook, so every email it carries is never sent (#764).`,
    );
    return { uri: shown, host, problems };
  }

  let addresses = [];
  try {
    addresses = (await lookup(host)) ?? [];
  } catch (e) {
    const code = e && typeof e === "object" && "code" in e ? e.code : "lookup failed";
    problems.push(
      `host ${host} does not resolve (${code}). Supabase Auth cannot reach this hook, ` +
        `so every email it carries is never sent (#764).`,
    );
    return { uri: shown, host, problems };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    problems.push(`host ${host} resolved to no address`);
    return { uri: shown, host, problems };
  }

  if (opts.dnsOnly) return { uri: shown, host, problems };

  let res;
  try {
    res = await probe(url.href);
  } catch (e) {
    const cause = e?.cause?.code ?? e?.name ?? "error";
    problems.push(`the route did not answer (${cause})`);
    return { uri: shown, host, problems };
  }

  const status = res.status;
  if (status >= 300 && status < 400) {
    let to = "?";
    try {
      to = redactUri(new URL(res.headers.get("location") ?? "", url.href).href);
    } catch {
      /* unparseable Location; still a redirect */
    }
    problems.push(
      `the route redirects (${status} → ${to}). GoTrue does not follow a hook redirect.`,
    );
  } else if (status === 404 || status === 405) {
    problems.push(`the route answered ${status}: there is no webhook at this path`);
  } else if (status >= 500) {
    problems.push(
      `the route answered ${status}: it exists but is failing (a missing hook secret ` +
        `answers 500 "Server configuration error")`,
    );
  }
  return { uri: shown, host, problems, status };
}

/**
 * Read the live Auth config. GET only; the token goes in a header and nowhere
 * else, and an error message carries the status, never the body.
 */
export async function fetchAuthConfig({ ref, token, fetchImpl = fetch }) {
  const res = await fetchImpl(
    `${MANAGEMENT_API}/v1/projects/${encodeURIComponent(ref)}/config/auth`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Management API answered ${res.status} for the auth config`);
  return res.json();
}

/**
 * From a live auth config: which hooks are enabled, at which URI, and whether
 * the send-email hook is the one expected. Pure, so drift is testable.
 */
export function liveHooks(config, expected = EXPECTED_SEND_EMAIL_HOOK_URI) {
  const problems = [];
  const hooks = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    const m = /^hook_(.+)_uri$/.exec(key);
    if (!m) continue;
    const enabled = config[`hook_${m[1]}_enabled`] === true;
    if (!enabled || typeof value !== "string" || !value) continue;
    hooks.push({ name: m[1], uri: value });
  }
  const sendEmail = hooks.find((h) => h.name === "send_email");
  if (!sendEmail) {
    problems.push(
      `the send-email hook is not enabled (hook_send_email_enabled is not true), ` +
        `so auth emails do not go through ${redactUri(expected)}`,
    );
  } else if (sendEmail.uri !== expected) {
    problems.push(
      `hook_send_email_uri is ${redactUri(sendEmail.uri)}, expected ${redactUri(expected)}. ` +
        `This is how #764 happened: the live setting drifted while the code was right.`,
    );
  }
  return { hooks, problems };
}

async function mainLive(env, dnsOnly, deps) {
  const token = (env.SUPABASE_ACCESS_TOKEN ?? "").trim();
  const ref = (env.SUPABASE_PROJECT_REF ?? "").trim() || PROD_SUPABASE_REF;
  if (!token) {
    console.error(
      "✗ --live needs SUPABASE_ACCESS_TOKEN (a read-capable Management API token). " +
        "Not checking is not passing.",
    );
    return 2;
  }
  let config;
  try {
    config = await (deps.fetchAuthConfig ?? fetchAuthConfig)({ ref, token });
  } catch (e) {
    console.error(`✗ could not read the live auth config for ${ref}: ${e.message}`);
    return 2;
  }
  const { hooks, problems } = liveHooks(config);
  let failed = problems.length;
  for (const p of problems) console.error(`✗ live auth config: ${p}`);
  for (const h of hooks) {
    if (!/^https?:/i.test(h.uri)) {
      console.log(`· hook ${h.name} is ${h.uri.split(":")[0]}: (no host to check)`);
      continue;
    }
    const r = await checkHookUri(h.uri, { dnsOnly, lookup: deps.lookup, probe: deps.probe });
    if (r.problems.length === 0) {
      console.log(
        `✓ live hook ${h.name} ${r.uri} ${dnsOnly ? "resolves" : `resolves and answers (${r.status})`}`,
      );
    } else {
      failed += 1;
      console.error(
        `✗ live hook ${h.name} ${r.uri} is NOT reachable:\n` +
          r.problems.map((p) => `    - ${p}`).join("\n"),
      );
    }
  }
  if (failed) {
    console.error(
      `\n  The live Supabase Auth hook settings are wrong for project ${ref}. They are ` +
        `remote settings\n  (Authentication → Hooks), not code. Fix them there, then fire ` +
        `one test password reset.`,
    );
    return 1;
  }
  return 0;
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const dnsOnly = argv.includes("--dns-only");
  // Live is the production path: forced by --live, and taken whenever a
  // Management API token is present and no URI override asks for a dry run.
  // Only with no token and no --live does it fall back to the configured URIs.
  const override = Boolean(
    (env.AUTH_HOOK_URIS ?? "").trim() || (env.AUTH_SEND_EMAIL_HOOK_URI ?? "").trim(),
  );
  const hasToken = Boolean((env.SUPABASE_ACCESS_TOKEN ?? "").trim());
  if (argv.includes("--live") || (hasToken && !override)) return mainLive(env, dnsOnly, deps);
  if (!override) {
    console.log(
      "· no SUPABASE_ACCESS_TOKEN: checking the expected URI, NOT the live Auth setting " +
        "(the daily live check runs outside GitHub).",
    );
  }
  const uris = hookUrisFromEnv(env);
  let failed = 0;
  for (const uri of uris) {
    const r = await checkHookUri(uri, { dnsOnly, lookup: deps.lookup, probe: deps.probe });
    if (r.problems.length === 0) {
      const how = dnsOnly ? "resolves" : `resolves and answers (${r.status})`;
      console.log(`✓ auth hook ${r.uri} ${how}`);
    } else {
      failed += 1;
      console.error(
        `✗ auth hook ${r.uri} is NOT reachable:\n` + r.problems.map((p) => `    - ${p}`).join("\n"),
      );
    }
  }
  if (failed) {
    console.error(
      `\n  ${failed} of ${uris.length} auth hook(s) unreachable. The hook URI is a remote ` +
        `Supabase Auth\n  setting (Authentication → Hooks), not code: point it at a host that ` +
        `serves the route,\n  then fire one test password reset.`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
