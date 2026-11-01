// A staging native build must not contain a production host (#623).
//
// vite.config.ts already refuses a staging build whose settings name one.
// This checks the OUTPUT, because the settings are not the bundle: a file
// that hard-codes a production URL, or a define that did not take, ships the
// production host no matter what the environment said.
//
// What counts as a host: any `houndstack.com` name, bare or inside a URL,
// and the production Supabase project ref. What does not: an email address
// (`support@houndstack.com`), which is a mailbox, not something the app
// connects to.
//
// The vacuous-pass guard applies here as everywhere: "nothing matched" on an
// empty directory proves nothing, so a missing or tiny bundle is a failure.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { toPosix } from "./posix-path.mjs";

const PROD_HOST = /(?<![@\w-])(?:[a-z0-9-]+\.)*houndstack\.com\b/gi;
const PROD_SUPABASE_REF = "vsxzrbxublqrcfnxfwcu";
const TEXT = /\.(js|mjs|cjs|html|css|json|webmanifest|map|txt|xml|svg)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Returns a list of problems; empty means the bundle names no production host. */
export function findProdHosts(bundleDir, root = process.cwd()) {
  if (!existsSync(bundleDir)) return [`no bundle at ${toPosix(relative(root, bundleDir))}`];
  const files = walk(bundleDir).filter((f) => TEXT.test(f));
  if (files.length < 5)
    return [`only ${files.length} text files in the bundle: this is not a real build`];
  const problems = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const hits = new Set(src.match(PROD_HOST) ?? []);
    if (src.includes(PROD_SUPABASE_REF))
      hits.add(`${PROD_SUPABASE_REF} (production Supabase project)`);
    if (hits.size) problems.push(`${toPosix(relative(root, f))}: ${[...hits].join(", ")}`);
  }
  return problems;
}

/** Exits the process with a report when a staging bundle names a production host. */
export function assertNoProdHosts(bundleDir, root = process.cwd()) {
  const problems = findProdHosts(bundleDir, root);
  if (problems.length === 0) {
    console.log(
      "✓ staging native bundle contains no houndstack.com host and no production Supabase ref",
    );
    return;
  }
  console.error("\n✗ staging native bundle names production:\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    "\n  A staging binary must talk only to staging. Set NATIVE_API_ORIGIN,\n" +
      "  NATIVE_SUPABASE_URL and NATIVE_SUPABASE_PUBLISHABLE_KEY to staging values,\n" +
      "  and do not hard-code a production URL in src/.",
  );
  process.exit(1);
}

// Run directly: `node scripts/native-prod-hosts.mjs [bundle dir]`.
if (process.argv[1]?.endsWith("native-prod-hosts.mjs")) {
  assertNoProdHosts(process.argv[2] ?? join(process.cwd(), "dist-native", "client"));
}
