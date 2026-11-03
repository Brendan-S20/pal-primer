// R2-52: js.stripe.com was requested on every page, /auth and the public
// sign-in included, before anyone had anything to pay.
//
// The cause is how @stripe/stripe-js is built. Its bare entry injects the
// <script> as a side effect of being IMPORTED, and seven payment components
// imported it at the top of a module that the app pulls in well before a
// payment screen opens. The /pure entry injects it only when loadStripe() is
// called, which each of those components does when its form mounts.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./support/repo-paths";

const root = join(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(join(root, "src")).map((p) => ({
  rel: repoRelative(p, root),
  src: readFileSync(p, "utf8"),
}));

describe("Stripe.js is added to the page only by a payment screen", () => {
  it("no value import of the bare @stripe/stripe-js entry anywhere in src", () => {
    const bad: string[] = [];
    for (const { rel, src } of files) {
      for (const m of src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"@stripe\/stripe-js"\s*;/gm)) {
        if (!m[1]) bad.push(`${rel}: ${m[0]}`);
      }
      if (/^import\s+"@stripe\/stripe-js"/m.test(src)) bad.push(`${rel}: side-effect import`);
    }
    expect(bad).toEqual([]);
  });

  it("connect-js is imported for its types or on demand only", () => {
    const bad: string[] = [];
    for (const { rel, src } of files) {
      for (const m of src.matchAll(
        /^import\s+(type\s+)?[^;]*?from\s+"@stripe\/connect-js"\s*;/gm,
      )) {
        if (!m[1]) bad.push(`${rel}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every component that loads Stripe uses the /pure entry", () => {
    // Client components that import Stripe's loadStripe; portal.functions.ts has
    // a server helper of the same name that has nothing to do with the browser.
    const loaders = files.filter(({ src }) =>
      /import\s*\{[^}]*\bloadStripe\b[^}]*\}\s*from\s*"@stripe\//.test(src),
    );
    expect(loaders.length).toBeGreaterThanOrEqual(7);
    for (const { rel, src } of loaders) {
      expect(src, rel).toContain('from "@stripe/stripe-js/pure"');
    }
  });

  it("the /pure entry this relies on exists in the installed package", () => {
    const pure = readFileSync(join(root, "node_modules/@stripe/stripe-js/dist/pure.mjs"), "utf8");
    const bare = readFileSync(join(root, "node_modules/@stripe/stripe-js/dist/index.mjs"), "utf8");
    // The bare entry kicks off the load at module scope; pure does not.
    const atImport =
      /^Promise\.resolve\(\)\.then\(function \(\) \{\s*return getStripePromise\(\);/m;
    expect(bare).toMatch(atImport);
    expect(pure).not.toMatch(atImport);
    expect(pure).toContain("loadStripe");
  });
});
