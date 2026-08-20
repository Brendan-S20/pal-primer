// The rules of scripts/check-customer-facing-em-dashes.mjs, against fixtures.
//
// The guard passes on `main` by construction, because the sweep that added it
// cleared every finding first. That proves nothing about whether the rules
// work: a scan that returned [] unconditionally would look identical. So this
// feeds it sources it has never seen and pins both directions -- what it must
// catch, and what it must leave alone.
//
// The first implementation of this guard was a hand-rolled character walker and
// it was wrong in a way these fixtures would have caught in seconds: every `=>`
// and every `a > b` looks like the `>` that closes a JSX tag, so it opened a
// text run and swallowed the code and comments that followed. It reported 177
// findings and the first ones it named were comments.

import { describe, it, expect } from "vitest";
import { scanSource } from "../scripts/check-customer-facing-em-dashes.mjs";

const scan = (src: string, rel = "src/routes/_authenticated/thing.tsx") =>
  scanSource(rel, src);

describe("what it must catch", () => {
  it("prose in JSX text", () => {
    expect(scan(`export const A = () => <p>We couldn't save that — try again.</p>;`)).toHaveLength(1);
  });

  it("prose in a string literal", () => {
    expect(scan(`const msg = "Saved — but the email did not send";`)).toHaveLength(1);
  });

  it("prose in a template literal, either side of an expression", () => {
    expect(scan("const m = `Archived ${n} clients — ${f} failed`;")).toHaveLength(1);
  });

  it("an &mdash; entity, which renders as one", () => {
    expect(scan(`export const A = () => <p>Paused &mdash; but only in one way.</p>;`)).toHaveLength(1);
  });

  it("an arrow function does not hide the copy that follows it", () => {
    // The exact shape the first implementation got wrong.
    const src = [
      `const fmt = (n: number) => n > 2 ? "many" : "few";`,
      `export const A = () => <p>Route changed — check before driving.</p>;`,
    ].join("\n");
    const found = scan(src);
    expect(found).toHaveLength(1);
    expect(found[0].snippet).toContain("Route changed");
  });
});

describe("what it must leave alone", () => {
  it("a line comment", () => {
    expect(scan(`// this explains something — at length\nconst a = 1;`)).toHaveLength(0);
  });

  it("a block comment", () => {
    expect(scan(`/* this explains something — at length */\nconst a = 1;`)).toHaveLength(0);
  });

  it("a JSX comment", () => {
    expect(scan(`export const A = () => <div>{/* why — because */}<b>hi</b></div>;`)).toHaveLength(0);
  });

  it("a standalone placeholder cell", () => {
    expect(scan(`const cell = value ?? "—";`)).toHaveLength(0);
  });

  it("a separator between two interpolated values", () => {
    expect(scan("const label = `${a} — ${b}`;")).toHaveLength(0);
  });

  it("but a placeholder with words attached is still copy", () => {
    expect(scan(`const cell = value ?? "— none yet";`)).toHaveLength(1);
  });

  it("the platform admin console, by path", () => {
    const src = `const t = "platform copy — excluded";`;
    expect(scan(src, "src/routes/platform.health.tsx")).toHaveLength(0);
    expect(scan(src, "src/lib/platform-metrics.ts")).toHaveLength(0);
    // The identical string outside /platform/ is still caught, which is what
    // makes the two lines above an exclusion rather than a dead scanner.
    expect(scan(src, "src/lib/metrics.ts")).toHaveLength(1);
  });

  it("test files", () => {
    expect(scan(`const t = "x — y";`, "src/lib/thing.test.ts")).toHaveLength(0);
  });
});

describe("the em-dash-ok marker", () => {
  it("exempts the statement it is attached to", () => {
    const src = [
      `// em-dash-ok: model prompt, not customer copy.`,
      "const prompt = `Be brief — one sentence.`;",
    ].join("\n");
    expect(scan(src)).toHaveLength(0);
  });

  it("finds a marker at the top of a long comment block", () => {
    const src = [
      `// em-dash-ok: the compliance artifact, stored verbatim per consent and`,
      `// shown to carriers in the linked screenshots. Changing it would put the`,
      `// page out of step with the evidence submitted, so it changes`,
      `// deliberately, with the screenshots, or not at all.`,
      "const CONSENT = `... not a condition of purchase — you can create ...`;",
    ].join("\n");
    expect(scan(src)).toHaveLength(0);
  });

  it("does NOT leak to the next statement", () => {
    const src = [
      `// em-dash-ok: model prompt, not customer copy.`,
      "const prompt = `Be brief — one sentence.`;",
      `const copy = "Saved — but the email did not send";`,
    ].join("\n");
    const found = scan(src);
    expect(found).toHaveLength(1);
    expect(found[0].snippet).toContain("Saved");
  });

  it("does NOT leak to the statement above it", () => {
    const src = [
      `const copy = "Saved — but the email did not send";`,
      `// em-dash-ok: model prompt, not customer copy.`,
      "const prompt = `Be brief — one sentence.`;",
    ].join("\n");
    expect(scan(src)).toHaveLength(1);
  });
});
