/**
 * The platform fee must not travel in a JavaScript chunk.
 *
 * ── THE FAULT ─────────────────────────────────────────────────────────────
 *
 * payments.tsx imported describePlatformFee() from `@/lib/platform-fee`, which
 * put PLATFORM_FEE_BPS in the CLIENT bundle. A chunk is a static asset: it is
 * served to whoever asks for it, signed in or not.
 *
 * It was invisible, and that is the interesting part. The rate is 0, the
 * function returns null on its first line, and the bundler folds the whole
 * thing away -- a build of `main` contains no trace of the fee across 369
 * client files. So nothing was leaking, and nothing would have looked wrong in
 * review either. Setting the constant to 50 and rebuilding puts it straight
 * into a chunk:
 *
 *     function oe(){return`a ${50/100}% HoundStack fee on payments over $${J/100}`}
 *
 * The rate would have become public on the day it was turned ON, by a one-line
 * diff that says nothing about bundles. Measured both ways: 1 client file
 * before the fix, 0 after, with the same constant at 50.
 *
 * ── WHAT THIS CAN AND CANNOT CHECK ────────────────────────────────────────
 *
 * Whether a module truly reaches the client is a question only a build can
 * answer, and a build takes minutes. What a parser can see is the mistake that
 * was actually made: a component importing the module directly. So the rule is
 * that no client-side file may import `@/lib/platform-fee` -- server functions,
 * `.server.ts` modules and the API routes may, because none of them are
 * bundled for a browser.
 *
 * That is narrower than the property, and saying so is the point: a future
 * client-side `.ts` helper that imports the module and is itself imported by a
 * component would pass this and still ship the number. The durable version of
 * this check is a grep of the built output, which is why the numbers above were
 * taken from real builds rather than argued.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * Source with comments removed.
 *
 * The first version of the check below asserted `describePlatformFee()` was
 * still called, and passed on a handler that had been gutted to `null` --
 * because the sentence also appears in the comment ABOVE the handler
 * explaining what it does. That is the third time this repo has been bitten by
 * a rule matching prose about the code instead of the code: the accounting
 * tab's two ternary branches, post_credit_entry reading its own comment out of
 * prosrc, and sandboxes.yml's removed `if:` still named in the comment that
 * removed it.
 */
const codeOnly = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Every file under src/ that a browser could plausibly be sent. */
function clientSideFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        // Server-only by construction: these are request handlers, never
        // shipped as static assets.
        if (p === "src/routes/api") continue;
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      // The two server conventions this repo uses.
      if (/\.server\.ts$/.test(entry.name) || /\.functions\.ts$/.test(entry.name)) continue;
      out.push(p);
    }
  };
  walk("src");
  return out;
}

const IMPORTS_PLATFORM_FEE = /from\s+["']@\/lib\/platform-fee["']/;

describe("the platform fee stays off the client", () => {
  it("finds the files at all, so a green run means checked", () => {
    // Every assertion below is "no file does X", which is true of an empty
    // list. This is the tripwire.
    const files = clientSideFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("src/routes/_authenticated/payments.tsx");
  });

  it("is imported by no client-side file", () => {
    const offenders = clientSideFiles()
      .filter((f) => IMPORTS_PLATFORM_FEE.test(codeOnly(f)))
      .map(
        (f) =>
          `${relative(".", f)} imports @/lib/platform-fee, which puts PLATFORM_FEE_BPS in a ` +
          `JavaScript chunk any visitor can fetch. Read it through ` +
          `getPlatformFeeSentence in platform-fee.functions.ts instead.`,
      );
    expect(offenders).toEqual([]);
  });

  it("is still reachable from the server, so the tenant is still told", () => {
    // The mirror fault, and a real one: hiding the number from the bundle by
    // dropping the disclosure would "pass" this file while overstating what
    // leaves a tenant's account. The fee has to keep arriving by some route.
    const fn = codeOnly("src/lib/platform-fee.functions.ts");
    // Comment-stripped, and the tripwire proves stripping left the code: every
    // assertion here is "the text contains X", all of which fail helpfully on
    // an empty string but none of which would notice a file reduced to its
    // imports.
    expect(fn).toMatch(/handler/);
    expect(fn).toMatch(IMPORTS_PLATFORM_FEE);
    expect(fn).toMatch(/describePlatformFee\(\)/);
    expect(fn).toMatch(/createServerFn/);
  });

  it("is rendered on the payments page from the fetched value", () => {
    const page = codeOnly("src/routes/_authenticated/payments.tsx");
    expect(page).toMatch(/getPlatformFeeSentence/);
    expect(page).toMatch(/HoundStack adds \$\{platformFee\}/);
  });

  it("asks only for a signed-in user, not a billing permission", () => {
    // A published term identical for every tenant. Gating it on
    // manage_org_billing would show a technician a paragraph with the price
    // missing, which is the disclosure fault in a different costume.
    const fn = codeOnly("src/lib/platform-fee.functions.ts");
    expect(fn).toMatch(/requireSupabaseAuth/);
    expect(fn).not.toMatch(/requirePermission/);
  });
});
