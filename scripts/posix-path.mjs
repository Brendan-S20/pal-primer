// The `.mjs` half of `tests/support/repo-paths.ts`.
//
// Two copies exist because these are two module systems that cannot import
// each other: the checks in `scripts/` are plain ESM JavaScript run by `node`
// directly, and the helper in `tests/` is TypeScript compiled by vitest.
// Six lines duplicated is cheaper than a build step, but it is duplication,
// so: if the rule changes, it changes in both.
//
// ── WHY A PATH BECOMES A STRING, AND WHY THAT IS THE BUG ──────────────────
//
// `join()` and `relative()` are platform-correct and must stay that way --
// that is what they are for, and reading a file with them works everywhere.
// The fault is at the boundary where the result stops being a path and starts
// being a STRING that is compared, looked up, or printed.
//
// `check-dead-machinery.mjs` is the sharpest example. It keys its allowlist by
// repo-relative path:
//
//     scripts/dead-machinery-baseline.json
//       "unreachable_modules": { "src/components/billing/PlanPicker.native-stub.tsx": ... }
//
// and looks entries up with `relative(ROOT, file)`. On Windows that returns
// `src\components\billing\PlanPicker.native-stub.tsx`, which matches no key.
// Every one of the twenty documented exceptions then reads as a live
// violation, the script exits non-zero, and the test that runs it fails with
// `Command failed: node scripts/check-dead-machinery.mjs` -- a message that
// says nothing about paths at all.
//
// A cache manifest is the same shape of requirement arrived at differently:
// `check-pwa-output.mjs` lists URLs, and a URL has forward slashes on every
// platform there has ever been.

/**
 * Normalise a path to the spelling a person writes, a JSON key uses, and a URL
 * requires.
 *
 * Splits on BOTH separators rather than on `sep`, because a path can arrive
 * already mixed -- part built by `join()`, part concatenated with a literal
 * `/` somewhere upstream. Splitting on `sep` alone fixes half of such a path.
 * On POSIX this is the identity function, so nothing changes here.
 */
export function toPosix(path) {
  return path.split(/[\\/]/).join("/");
}
