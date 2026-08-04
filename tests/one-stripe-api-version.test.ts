import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { STRIPE_API_VERSION } from "@/lib/stripe-client.server";

// There were THIRTEEN `new Stripe(secret)` calls across nine modules and not one
// passed `apiVersion`. Unpinned means "whatever version this account is on" — a
// value that changes from the Stripe dashboard, on Stripe's migration schedule,
// or by a colleague clicking upgrade, with no deploy, no diff and no failing
// test.
//
// It had already drifted: the live platform webhook endpoint was serialising
// events at 2026-07-29.dahlia while stripe-node 22.3.0 types every response
// against 2026-06-24.dahlia. Nothing fails at compile time, because the payload
// arrives as JSON and is cast — so the only symptom of a field that moved
// between versions is `undefined`, at runtime, in money code.

const ROOT = new URL("..", import.meta.url).pathname;
const HELPER = "src/lib/stripe-client.server.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(rel);
  }
  return out;
}
const sources = walk("src").filter((f) => f !== HELPER);

/** Source with comments stripped — a rule this repo has had to learn twice. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

describe("every Stripe client is built in one place", () => {
  it("constructs `new Stripe(` nowhere but the helper", () => {
    const offenders = sources.filter((f) =>
      /new\s+Stripe\s*\(/.test(code(readFileSync(join(ROOT, f), "utf8"))),
    );
    expect(
      offenders,
      `these build their own Stripe client and will not be pinned:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("imports the SDK directly nowhere but the helper, except for types", () => {
    // `import type` is erased and carries no runtime client, so it is fine —
    // processing-fee.server.ts uses it. A VALUE import is how a fourteenth
    // unpinned client gets built.
    const offenders = sources.filter((f) => {
      const src = code(readFileSync(join(ROOT, f), "utf8"));
      // `type` sits after `import`, not before `from` — matching near `from`
      // reports `import type Stripe from "stripe"` as a value import, which is
      // how the first cut of this test failed on processing-fee.server.ts.
      const valueImport = /^\s*import\s+(?!type\b)[^;]*?from\s+["']stripe["']/m.test(src);
      return valueImport || /await import\(["']stripe["']\)/.test(src);
    });
    expect(
      offenders,
      `these import the Stripe SDK directly:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("the pinned version", () => {
  it("matches what the installed SDK's types describe", () => {
    // Read from the package rather than restated here: if the two ever
    // disagree, the types in the editor stop describing the JSON on the wire.
    // (The constant is ALSO compile-checked against the SDK's own literal type,
    // so an upgrade without a bump fails `tsc` — verified by mutation.)
    const declared = readFileSync(
      join(ROOT, "node_modules/stripe/esm/apiVersion.d.ts"),
      "utf8",
    );
    expect(declared).toContain(`"${STRIPE_API_VERSION}"`);
  });
});

describe("both webhook handlers say so when a delivered event disagrees", () => {
  // Outbound calls are pinned, but INBOUND events are serialised at whatever
  // version the endpoint was CREATED with, and Stripe does not allow that to be
  // changed afterwards — closing it means recreating the endpoint, which mints
  // a new signing secret and needs a human. Until then this is what keeps the
  // mismatch from being silent.
  for (const route of [
    "src/routes/api/public/hooks/platform-stripe.ts",
    "src/routes/api/public/hooks/stripe.ts",
  ]) {
    it(`${route} checks event.api_version`, () => {
      const src = readFileSync(join(ROOT, route), "utf8");
      expect(src).toContain("warnOnApiVersionMismatch(event)");
      // After the signature check, never before — an unverified body's
      // api_version is attacker-supplied and not worth logging.
      const verify = src.indexOf("constructEventAsync");
      const warn = src.indexOf("warnOnApiVersionMismatch(event)");
      expect(verify).toBeGreaterThan(-1);
      expect(warn).toBeGreaterThan(verify);
    });
  }

  it("warns rather than rejects", async () => {
    // Refusing the event would turn a field-shape risk into guaranteed dropped
    // billing events, with Stripe retrying a delivery that can never succeed.
    const { warnOnApiVersionMismatch } = await import("@/lib/stripe-client.server");
    expect(() =>
      warnOnApiVersionMismatch({ id: "evt_1", api_version: "1999-01-01.zinnia" }),
    ).not.toThrow();
  });

  it("stays quiet when the versions agree, and when the event names none", () => {
    const src = readFileSync(join(ROOT, HELPER), "utf8");
    expect(src).toMatch(/if \(!event\.api_version \|\| event\.api_version === STRIPE_API_VERSION\) return;/);
  });
});
