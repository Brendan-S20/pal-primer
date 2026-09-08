import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Settings -> Accounting opened with "Use the Connect buttons below to
// authorize your accounting provider. Tokens are refreshed automatically."
//
// Both Connect buttons have been `disabled` since 2026-07-14, waiting on the
// QBO/Xero OAuth apps being approved. The words "coming soon" were on the page,
// but a paragraph further down and below the buttons themselves -- so the first
// thing an owner read was an instruction, and following it did nothing.
//
// A second sentence had the same fault from the other side: the Advanced
// disclosure said "Prefer the 'Connect' buttons above", steering people towards
// the one path that cannot work. While the flag is off, pasting tokens by hand
// is not the discouraged option, it is the ONLY option.
//
// Both now read off ACCOUNTING_CONNECT_ENABLED. The tab is not hidden and the
// machinery is not deleted: the OAuth flow, the sync log and the manual path
// are all built and correct, and flipping one constant is meant to light the
// whole page up. What must not survive that flip in either direction is copy
// describing the other state.

const SRC = readFileSync(
  join(process.cwd(), "src/routes/_authenticated/settings.accounting.tsx"),
  "utf8",
);

/** The flag, read from the source it is declared in. */
function connectEnabled(): boolean {
  const m = SRC.match(/const ACCOUNTING_CONNECT_ENABLED\s*=\s*(true|false)/);
  expect(m, "ACCOUNTING_CONNECT_ENABLED is gone or is no longer a literal").not.toBeNull();
  return m![1] === "true";
}

/**
 * What a person actually READS, with each `ACCOUNTING_CONNECT_ENABLED ? a : b`
 * resolved to the branch that renders.
 *
 * Resolving is the whole point and the first version of this file got it
 * wrong. Both branches are present in the source, so a plain string scan finds
 * the enabled-state copy no matter which state ships -- it passed before the
 * fix and failed after it, which is exactly backwards. The question here is
 * never "does this text exist in the file", it is "does this text reach a
 * screen", and a ternary is the difference.
 */
function renderedWith(enabled: boolean): string {
  const STR = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
  const ternary = new RegExp(
    String.raw`ACCOUNTING_CONNECT_ENABLED\s*\?\s*` + STR + String.raw`\s*:\s*` + STR,
    "g",
  );
  return SRC.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join(" ")
    .replace(ternary, (_m, whenTrue: string, whenFalse: string) => {
      const chosen = enabled ? whenTrue : whenFalse;
      // Strip the surrounding quote characters only; the literals here contain
      // no escapes, and unescaping is not what this needs to prove.
      return chosen.slice(1, -1);
    })
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ");
}

describe("the page describes the state it is actually in", () => {
  const enabled = connectEnabled();
  const rendered = renderedWith(enabled);

  it("is currently switched off, which is what the rest of this pins", () => {
    // Not an assertion about what the flag SHOULD be -- it is here so the
    // failure message says which branch the file below was checked against.
    expect(typeof enabled).toBe("boolean");
  });

  it("does not tell you to press the Connect buttons while they are disabled", () => {
    if (enabled) {
      expect(rendered).toContain("Use the Connect buttons below");
    } else {
      expect(
        rendered,
        "ACCOUNTING_CONNECT_ENABLED is false, so the intro must not instruct " +
          "anyone to use the Connect buttons. They are disabled and pressing " +
          "them does nothing.",
      ).not.toContain("Use the Connect buttons below");
    }
  });

  it("does not point the Advanced path at the buttons that cannot work", () => {
    if (enabled) {
      expect(rendered).toContain('Prefer the "Connect" buttons above');
    } else {
      expect(
        rendered,
        "ACCOUNTING_CONNECT_ENABLED is false, so the manual path is the only " +
          "path and must not be described as the one to avoid.",
      ).not.toContain('Prefer the "Connect" buttons above');
    }
  });

  it("says plainly that nothing will sync while it is off", () => {
    // The positive half. Removing the false sentence and replacing it with
    // nothing would leave a page that still LOOKS like a working integration
    // screen, which is the same fault with the instruction deleted.
    if (!enabled) {
      expect(rendered).toMatch(/not switched on yet/);
      expect(rendered).toMatch(/nothing here will sync/);
    }
  });

  it("marks the heading, so it reads as unavailable before anything is tried", () => {
    if (!enabled) expect(rendered).toMatch(/coming soon/i);
  });

  it("and the resolver is not just agreeing with itself", () => {
    // The guard the first version of this file needed. If renderedWith()
    // returned the same text for both states, every assertion above would pass
    // vacuously in whichever state shipped.
    expect(renderedWith(true)).not.toBe(renderedWith(false));
    expect(renderedWith(true)).toContain("Use the Connect buttons below");
    expect(renderedWith(false)).not.toContain("Use the Connect buttons below");
  });
});

describe("what is deliberately left alone", () => {
  it("keeps the tab reachable rather than hiding it", () => {
    // Hiding it would also hide the manual path, which support uses, and would
    // make the built-and-waiting integration invisible to the person deciding
    // whether to chase the provider approvals.
    const NAV = readFileSync(join(process.cwd(), "src/routes/_authenticated/settings.tsx"), "utf8");
    expect(NAV).toContain('to: "/settings/accounting"');
  });

  it("still refuses to offer a sync with nothing connected", () => {
    // Already correct before this change and easy to lose: the sync button is
    // rendered only when a connection exists.
    expect(SRC).toMatch(/conns\.data && conns\.data\.length > 0 && \(/);
  });
});
