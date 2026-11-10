#!/usr/bin/env node
// Is this database URL on THIS machine? The restore drill asks before it
// touches anything, and refuses when the answer is no.
//
//   RESTORE_TARGET_URL=postgresql://... node scripts/backup/local-only.mjs
//
// Exit 0 and print "local" when the URL names a loopback host; exit 1 with a
// reason otherwise. The URL is read from the environment, never from argv
// (the process table is readable by every user on the machine), and is never
// printed: a reason names the HOST only.
//
// ── WHY AN ALLOWLIST, AND WHY SO STRICT ───────────────────────────────────
//
// The drill decrypts every customer's data and loads it into the target. The
// one target that must never receive it is a database somebody else can
// reach. A denylist ("not the production project") is wrong the first time a
// project is added; this names the three spellings of loopback and refuses
// everything else, including:
//
//   * a hostname that merely resolves to 127.0.0.1 today (DNS can change);
//   * several hosts in one URL (libpq tries them in turn, so the first may be
//     local and the second may not);
//   * a `host`, `hostaddr` or `service` parameter in the query string, each of
//     which libpq lets override the host written before it;
//   * a URL with no host at all, which libpq resolves through PGHOST or a
//     service file the drill cannot see.

import { pathToFileURL } from "node:url";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const OVERRIDES = ["host", "hostaddr", "service"];

/** @returns {{ ok: true } | { ok: false, reason: string }} */
export function checkLocalDbUrl(raw) {
  if (!raw) return { ok: false, reason: "no database URL was given" };
  if (!/^postgres(?:ql)?:\/\//i.test(raw)) {
    return { ok: false, reason: "not a postgres:// or postgresql:// URL" };
  }
  // libpq's multi-host form: postgresql://h1:5432,h2:5432/db. `new URL`
  // reads that as one odd hostname, so it is refused before parsing.
  const authority = raw.replace(/^[^:]+:\/\//, "").split(/[/?#]/)[0];
  const hostPart = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  if (hostPart.includes(",")) return { ok: false, reason: "the URL names more than one host" };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "the URL does not parse" };
  }
  for (const key of url.searchParams.keys()) {
    if (OVERRIDES.includes(key.toLowerCase())) {
      return {
        ok: false,
        reason: `the URL carries a "${key}" parameter, which can point libpq somewhere else`,
      };
    }
  }
  const host = url.hostname.toLowerCase();
  if (!host)
    return {
      ok: false,
      reason: "the URL names no host, so libpq would pick one from the environment",
    };
  if (!LOOPBACK.has(host))
    return {
      ok: false,
      reason: `host "${host}" is not this machine (127.0.0.1, localhost or ::1)`,
    };
  return { ok: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const verdict = checkLocalDbUrl(process.env.RESTORE_TARGET_URL ?? "");
  if (verdict.ok) {
    console.log("local");
  } else {
    console.error(
      `REFUSING: ${verdict.reason}. The restore drill only ever writes to a database on this machine.`,
    );
    process.exit(1);
  }
}
