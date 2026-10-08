// `node scripts/playwright-with-env.mjs NAME=value ... <playwright args>`
//
// Playwright, with environment variables set the same way under every shell.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// `test:viewports:apple:sweeps` was `APPLE_SIZES=1 playwright test ...`. That
// is sh syntax. npm runs scripts through cmd.exe on Windows, and the workflow
// step that invokes it runs under PowerShell, and neither reads a leading
// `NAME=value` as an assignment -- it is a command named `APPLE_SIZES=1`, and
// the step dies before Playwright starts. scripts/build-native.mjs records the
// same failure for `NATIVE_BUILD=1 vite build` (CI, 2026-10-02).
//
// It mattered the day the viewport job moved to the Windows runner: the step
// that measures eleven Apple sizes with touch on is the one step in that job
// whose script set a variable, and it is also the one the CI history says
// catches what nothing else does (#115, #207).
//
// ── WHY `NAME=value` STAYS IN THE SCRIPT ──────────────────────────────────
//
// The assignment is still spelled out in package.json, as an argument rather
// than a shell prefix, for two reasons:
//
//   * A person reading `test:viewports:apple:sweeps` sees the mode it runs in
//     without opening this file.
//   * tests/the-sweeps-are-not-the-whole-suite.test.ts asks which CI steps SET
//     APPLE_SIZES=1 by reading the script, and a wrapper with the value baked
//     in would hide that from it -- the exact gap that rule was written for.
//
// Leading `NAME=value` arguments are consumed; everything from the first
// argument that is not one is passed to Playwright's own CLI untouched.
//
// ── WHY A CHILD PROCESS, AND NOT `npx playwright` ─────────────────────────
//
// `npx` and the `node_modules/.bin/playwright` shim are a `.cmd` on Windows,
// which `spawn` will not run without a shell, and a shell is the thing this
// file exists to avoid. So it resolves Playwright's CLI module and runs it
// with the same `node` that is running this file: no shell, no quoting, the
// same on every platform. The exit code is passed through, so a failing sweep
// still fails the step.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

/**
 * Split leading `NAME=value` arguments from the rest.
 * @param {string[]} argv the arguments after the script path
 * @returns {{ env: Record<string, string>, args: string[] }}
 */
export function splitAssignments(argv) {
  const env = {};
  let i = 0;
  for (; i < argv.length; i++) {
    const m = ASSIGNMENT.exec(argv[i]);
    if (!m) break;
    env[m[1]] = m[2];
  }
  return { env, args: argv.slice(i) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { env, args } = splitAssignments(process.argv.slice(2));
  if (args.length === 0) {
    console.error("usage: node scripts/playwright-with-env.mjs NAME=value ... test [filters]");
    process.exit(2);
  }
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  // Ctrl-C reaches the child directly (same process group / console), so
  // there is nothing to forward; just report how it ended.
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`playwright ended on ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    console.error(`could not start playwright: ${err.message}`);
    process.exit(1);
  });
}
