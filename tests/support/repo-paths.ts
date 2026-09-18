// A path a person reads is always spelled with forward slashes.
//
// ── THE BUG THIS EXISTS TO STOP ───────────────────────────────────────────
//
// Eighty-six of the 271 test files fail on the Windows runner, and none of
// them fails at the thing it is testing. They fail like this:
//
//     expected [ "src\components/RouteMap.tsx" ] to equal [ "src/components/RouteMap.tsx" ]
//
// The rule found the right file. It then printed the name in a spelling the
// assertion did not recognise.
//
// Note the MIXED separators in that string, because they are the whole reason
// this normalises with a character class rather than `split(sep)`. Part of the
// path came from `join()`, which is platform-correct and therefore uses `\` on
// Windows; part of it was concatenated with a literal `/` somewhere upstream.
// Splitting on `sep` alone would fix the backslashes and leave the forward
// slashes, which on Windows means fixing half a path.
//
// ── WHY THE FIX IS HERE AND NOT IN 86 FILES ───────────────────────────────
//
// Reading a file with `join(root, name)` is already correct on every platform
// and must stay that way — that is what `join` is for. The fault is only at
// the boundary where a built path stops being a path and becomes a STRING that
// gets compared to a literal or printed in a failure message. There are 21 of
// those in the suite. Everything downstream of them is already correct and
// needs no edit, which is why "86 files fail" and "21 lines need changing" are
// both true and describe the same fault.
//
// ── WHY THIS MATTERS BEYOND TIDINESS ──────────────────────────────────────
//
// A second self-hosted runner has been idle since 2026-09-16 because every
// test job is pinned to `UNIX_RUNNER = macOS`. The Mac it is pinned to sits at
// 94% swap a few hours after a reboot, and that condition has already
// manufactured eight CI failures in one day that looked like code and were
// not. This is the one route to moving the long job off that machine that does
// not involve buying anything.

import { relative } from "node:path";

/**
 * Normalise a path to the spelling a person writes and an assertion expects.
 *
 * Splits on BOTH separators, deliberately: see the note above about mixed
 * separators. On POSIX this is the identity function, so every existing
 * expectation is unchanged.
 */
export function toPosix(path: string): string {
  return path.split(/[\\/]/).join("/");
}

/**
 * A repo-relative, forward-slashed path for display and comparison.
 *
 * Replaces three idioms that were doing this by hand and getting it wrong on
 * Windows: `file.slice(root.length + 1)`, `file.replace(root + "/", "")` and
 * `relative(root, file)`. On POSIX all three produced exactly what this
 * returns, which is what makes the substitution safe to do in bulk.
 */
export function repoRelative(absolute: string, root: string): string {
  return toPosix(relative(root, absolute));
}
