// The composition of the two negative signals, and the one property that makes
// changing offline-critical code defensible: it can only ever say "offline"
// MORE often than the check it replaced, never less.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { definitelyOffline } from "@/lib/offline/connectivity";

describe("definitelyOffline", () => {
  const cases: Array<[boolean | undefined, boolean | null, boolean, string]> = [
    [false, null, true, "browser says no interface, nothing native known"],
    [false, true, true, "browser says no; native disagrees. Trust the negative"],
    [true, false, true, "THE iOS CASE: stale onLine after resume, native says no"],
    [true, true, false, "both say connected"],
    [true, null, false, "browser says yes, native unknown: unchanged from before"],
    [undefined, null, false, "no navigator (SSR): not offline, as before"],
    [undefined, false, true, "no navigator but native says no"],
  ];
  for (const [browserOnLine, nativeConnected, expected, why] of cases) {
    it(`${String(browserOnLine)} / ${String(nativeConnected)} -> ${expected}  (${why})`, () => {
      expect(definitelyOffline({ browserOnLine, nativeConnected })).toBe(expected);
    });
  }

  it("is monotonic: never returns false where the old check returned offline", () => {
    for (const b of [true, false, undefined] as const) {
      for (const n of [true, false, null] as const) {
        const oldSaysOffline = b === false;
        if (oldSaysOffline) {
          expect(
            definitelyOffline({ browserOnLine: b, nativeConnected: n }),
            "widening the offline set is the safe direction; narrowing it is not",
          ).toBe(true);
        }
      }
    }
  });
});

describe("the call sites", () => {
  const SITES = [
    "src/router.tsx",
    "src/lib/offline/useOfflineVisitActions.ts",
    "src/lib/offline/sync.ts",
    "src/lib/offline/sign-out.ts",
  ];
  const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const f of SITES) {
    it(`${f} asks the composed check, not navigator.onLine directly`, () => {
      const src = codeOnly(readFileSync(f, "utf8"));
      expect(src).toMatch(/isDefinitelyOffline\(\)/);
      expect(
        src,
        `${f} still reads navigator.onLine, so the native signal cannot reach it`,
      ).not.toMatch(/navigator\.onLine/);
    });
  }
});
