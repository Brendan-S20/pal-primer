import { afterEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { appOrigin, appUrl } from "@/lib/app-origin";

// `app.houndstack.com` does not serve this app. It 307-redirects to
// `www.app.houndstack.com`, and a CORS preflight may not follow a redirect —
// the Fetch spec makes that a network error — so the native app pointed at the
// bare host cannot call a single server function. Verified live on 2026-08-02:
// the same preflight against the www host answers 204 with every header,
// including the `expose-headers` pair BUG-62 was hiding in.
//
// Before this, twenty-four places in src/ wrote an app host by hand and they
// disagreed. Portal links, unsubscribe URLs, invoice pay links and the og:url
// canonical used the bare host; invite emails, the concerns link, the lead-form
// origin and both Twilio hooks used the www one. Which one a URL got depended
// on which file happened to build it.

const SRC = new URL("../src", import.meta.url).pathname;
const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("appOrigin resolves one way", () => {
  it("falls back to the host that actually answers", () => {
    delete process.env.APP_ORIGIN;
    delete process.env.PUBLIC_APP_ORIGIN;
    delete process.env.APP_URL;
    // Not a style preference. The bare host returns 307 to this one, and a
    // preflight that redirects is a failed preflight.
    expect(appOrigin()).toBe("https://www.app.houndstack.com");
  });

  it("prefers APP_ORIGIN, then PUBLIC_APP_ORIGIN, then APP_URL", () => {
    process.env.APP_URL = "https://three.example";
    expect(appOrigin()).toBe("https://three.example");

    process.env.PUBLIC_APP_ORIGIN = "https://two.example";
    expect(appOrigin()).toBe("https://two.example");

    process.env.APP_ORIGIN = "https://one.example";
    expect(appOrigin()).toBe("https://one.example");
  });

  it("reads PUBLIC_APP_ORIGIN because the Twilio hooks already depend on it", () => {
    // That one is security-critical: the canonical URL rebuilt for signature
    // validation has to match what Twilio signed, character for character.
    // Ignoring a variable a deployment already sets would break signatures.
    delete process.env.APP_ORIGIN;
    delete process.env.APP_URL;
    process.env.PUBLIC_APP_ORIGIN = "https://hooks.example";
    expect(appOrigin()).toBe("https://hooks.example");
  });

  it("strips trailing slashes so joins do not double up", () => {
    process.env.APP_ORIGIN = "https://one.example///";
    expect(appOrigin()).toBe("https://one.example");
    expect(appUrl("/portal")).toBe("https://one.example/portal");
  });

  it("joins a path with or without a leading slash", () => {
    process.env.APP_ORIGIN = "https://one.example";
    expect(appUrl("/auth")).toBe("https://one.example/auth");
    expect(appUrl("auth")).toBe("https://one.example/auth");
    expect(appUrl()).toBe("https://one.example/");
  });

  it("does not throw when process is absent", () => {
    // Called from route components that also render in the browser bundle.
    const saved = globalThis.process;
    try {
      // @ts-expect-error - deliberately simulating a browser global scope
      delete globalThis.process;
      expect(() => appOrigin()).not.toThrow();
    } finally {
      globalThis.process = saved;
    }
  });
});

/**
 * Comments stripped, so a doc block naming a host is not a finding — the
 * assertion is about code, and only code.
 *
 * String-aware, because the naive version was not and it silently disabled this
 * entire check. A regex that deletes from the first double-slash to end of line
 * treats the slashes inside "https://app.houndstack.com" as the start of a
 * comment and eats the rest of the line — so the one string this file exists to
 * forbid was the one string it could never see. A mutation putting the
 * hardcoded host back into portal-links.server.ts passed cleanly, which is the
 * only reason it was found.
 *
 * Template literals are treated as plain strings up to the next unescaped
 * backtick. A `${...}` holding a comment would confuse it; nothing in this
 * codebase does that, and the failure direction would be a false positive,
 * which is loud rather than silent.
 */
function tsCode(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i];
      out += src[i];
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("nothing writes the host by hand", () => {
  const files = tsFiles(SRC).filter((f) => !f.endsWith("/lib/app-origin.ts"));

  it("finds the source files at all", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const file of files) {
    const code = tsCode(readFileSync(file, "utf8"));
    if (!/houndstack\.com/.test(code)) continue;
    const short = file.slice(file.indexOf("src/"));
    it(`${short} does not hardcode an app host`, () => {
      expect(
        code,
        `${short} writes an app host into code. Use appOrigin() or appUrl() from ` +
          `@/lib/app-origin — the bare host 307-redirects, and a hardcoded copy is ` +
          `how twenty-four call sites came to disagree about where this app lives.`,
      ).not.toMatch(/https:\/\/(www\.)?app\.houndstack\.com/);
    });
  }
});

describe("the script and the module agree on the default", () => {
  it("check-app-origin.mjs uses the same fallback as appOrigin()", () => {
    // The script is plain node and cannot import the TS module, so the constant
    // is written twice. Two copies of one fact is the pattern this whole change
    // exists to remove, so the duplication is at least pinned: if someone
    // changes the module's default when the CDN redirect is fixed and forgets
    // the script, the script would keep probing the old host and keep passing.
    const src = readFileSync(
      new URL("../scripts/check-app-origin.mjs", import.meta.url).pathname,
      "utf8",
    );
    const m = /const FALLBACK = "([^"]+)"/.exec(src);
    expect(m, "check-app-origin.mjs no longer declares a FALLBACK constant").toBeTruthy();

    delete process.env.APP_ORIGIN;
    delete process.env.PUBLIC_APP_ORIGIN;
    delete process.env.APP_URL;
    expect(m![1]).toBe(appOrigin());
  });

  it("probes the path the native app actually calls", () => {
    const src = readFileSync(
      new URL("../scripts/check-app-origin.mjs", import.meta.url).pathname,
      "utf8",
    );
    // A preflight against a path that is not under the CORS prefix would answer
    // without CORS headers and the check would fail for the wrong reason.
    expect(src).toMatch(/PROBE_PATH = "\/_serverFn\//);
  });
});
